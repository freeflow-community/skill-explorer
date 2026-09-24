import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { etag } from "hono/etag";
import { config } from "./config.ts";
import { SkillIndex, type Skill } from "./db.ts";
import { createGenerator, type FlowGenerator } from "./flows/generator.ts";
import { FlowService } from "./flows/jobs.ts";
import { ensureLocalIndex, hasUnpushedChanges, pullIndex, remoteIsNewer } from "./indexSync.ts";
import { createLogger, ms } from "./log.ts";
import { CardService } from "./og.ts";
import { installCommands, PAGE_SIZE, PageRenderer, type SearchQuery } from "./pages.ts";
import { PreviewService } from "./preview.ts";
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
  "frame-ancestors 'self'",
].join("; ");

/** Headers every response carries. Flow pages set their own, stricter Content-Security-Policy. */
const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const PAGE_CSP = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

/** How long browsers and the edge may keep each kind of response. */
function cacheControl(path: string): string | null {
  if (path.startsWith("/api/") || path.startsWith("/flows/") || path === "/favorites") return null;
  if (path === "/") return "public, max-age=60, stale-while-revalidate=86400"; // the Discover list is a fresh random pick
  if (/\.(js|css|png|ico|svg)$/.test(path)) return "public, max-age=600, stale-while-revalidate=86400";
  return "public, max-age=300, stale-while-revalidate=86400";
}

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

const BOT_AGENT = /bot|crawler|spider|slurp|headlesschrome|preview|scrapy|python-requests|feedfetcher/i;

/**
 * Whether a request looks like a person browsing, used to decide if opening a skill should
 * queue its safety score. Crawlers walk every skill page and each rating costs a model call,
 * so only browser-shaped agents count.
 */
export function looksLikeVisitor(userAgent: string | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  return ua.startsWith("Mozilla/") && !BOT_AGENT.test(ua);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The card renderer, or null if its fonts are missing so the site falls back to /og.png. */
function cardService(): CardService | null {
  try {
    return new CardService(getStore());
  } catch (error) {
    log.warn("open graph cards are off", { error });
    return null;
  }
}

export function createApp(opts: {
  index: IndexHolder; flows: FlowService; generator: FlowGenerator; stars: StarStore; scores: ScoreService;
  pages?: PageRenderer; previews?: PreviewService; cards?: CardService | null;
}) {
  const { index, flows, stars, scores } = opts;
  const pages = opts.pages ?? new PageRenderer(config.siteUrl);
  const previews = opts.previews ?? new PreviewService();
  // Cards need their fonts on disk. Without them the site still runs, just with no og:image,
  // which is a missing picture rather than a missing page.
  const cards = opts.cards !== undefined ? opts.cards : cardService();
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

  // Security and caching headers on every response. Headers are added after the handler ran,
  // so routes that set their own (the flow pages' CSP, the sitemap's cache) keep theirs.
  app.use("*", async (c, next) => {
    await next();
    const h = c.res.headers;
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!h.has(name)) h.set(name, value);
    if (!c.req.path.startsWith("/flows/")) {
      if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", PAGE_CSP);
      h.set("X-Frame-Options", "SAMEORIGIN");
    }
    const cache = cacheControl(c.req.path);
    if (cache && c.res.status === 200 && !h.has("Cache-Control")) h.set("Cache-Control", cache);
  });
  // Conditional requests for the rendered pages and the sitemap.
  for (const path of ["/", "/search", "/skills", "/about", "/safety", "/prompts", "/sitemap.xml", "/skill/*"]) app.use(path, etag());

  /** One page of search results with the total, for the listing pages and the JSON API. */
  const searchPage = (query: SearchQuery) => {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const q = query.q ?? "";
    return { results: idx().search(q, { ...query, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }), total: idx().searchCount(q, query), page, pageSize: PAGE_SIZE };
  };
  const readQuery = (c: { req: { query(name: string): string | undefined } }): SearchQuery => ({
    q: c.req.query("q") || undefined,
    tag: c.req.query("tag") || undefined,
    collection: c.req.query("collection") || undefined,
    repo: c.req.query("repo") || undefined,
    page: Number(c.req.query("page")) || 1,
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
      discover: withSafety(idx().random(12)),
      tags: idx().tagCounts(),
      collections: idx().collections(),
      total: idx().count(),
      popular: popular(12),
      stars: stars.counts(),
      example: skill && flow ? { slug: skill.slug, name: skill.name, description: skill.description, model: flow.model, builtAt: flow.builtAt } : null,
    });
  });

  app.get("/api/search", (c) => {
    const query = readQuery(c);
    const { results, ...paging } = searchPage(query);
    return c.json({ q: query.q ?? "", tag: query.tag, collection: query.collection, repo: query.repo, ...paging, results: withSafety(results) });
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
    // Opening a skill nobody has rated queues its box score; the panel shows the job and polls it.
    const safety = looksLikeVisitor(c.req.header("user-agent")) ? await scores.autoRate(skill.slug) : await scores.status(skill.slug);
    return c.json({
      skill,
      links: skillLinks(skill),
      flow: await flows.status(skill.slug),
      safety,
      stars: stars.get(skill.slug),
      repoSkillCount: idx().countByRepo(skill.repoUrl),
      related: withSafety(idx().related(skill)),
      install: installCommands(skill),
    });
  });

  /** The skill's own SKILL.md, rendered for the preview modal. */
  app.get("/api/skills/:slug/source", async (c) => {
    const skill = idx().getBySlug(c.req.param("slug"));
    if (!skill) return c.json({ error: "No skill with that name is in the index" }, 404);
    try {
      return c.json(await previews.get(skill, skillLinks(skill).skillMd));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn("could not read a skill's SKILL.md for the preview", { slug: skill.slug, error: message });
      return c.json({ error: `Couldn't read this skill's SKILL.md from GitHub: ${message}` }, 502);
    }
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

  // Pages. Each is the client shell with its title, description and content pre-rendered, so
  // crawlers and link previews see the real thing; the client script then renders over it.
  app.get("/", (c) => c.html(pages.home({ discover: idx().random(12), collections: idx().collections(), total: idx().count() })));

  app.get("/search", (c) => {
    const query = readQuery(c);
    const data = searchPage(query);
    // A tag, collection or repository nobody has is a missing page, not an empty listing to index.
    const missing = data.total === 0 && !query.q && Boolean(query.tag || query.collection || query.repo);
    return c.html(pages.search(query, data), missing ? 404 : 200);
  });

  app.get("/skills", (c) => c.html(pages.allSkills(idx().all())));
  app.get("/about", (c) => c.html(pages.about(idx().count())));
  app.get("/safety", (c) => c.html(pages.safety()));
  app.get("/prompts", (c) => c.html(pages.prompts()));

  app.get("/favorites", (c) => c.html(pages.favorites()));

  app.get("/skill/:slug", async (c) => {
    const slug = c.req.param("slug");
    const skill = idx().getBySlug(slug);
    if (!skill) return c.html(pages.notFound(`"${slug}" isn't in the index. It may have been renamed or removed.`), 404);
    // The full report puts the category levels in the HTML for crawlers; it is cached after the first load.
    const report = await scores.getReport(skill.slug).catch((e) => {
      log.warn("could not load the safety report for the page", { slug: skill.slug, error: e instanceof Error ? e : String(e) });
      return null;
    });
    return c.html(pages.skill(skill, skillLinks(skill), { related: idx().related(skill), safety: scores.summaries()[skill.slug], report }));
  });

  // Open Graph cards. Every skill gets its own, drawn from its name, owner, description, tags
  // and safety grade; the rest of the site shares /og.png. Both are PNG because X, Slack and
  // iMessage all refuse an SVG og:image.
  if (cards) {
    const png = (body: Uint8Array<ArrayBuffer>, cache: string) =>
      new Response(body, { status: 200, headers: { "Content-Type": "image/png", "Cache-Control": cache } });

    app.get("/og.png", (c) => png(cards.site(idx().count()), "public, max-age=3600"));

    app.get("/og/:file", async (c) => {
      const file = c.req.param("file");
      if (!file.endsWith(".png")) return c.notFound();
      const skill = idx().getBySlug(file.slice(0, -4));
      if (!skill) return c.notFound();
      return png(await cards.skill(skill, scores.summaries()[skill.slug]), "public, max-age=86400, stale-while-revalidate=604800");
    });
  }

  app.get("/sitemap.xml", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(pages.sitemap(idx().all(), idx().collections()), 200, { "Content-Type": "application/xml; charset=utf-8" });
  });
  app.get("/robots.txt", (c) => c.text(pages.robots()));

  app.use("/*", serveStatic({ root: "./public" }));
  app.get("*", (c) => c.html(pages.notFound(`There's nothing at ${c.req.path}.`), 404));
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
