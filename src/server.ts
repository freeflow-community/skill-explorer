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
import { createRater } from "./scores/rater.ts";
import { ScoreService } from "./scores/jobs.ts";
import { StarStore } from "./stars.ts";
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

export function createApp(opts: { index: IndexHolder; flows: FlowService; generator: FlowGenerator; stars: StarStore; scores: ScoreService }) {
  const { index, flows, stars, scores } = opts;
  const app = new Hono();
  const idx = () => index.current;
  /** Attach each skill's safety grade summary (when it has been rated). */
  const withSafety = <T extends Skill>(skills: T[]) => {
    const all = scores.summaries();
    return skills.map((s) => (all[s.slug] ? { ...s, safety: all[s.slug] } : s));
  };
  const buildAllowed = (c: { req: { header(name: string): string | undefined } }) =>
    !config.flow.buildToken || tokenMatches(c.req.header("authorization"), config.flow.buildToken);

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
      (c.req.method === "GET" && /^\/api\/skills\/[^/]+\/(flow|safety)$/.test(path)) || !(path.startsWith("/api/") || path.startsWith("/flows/"));
    const fields = { method: c.req.method, path, status: c.res.status, ms: ms(t) };
    if (c.res.status >= 500) log.error("request", fields);
    else if (routine) log.debug("request", fields);
    else log.info("request", fields);
  });

  app.get("/api/config", (c) =>
    c.json({
      flowModel: opts.generator.model,
      flowGenerator: config.flow.generator,
      scoreModel: scores.model,
      scoreProvider: config.score.provider,
      buildRequiresToken: !!config.flow.buildToken,
      storage: config.storage.backend,
      posthog: config.posthog,
    }),
  );

  /** Skills ordered by stars, with their counts attached. */
  const popular = (limit = 12) => {
    const top = stars.top(limit);
    const skills = idx().getBySlugs(top.map((t) => t.slug));
    const counts = new Map(top.map((t) => [t.slug, t.count]));
    return withSafety(skills.map((s) => ({ ...s, stars: counts.get(s.slug) ?? 0 })));
  };

  app.get("/api/home", async (c) => {
    // The example flow is only advertised once it has actually been built.
    const slug = config.exampleFlowSlug;
    const skill = slug ? idx().getBySlug(slug) : null;
    const flow = skill ? await flows.getMeta(skill.slug) : null;
    return c.json({
      recent: withSafety(idx().recent(12)),
      tags: idx().tagCounts(),
      collections: idx().collections(),
      total: idx().count(),
      popular: popular(12),
      stars: stars.counts(),
      example: skill && flow ? { slug: skill.slug, name: skill.name, description: skill.description, model: flow.model, builtAt: flow.builtAt } : null,
    });
  });

  app.get("/api/search", (c) => {
    const q = c.req.query("q") ?? "";
    const tag = c.req.query("tag") || undefined;
    const collection = c.req.query("collection") || undefined;
    const repo = c.req.query("repo") || undefined;
    return c.json({ q, tag, collection, repo, results: withSafety(idx().search(q, { tag, collection, repo })) });
  });

  app.get("/api/tags", (c) => c.json(idx().tagCounts()));

  app.get("/api/popular", (c) => c.json({ results: popular(Number(c.req.query("limit")) || 50) }));

  /** Bulk lookup for the reader's favourites, which live in their browser. */
  app.get("/api/skills", (c) => {
    const slugs = (c.req.query("slugs") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const counts = stars.counts();
    return c.json({ results: withSafety(idx().getBySlugs(slugs).map((s) => ({ ...s, stars: counts[s.slug] ?? 0 }))) });
  });

  /** One visitor's star, counted once per browser (the browser holds the state). */
  app.post("/api/skills/:slug/star", async (c) => {
    const slug = c.req.param("slug");
    if (!idx().getBySlug(slug)) return c.json({ error: "No skill with that name is in the index" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const starred = body?.starred !== false;
    return c.json({ slug, starred, stars: stars.change(slug, starred ? 1 : -1) });
  });

  app.get("/api/skills/:slug", async (c) => {
    const skill = idx().getBySlug(c.req.param("slug"));
    if (!skill) return c.json({ error: "No skill with that name is in the index" }, 404);
    return c.json({
      skill,
      links: skillLinks(skill),
      flow: await flows.status(skill.slug),
      safety: await scores.status(skill.slug),
      stars: stars.get(skill.slug),
      repoSkillCount: idx().countByRepo(skill.repoUrl),
    });
  });

  app.get("/api/skills/:slug/flow", async (c) => {
    const slug = c.req.param("slug");
    if (!idx().getBySlug(slug)) return c.json({ error: "No skill with that name is in the index" }, 404);
    return c.json(await flows.status(slug));
  });

  app.post("/api/skills/:slug/flow", async (c) => {
    if (!buildAllowed(c)) return c.json({ error: "Building flows needs the build token (FLOW_BUILD_TOKEN)" }, 401);
    const slug = c.req.param("slug");
    if (!idx().getBySlug(slug)) return c.json({ error: "No skill with that name is in the index" }, 404);
    const job = flows.start(slug);
    return c.json({ job, flow: await flows.status(slug) }, 202);
  });

  /** Safety box score: the stored report plus any rating job in progress. */
  app.get("/api/skills/:slug/safety", async (c) => {
    const slug = c.req.param("slug");
    if (!idx().getBySlug(slug)) return c.json({ error: "No skill with that name is in the index" }, 404);
    return c.json(await scores.status(slug));
  });

  /** Ratings call a model too, so they share the build token rule. */
  app.post("/api/skills/:slug/safety", async (c) => {
    if (!buildAllowed(c)) return c.json({ error: "Rating skills needs the build token (FLOW_BUILD_TOKEN)" }, 401);
    const slug = c.req.param("slug");
    if (!idx().getBySlug(slug)) return c.json({ error: "No skill with that name is in the index" }, 404);
    const job = scores.start(slug);
    return c.json({ job, safety: await scores.status(slug) }, 202);
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
  const rater = createRater();
  log.info("safety ratings configured", { provider: config.score.provider, model: rater.model, effort: config.score.effort, concurrency: config.score.concurrency });
  const scores = new ScoreService({ store, rater, findSkill: (slug) => index.current.getBySlug(slug) });
  await scores.restore();
  const stars = new StarStore({ store });
  await stars.restore();

  if (config.indexRefreshSeconds > 0) {
    setInterval(() => {
      index.refreshFrom(store).catch((e) => indexLog.error("refresh from storage failed", { error: e }));
    }, config.indexRefreshSeconds * 1000).unref();
  }

  const app = createApp({ index, flows, generator, stars, scores });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => void stars.snapshot().finally(() => process.exit(0)));
  }
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info(`Skills Explorer on http://localhost:${info.port}`, { logLevel: process.env.LOG_LEVEL ?? "info" });
  });
}

if (import.meta.main) await main();
