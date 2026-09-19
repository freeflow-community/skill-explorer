import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { config } from "./config.ts";
import { SkillIndex, type Skill } from "./db.ts";
import { createGenerator, type FlowGenerator } from "./flows/generator.ts";
import { FlowService } from "./flows/jobs.ts";
import { ensureLocalIndex, hasUnpushedChanges, pullIndex, remoteIsNewer } from "./indexSync.ts";
import { createLogger, ms } from "./log.ts";
import { getStore, type BlobStore } from "./storage.ts";

const log = createLogger("server");
const indexLog = createLogger("index");

/** Holds the open (read-only) index and swaps it when a newer copy appears in storage. */
export class IndexHolder {
  private index: SkillIndex;
  private dbPath: string;
  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.index = new SkillIndex(dbPath, { readOnly: true });
  }
  get current(): SkillIndex {
    return this.index;
  }
  reopen(): void {
    this.index.close();
    this.index = new SkillIndex(this.dbPath, { readOnly: true });
  }
  async refreshFrom(store: BlobStore): Promise<boolean> {
    if (!(await remoteIsNewer(store, this.dbPath))) return false;
    if (await hasUnpushedChanges(this.dbPath)) {
      indexLog.warn("storage has a newer index, but the local file has unpushed edits; keeping the local file");
      return false;
    }
    this.index.close();
    try {
      await pullIndex(store, this.dbPath);
    } finally {
      this.index = new SkillIndex(this.dbPath, { readOnly: true });
    }
    indexLog.info("pulled a newer index from storage", { skills: this.index.count() });
    return true;
  }
}

const FLOW_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Lets the detail page size the iframe to the flow's content. */
const HEIGHT_REPORTER = `<script>(function(){function post(){try{parent.postMessage({type:"skills-explorer:flow-height",height:document.documentElement.scrollHeight},"*")}catch(e){}}if(window.ResizeObserver)new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post);post();})();</script>`;

export function injectHeightReporter(html: string): string {
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + HEIGHT_REPORTER + html.slice(i) : html + HEIGHT_REPORTER;
}

function skillLinks(s: Skill) {
  const tree = `${s.repoUrl}/tree/${encodeURIComponent(s.repoRef)}${s.path ? `/${s.path}` : ""}`;
  const skillMd = `${s.repoUrl}/blob/${encodeURIComponent(s.repoRef)}/${s.path ? `${s.path}/` : ""}SKILL.md`;
  return { tree, skillMd };
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function createApp(opts: { index: IndexHolder; flows: FlowService; generator: FlowGenerator }) {
  const { index, flows } = opts;
  const app = new Hono();
  const idx = () => index.current;

  app.onError((err, c) => {
    log.error("request failed", { method: c.req.method, path: c.req.path, error: err });
    return c.json({ error: err.message }, 500);
  });

  // Request log. Status polls and static files are routine, so they only show at LOG_LEVEL=debug.
  app.use("*", async (c, next) => {
    const t = performance.now();
    await next();
    const path = c.req.path;
    const routine =
      (c.req.method === "GET" && /^\/api\/skills\/[^/]+\/flow$/.test(path)) || !(path.startsWith("/api/") || path.startsWith("/flows/"));
    const fields = { method: c.req.method, path, status: c.res.status, ms: ms(t) };
    if (c.res.status >= 500) log.error("request", fields);
    else if (routine) log.debug("request", fields);
    else log.info("request", fields);
  });

  app.get("/api/config", (c) =>
    c.json({
      flowModel: opts.generator.model,
      flowGenerator: config.flow.generator,
      buildRequiresToken: !!config.flow.buildToken,
      storage: config.storage.backend,
    }),
  );

  app.get("/api/home", async (c) => {
    // The example flow is only advertised once it has actually been built.
    const slug = config.exampleFlowSlug;
    const skill = slug ? idx().getBySlug(slug) : null;
    const flow = skill ? await flows.getMeta(skill.slug) : null;
    return c.json({
      recent: idx().recent(12),
      tags: idx().tagCounts(),
      collections: idx().collections(),
      total: idx().count(),
      example: skill && flow ? { slug: skill.slug, name: skill.name, description: skill.description, model: flow.model, builtAt: flow.builtAt } : null,
    });
  });

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const tag = c.req.query("tag") || undefined;
    const collection = c.req.query("collection") || undefined;
    return c.json({ q, tag, collection, results: idx().search(q, { tag, collection }) });
  });

  app.get("/api/tags", (c) => c.json(idx().tagCounts()));

  app.get("/api/skills/:slug", async (c) => {
    const skill = idx().getBySlug(c.req.param("slug"));
    if (!skill) return c.json({ error: "No skill with that name is in the index" }, 404);
    return c.json({ skill, links: skillLinks(skill), flow: await flows.status(skill.slug) });
  });

  app.get("/api/skills/:slug/flow", async (c) => {
    const slug = c.req.param("slug");
    if (!idx().getBySlug(slug)) return c.json({ error: "No skill with that name is in the index" }, 404);
    return c.json(await flows.status(slug));
  });

  app.post("/api/skills/:slug/flow", async (c) => {
    if (config.flow.buildToken && !tokenMatches(c.req.header("authorization"), config.flow.buildToken)) {
      return c.json({ error: "Building flows needs the build token (FLOW_BUILD_TOKEN)" }, 401);
    }
    const slug = c.req.param("slug");
    if (!idx().getBySlug(slug)) return c.json({ error: "No skill with that name is in the index" }, 404);
    const job = flows.start(slug);
    return c.json({ job, flow: await flows.status(slug) }, 202);
  });

  app.get("/flows/:slug", async (c) => {
    const html = await flows.getHtml(c.req.param("slug"));
    if (!html) return c.text("No visual flow has been built for this skill yet.", 404);
    c.header("Content-Security-Policy", FLOW_CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-cache");
    return c.html(injectHeightReporter(html));
  });

  app.use("/*", serveStatic({ root: "./public" }));
  // Client-side routes (#/...) all load the same page.
  app.get("*", serveStatic({ path: "./public/index.html" }));
  return app;
}

async function main() {
  const store = getStore();
  const source = await ensureLocalIndex(store);
  const index = new IndexHolder(config.indexDbPath);
  indexLog.info("opened index", { path: config.indexDbPath, source, skills: index.current.count(), storage: store.name });
  const generator = createGenerator();
  log.info("flow builds configured", {
    provider: config.flow.generator, model: generator.model, effort: config.flow.effort,
    maxTokens: config.flow.maxTokens, concurrency: config.flow.concurrency, buildToken: !!config.flow.buildToken,
  });
  const flows = new FlowService({ store, generator, findSkill: (slug) => index.current.getBySlug(slug) });

  if (config.indexRefreshSeconds > 0) {
    setInterval(() => {
      index.refreshFrom(store).catch((e) => indexLog.error("refresh from storage failed", { error: e }));
    }, config.indexRefreshSeconds * 1000).unref();
  }

  const app = createApp({ index, flows, generator });
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info(`Skills Explorer on http://localhost:${info.port}`, { logLevel: process.env.LOG_LEVEL ?? "info" });
  });
}

if (import.meta.main) await main();
