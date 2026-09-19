import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { config } from "./config.ts";
import { SkillIndex, type Skill } from "./db.ts";
import { createGenerator, type FlowGenerator } from "./flows/generator.ts";
import { FlowService } from "./flows/jobs.ts";
import { ensureLocalIndex, hasUnpushedChanges, pullIndex, remoteIsNewer } from "./indexSync.ts";
import { getStore, type BlobStore } from "./storage.ts";

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
      console.warn("index: storage has a newer index, but the local file has unpushed edits; keeping the local file");
      return false;
    }
    this.index.close();
    try {
      await pullIndex(store, this.dbPath);
    } finally {
      this.index = new SkillIndex(this.dbPath, { readOnly: true });
    }
    console.log("index: pulled a newer index from storage");
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
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  app.get("/api/config", (c) =>
    c.json({
      flowModel: opts.generator.model,
      flowGenerator: config.flow.generator,
      buildRequiresToken: !!config.flow.buildToken,
      storage: config.storage.backend,
    }),
  );

  app.get("/api/home", (c) =>
    c.json({
      recent: idx().recent(12),
      tags: idx().tagCounts(),
      collections: idx().collections(),
      total: idx().count(),
    }),
  );

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
  console.log(`index: ${config.indexDbPath} (${source}); storage: ${store.name}`);
  const index = new IndexHolder(config.indexDbPath);
  const generator = createGenerator();
  const flows = new FlowService({ store, generator, findSkill: (slug) => index.current.getBySlug(slug) });

  if (config.indexRefreshSeconds > 0) {
    setInterval(() => {
      index.refreshFrom(store).catch((e) => console.error("index refresh failed:", e.message));
    }, config.indexRefreshSeconds * 1000).unref();
  }

  const app = createApp({ index, flows, generator });
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Skills Explorer on http://localhost:${info.port}  (flows: ${config.flow.generator}, model ${generator.model})`);
  });
}

if (import.meta.main) await main();
