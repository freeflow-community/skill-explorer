import { readFileSync } from "node:fs";
import type { Skill } from "./db.ts";

/**
 * Server-rendered pages. Every route returns the same shell as the client app, but with the
 * title, description, canonical URL and a plain-HTML version of the content filled in, so
 * crawlers and link previews see a real page. The client script then takes over the same DOM.
 */

export const SITE_NAME = "Skills Explorer";
export const SITE_TAGLINE = "A browsable index of agent skills from GitHub, with a safety box score and a visual flow for each one.";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const enc = encodeURIComponent;

/** A meta description: the first sentence, or a word-boundary cut near 160 characters. */
export function summary(text: string, max = 160): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(" ", max);
  return `${t.slice(0, cut > 40 ? cut : max).replace(/[,;:\s]+$/, "")}…`;
}

export interface PageMeta {
  title: string;
  description: string;
  /** Path plus query, as the canonical URL of the page. */
  path: string;
  /** Keep the page out of search results (search queries, per-visitor pages, errors). */
  noindex?: boolean;
}

export interface SearchQuery {
  q?: string;
  tag?: string;
  collection?: string;
  repo?: string;
}

const repoLabel = (url: string) => url.replace("https://github.com/", "");

export class PageRenderer {
  private template: string;
  readonly siteUrl: string;

  constructor(siteUrl: string, templatePath = "./public/index.html") {
    this.siteUrl = siteUrl.replace(/\/+$/, "");
    this.template = readFileSync(templatePath, "utf8");
    for (const marker of ["<!--page:head-->", "<!--page:body-->"]) {
      if (!this.template.includes(marker)) throw new Error(`${templatePath} is missing the ${marker} marker`);
    }
  }

  url(path: string): string {
    return `${this.siteUrl}${path}`;
  }

  /** The shell with the head and main content filled in. */
  render(meta: PageMeta, body: string): string {
    const title = meta.title === SITE_NAME ? SITE_NAME : `${meta.title} · ${SITE_NAME}`;
    const head = [
      `<title>${esc(title)}</title>`,
      `<meta name="description" content="${esc(meta.description)}">`,
      meta.noindex ? `<meta name="robots" content="noindex">` : `<link rel="canonical" href="${esc(this.url(meta.path))}">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="${SITE_NAME}">`,
      `<meta property="og:title" content="${esc(meta.title)}">`,
      `<meta property="og:description" content="${esc(meta.description)}">`,
      `<meta property="og:url" content="${esc(this.url(meta.path))}">`,
      `<meta property="og:image" content="${esc(this.url("/og.png"))}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    ].join("\n  ");
    return this.template.replace(/<title>[^<]*<\/title>\s*<!--page:head-->/, head).replace("<!--page:body-->", body);
  }

  private skillList(skills: Skill[]): string {
    if (!skills.length) return `<p class="muted">No skills match.</p>`;
    return `<ul class="ssr-list">${skills
      .map((s) => `<li><a href="/skill/${enc(s.slug)}">${esc(s.name)}</a>${s.description ? ` — ${esc(summary(s.description))}` : ""}</li>`)
      .join("")}</ul>`;
  }

  home(data: { discover: Skill[]; collections: { collection: string; count: number }[]; total: number }): string {
    const body = `
      <h1>${SITE_NAME}</h1>
      <p>${esc(SITE_TAGLINE)} ${data.total} skills indexed.</p>
      <h2>Discover skills</h2>
      ${this.skillList(data.discover)}
      ${data.collections.length ? `<h2>Collections</h2><ul class="ssr-list">${data.collections.map((c) => `<li><a href="/search?collection=${enc(c.collection)}">${esc(c.collection)}</a> (${c.count})</li>`).join("")}</ul>` : ""}
      <p><a href="/search">Browse all skills</a></p>`;
    return this.render({ title: SITE_NAME, description: SITE_TAGLINE, path: "/" }, body);
  }

  skill(s: Skill, links: { tree: string; skillMd: string }): string {
    const description = s.description ? summary(s.description) : `${s.name}, an agent skill from ${repoLabel(s.repoUrl)}.`;
    const body = `
      <nav aria-label="Breadcrumb"><a href="/">Index</a>${s.collection ? ` / <a href="/search?collection=${enc(s.collection)}">${esc(s.collection)}</a>` : ""} / ${esc(s.name)}</nav>
      <h1>${esc(s.name)}</h1>
      ${s.description ? `<p>${esc(s.description)}</p>` : ""}
      ${s.tags.length ? `<p>Tags: ${s.tags.map((t) => `<a href="/search?tag=${enc(t)}">${esc(t)}</a>`).join(", ")}</p>` : ""}
      <dl>
        <dt>Repository</dt><dd><a href="${esc(s.repoUrl)}" rel="noopener">${esc(repoLabel(s.repoUrl))}</a> (<a href="/search?repo=${enc(s.repoUrl)}">all skills from this repository</a>)</dd>
        <dt>Path</dt><dd><a href="${esc(links.skillMd)}" rel="noopener">${esc(s.path ? `${s.path}/SKILL.md` : "SKILL.md")}</a></dd>
        <dt>Branch</dt><dd>${esc(s.repoRef)}</dd>
        ${s.collection ? `<dt>Collection</dt><dd><a href="/search?collection=${enc(s.collection)}">${esc(s.collection)}</a></dd>` : ""}
        <dt>Updated</dt><dd>${esc(s.updatedAt.slice(0, 10))}</dd>
      </dl>`;
    return this.render({ title: s.name, description, path: `/skill/${enc(s.slug)}` }, body);
  }

  search(query: SearchQuery, results: Skill[]): string {
    const params = new URLSearchParams();
    for (const k of ["q", "tag", "collection", "repo"] as const) if (query[k]) params.set(k, query[k]!);
    const qs = params.toString();
    const title = query.q
      ? `Search: ${query.q}`
      : query.tag
        ? `Skills tagged ${query.tag}`
        : query.collection
          ? `${query.collection} collection`
          : query.repo
            ? `Skills from ${repoLabel(query.repo)}`
            : "All skills";
    const n = results.length;
    const description = `${n} skill${n === 1 ? "" : "s"}. ${SITE_TAGLINE}`;
    const body = `<h1>${esc(title)}</h1>${this.skillList(results)}`;
    // Free-text searches are endless; only the tag, collection, repository and full listings are worth indexing.
    return this.render({ title, description, path: `/search${qs ? `?${qs}` : ""}`, noindex: Boolean(query.q) }, body);
  }

  favorites(): string {
    return this.render(
      { title: "Your starred skills", description: "Skills you have starred in this browser.", path: "/favorites", noindex: true },
      `<h1>Your starred skills</h1><p class="muted">Stars are kept in your browser.</p>`,
    );
  }

  notFound(what: string): string {
    return this.render(
      { title: "Not found", description: SITE_TAGLINE, path: "/", noindex: true },
      `<div class="empty"><h1>Not found</h1><p class="muted">${esc(what)}</p><a class="btn" href="/">Back to the index</a></div>`,
    );
  }

  sitemap(skills: Skill[], collections: { collection: string }[]): string {
    const entry = (path: string, lastmod?: string) =>
      `<url><loc>${esc(this.url(path))}</loc>${lastmod ? `<lastmod>${esc(lastmod.slice(0, 10))}</lastmod>` : ""}</url>`;
    const newest = skills.map((s) => s.updatedAt).sort().at(-1);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
      entry("/", newest),
      entry("/search", newest),
      ...collections.map((c) => entry(`/search?collection=${enc(c.collection)}`)),
      ...skills.map((s) => entry(`/skill/${enc(s.slug)}`, s.updatedAt)),
    ].join("\n")}\n</urlset>\n`;
  }

  robots(): string {
    return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /flows/\nDisallow: /favorites\nSitemap: ${this.url("/sitemap.xml")}\n`;
  }
}
