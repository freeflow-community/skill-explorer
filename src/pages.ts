import { readFileSync } from "node:fs";
import type { Skill } from "./db.ts";
import type { SafetySummary } from "./scores/jobs.ts";
import { CATEGORIES, GRADE_LABELS } from "./scores/scan.ts";

/**
 * Server-rendered pages. Every route returns the same shell as the client app, but with the
 * title, description, canonical URL, structured data and a plain-HTML version of the content
 * filled in, so crawlers and link previews see a real page. The client script then takes over
 * the same DOM on the routes it knows (home, search, skill, favorites); the rest stay as rendered.
 */

export const SITE_NAME = "Skills Explorer";
export const SITE_TAGLINE = "A browsable index of agent skills from GitHub, with a safety box score and a visual flow for each one.";
export const GITHUB_URL = "https://github.com/freeflow-community/skill-explorer";
export const SKILLS_CLI_URL = "https://github.com/vercel-labs/skills";
/** Listing pages show this many skills per page; the rest are reachable through numbered page links. */
export const PAGE_SIZE = 100;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const enc = encodeURIComponent;

/**
 * A meta description that reads as whole sentences: the text if it fits, else as many leading
 * sentences as fit, else a cut at the last clause boundary before `max`, closed with a full stop.
 */
export function summary(text: string, max = 160): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let sentences = "";
  let end = 0;
  for (const m of t.matchAll(/[^.!?]+[.!?]+(?=\s|$)/g)) {
    // A match that doesn't start where the last one ended means a dot that isn't a sentence
    // end (p5.js, Fly.io, .png) made the regex skip over text. Keeping it would drop the
    // opening words, so fall through to trimming instead.
    if (t.slice(end, m.index).trim()) break;
    const next = `${sentences}${sentences ? " " : ""}${m[0].trim()}`;
    if (next.length > max) break;
    sentences = next;
    end = m.index + m[0].length;
  }
  if (sentences.length >= 20) return sentences;
  const head = t.slice(0, max);
  const clause = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "));
  const word = head.lastIndexOf(" ");
  const at = clause > 40 ? clause : word > 40 ? word : max;
  const cut = head.slice(0, at).replace(/[,;:\s]+$/, "");
  // The cut can land just after a sentence end, which already has its full stop.
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

export interface PageMeta {
  title: string;
  description: string;
  /** Path plus query, as the canonical URL of the page. */
  path: string;
  /** Keep the page out of search results (search queries, per-visitor pages, errors). */
  noindex?: boolean;
  /** Schema.org objects, emitted as one JSON-LD graph. */
  jsonLd?: object[];
}

export interface SearchQuery {
  q?: string;
  tag?: string;
  collection?: string;
  repo?: string;
  page?: number;
}

export interface SearchPage {
  results: Skill[];
  /** Matches across every page. */
  total: number;
  page: number;
  pageSize: number;
}

export interface SkillExtras {
  related: Skill[];
  /** The stored grade, when the skill has been rated. */
  safety?: SafetySummary;
}

const repoLabel = (url: string) => url.replace("https://github.com/", "");
const repoOwner = (url: string) => repoLabel(url).split("/")[0] ?? "";
const repoName = (url: string) => repoLabel(url).split("/")[1] ?? repoLabel(url);
const shellQuote = (s: string) => (/^[\w.@/+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const listNames = (skills: Skill[], n = 4) => `${skills.slice(0, n).map((s) => s.name).join(", ")}${skills.length > n ? " and more" : ""}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Shell commands that put the skill where agents look for it. */
export function installCommands(s: Skill): { cli: string; manual: string } {
  const branch = s.repoRef && !["main", "master"].includes(s.repoRef) ? ` --branch ${shellQuote(s.repoRef)}` : "";
  const dir = repoName(s.repoUrl);
  const from = s.path ? `${dir}/${s.path}` : dir;
  return {
    cli: `npx skills add ${repoLabel(s.repoUrl)} --skill ${shellQuote(s.name)}`,
    manual: `git clone --depth 1${branch} ${s.repoUrl}\ncp -r ${shellQuote(from)} ~/.claude/skills/${shellQuote(s.name)}`,
  };
}

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
      ...(meta.jsonLd?.length ? [this.jsonLd(meta.jsonLd)] : []),
    ].join("\n  ");
    return this.template.replace(/<title>[^<]*<\/title>\s*<!--page:head-->/, head).replace("<!--page:body-->", body);
  }

  /* ---------------- structured data ---------------- */

  private jsonLd(objects: object[]): string {
    // "</" can't appear inside the script element, so the JSON escapes every "<".
    const json = JSON.stringify({ "@context": "https://schema.org", "@graph": objects }).replace(/</g, "\\u003c");
    return `<script type="application/ld+json">${json}</script>`;
  }

  private orgId() {
    return this.url("/#organization");
  }

  private organization() {
    return {
      "@type": "Organization",
      "@id": this.orgId(),
      name: SITE_NAME,
      url: this.url("/"),
      logo: this.url("/apple-touch-icon.png"),
      sameAs: [GITHUB_URL],
    };
  }

  private website() {
    return {
      "@type": "WebSite",
      "@id": this.url("/#website"),
      name: SITE_NAME,
      url: this.url("/"),
      description: SITE_TAGLINE,
      publisher: { "@id": this.orgId() },
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: this.url("/search?q={search_term_string}") },
        "query-input": "required name=search_term_string",
      },
    };
  }

  private breadcrumbs(trail: { name: string; path: string }[]) {
    return {
      "@type": "BreadcrumbList",
      itemListElement: trail.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: this.url(c.path) })),
    };
  }

  private skillSchema(s: Skill) {
    return {
      "@type": "SoftwareSourceCode",
      "@id": this.url(`/skill/${enc(s.slug)}#skill`),
      name: s.name,
      description: s.description || undefined,
      url: this.url(`/skill/${enc(s.slug)}`),
      codeRepository: s.repoUrl,
      keywords: s.tags.length ? s.tags : undefined,
      dateModified: s.updatedAt.slice(0, 10),
      isPartOf: { "@id": this.url("/#website") },
      publisher: { "@id": this.orgId() },
    };
  }

  private collectionSchema(name: string, path: string, description: string, skills: Skill[], total: number) {
    return {
      "@type": "CollectionPage",
      name,
      url: this.url(path),
      description,
      isPartOf: { "@id": this.url("/#website") },
      mainEntity: {
        "@type": "ItemList",
        numberOfItems: total,
        itemListElement: skills.map((s, i) => ({ "@type": "ListItem", position: i + 1, name: s.name, url: this.url(`/skill/${enc(s.slug)}`) })),
      },
    };
  }

  /* ---------------- shared fragments ---------------- */

  private skillList(skills: Skill[]): string {
    if (!skills.length) return `<p class="muted">No skills match.</p>`;
    return `<ul class="ssr-list">${skills
      .map((s) => `<li><a href="/skill/${enc(s.slug)}">${esc(s.name)}</a>${s.description ? ` — ${esc(summary(s.description))}` : ""}</li>`)
      .join("")}</ul>`;
  }

  private crumbs(trail: { name: string; path: string }[], last: string): string {
    return `<nav class="crumbs" aria-label="Breadcrumb">${trail.map((c) => `<a href="${esc(c.path)}">${esc(c.name)}</a><span>/</span>`).join("")}<span>${esc(last)}</span></nav>`;
  }

  private searchPath(query: SearchQuery, page = query.page ?? 1): string {
    const params = new URLSearchParams();
    for (const k of ["q", "tag", "collection", "repo"] as const) if (query[k]) params.set(k, query[k]!);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return `/search${qs ? `?${qs}` : ""}`;
  }

  /** Previous / next links for a listing, as real anchors so crawlers can walk every page. */
  private pager(query: SearchQuery, page: number, pages: number): string {
    if (pages <= 1) return "";
    const prev = page > 1 ? `<a rel="prev" href="${esc(this.searchPath(query, page - 1))}">Previous</a>` : `<span class="muted">Previous</span>`;
    const next = page < pages ? `<a rel="next" href="${esc(this.searchPath(query, page + 1))}">Next</a>` : `<span class="muted">Next</span>`;
    const numbers = Array.from({ length: pages }, (_, i) => i + 1)
      .map((n) => (n === page ? `<strong aria-current="page">${n}</strong>` : `<a href="${esc(this.searchPath(query, n))}">${n}</a>`))
      .join(" ");
    return `<nav class="pager" aria-label="Pages">${prev} <span class="pager-pages">Page ${page} of ${pages}: ${numbers}</span> ${next}</nav>`;
  }

  /* ---------------- pages ---------------- */

  home(data: { discover: Skill[]; collections: { collection: string; count: number }[]; total: number }): string {
    const title = "Agent Skills Directory for Claude Code & Codex";
    const description = `Browse ${data.total} agent skills (SKILL.md) from GitHub for Claude Code, Codex and other AI coding agents. Search by tag, collection or repository; each skill page has install steps and can show a safety box score.`;
    const body = `
      <h1>${esc(title)}</h1>
      <p>${esc(SITE_TAGLINE)} ${data.total} skills indexed. <a href="/about">What is an agent skill?</a> · <a href="/safety">How safety box scores work</a></p>
      <h2>Discover skills</h2>
      ${this.skillList(data.discover)}
      ${data.collections.length ? `<h2>Collections</h2><ul class="ssr-list">${data.collections.map((c) => `<li><a href="/search?collection=${enc(c.collection)}">${esc(c.collection)}</a> (${c.count})</li>`).join("")}</ul>` : ""}
      <p><a href="/search">Browse all skills</a> · <a href="/skills">All skills A to Z</a></p>`;
    return this.render({ title, description, path: "/", jsonLd: [this.website(), this.organization()] }, body);
  }

  skill(s: Skill, links: { tree: string; skillMd: string }, extras: SkillExtras = { related: [] }): string {
    const owner = repoOwner(s.repoUrl);
    const repo = repoLabel(s.repoUrl);
    const path = `/skill/${enc(s.slug)}`;
    const title = `${s.name}: Claude Code skill by ${owner}`;
    const lead = s.description ? summary(s.description, 100) : `${s.name} is an agent skill.`;
    const description = `${lead} From ${repo} on GitHub, with install steps for Claude Code and Codex.`;
    const install = installCommands(s);
    const trail = [{ name: "Skills", path: "/" }, ...(s.collection ? [{ name: s.collection, path: `/search?collection=${enc(s.collection)}` }] : [])];
    const safety = extras.safety
      ? `<p>Grade <strong>${esc(extras.safety.grade)}</strong>, ${esc(extras.safety.label.toLowerCase())}: ${extras.safety.score} of 100 risk points, rated ${esc(extras.safety.ratedAt.slice(0, 10))}. The grade rates what the skill and its scripts can reach on the machine of whoever installs it, across eight categories from shell execution to secrets access. <a href="/safety">How the score works</a>.</p>`
      : `<p>Not rated yet. A safety box score grades what a skill and its scripts can reach on the machine of whoever installs it, across eight categories from shell execution to secrets access. Anyone can request one from this page; it is saved for everyone. <a href="/safety">How the score works</a>.</p>`;
    const body = `
      ${this.crumbs(trail, s.name)}
      <h1>${esc(s.name)}</h1>
      <p>An agent skill by ${esc(owner)}, from <a href="${esc(s.repoUrl)}" rel="noopener">${esc(repo)}</a>${s.tags.length ? `. Tags: ${s.tags.map((t) => `<a href="/search?tag=${enc(t)}">${esc(t)}</a>`).join(", ")}` : ""}.</p>
      <h2 id="what">What it does</h2>
      <p>${s.description ? esc(s.description) : `<span class="muted">Its SKILL.md has no description.</span>`}</p>
      <h2 id="install">Install</h2>
      <p>With the <a href="${SKILLS_CLI_URL}" rel="noopener">skills</a> CLI, which installs into Claude Code, Codex, Cursor and other agents:</p>
      <pre><code>${esc(install.cli)}</code></pre>
      <p>Or copy the skill folder into Claude Code's skills directory by hand (<code>~/.claude/skills</code> for every project, or <code>.claude/skills</code> inside one):</p>
      <pre><code>${esc(install.manual)}</code></pre>
      <h2 id="safety">Safety box score</h2>
      ${safety}
      <h2 id="source">Source</h2>
      <dl>
        <dt>Repository</dt><dd><a href="${esc(s.repoUrl)}" rel="noopener">${esc(repo)}</a> (<a href="/search?repo=${enc(s.repoUrl)}">all skills from this repository</a>)</dd>
        <dt>Path</dt><dd><a href="${esc(links.skillMd)}" rel="noopener">${esc(s.path ? `${s.path}/SKILL.md` : "SKILL.md")}</a></dd>
        <dt>Branch</dt><dd>${esc(s.repoRef)}</dd>
        ${s.collection ? `<dt>Collection</dt><dd><a href="/search?collection=${enc(s.collection)}">${esc(s.collection)}</a></dd>` : ""}
        <dt>Updated</dt><dd>${esc(s.updatedAt.slice(0, 10))}</dd>
      </dl>
      ${extras.related.length ? `<h2 id="related">Related skills</h2>${this.skillList(extras.related)}` : ""}`;
    return this.render({ title, description, path, jsonLd: [this.breadcrumbs([...trail, { name: s.name, path }]), this.skillSchema(s)] }, body);
  }

  search(query: SearchQuery, data: SearchPage): string {
    const { results, total } = data;
    const page = Math.max(1, data.page);
    const pages = Math.max(1, Math.ceil(total / data.pageSize));
    const path = this.searchPath(query, page);
    const pageNote = page > 1 ? `, page ${page} of ${pages}` : "";
    const repos = [...new Set(results.map((s) => repoLabel(s.repoUrl)))];
    let title: string;
    let description: string;
    let crumb: string;
    if (query.q) {
      title = `Search: ${query.q}`;
      description = `${plural(total, "skill")} matching “${query.q}”. ${SITE_TAGLINE}`;
      crumb = "Search";
    } else if (query.collection) {
      title = `${query.collection} collection: ${plural(total, "agent skill")}${pageNote}`;
      description = `${plural(total, "agent skill")} in the ${query.collection} collection${repos.length === 1 ? ` from ${repos[0]}` : ""}: ${listNames(results)}. Source, install steps and a safety box score for each.`;
      crumb = `${query.collection} collection`;
    } else if (query.tag) {
      title = `Skills tagged ${query.tag}: ${plural(total, "agent skill")} for Claude Code${pageNote}`;
      description = `${plural(total, "agent skill")} tagged ${query.tag}: ${listNames(results)}. Each with its GitHub source, install steps and a safety box score.`;
      crumb = `Tagged ${query.tag}`;
    } else if (query.repo) {
      title = `Skills from ${repoLabel(query.repo)}: ${plural(total, "agent skill")}${pageNote}`;
      description = `${plural(total, "agent skill")} from the ${repoLabel(query.repo)} repository on GitHub: ${listNames(results)}. Install steps and a safety box score for each.`;
      crumb = repoLabel(query.repo);
    } else {
      title = `All ${total} agent skills, A to Z${pageNote}`;
      description = `Every agent skill in the index, alphabetically${pages > 1 ? ` (page ${page} of ${pages})` : ""}: ${listNames(results)}. Filter by tag, collection or repository.`;
      crumb = "All skills";
    }
    const trail = [{ name: "Skills", path: "/" }];
    const body = `${this.crumbs(trail, crumb)}<h1>${esc(title)}</h1>${this.skillList(results)}${this.pager(query, page, pages)}`;
    // Free-text searches are endless; only the tag, collection, repository and full listings are worth indexing.
    const jsonLd = query.q ? undefined : [this.breadcrumbs([...trail, { name: crumb, path }]), this.collectionSchema(title, path, description, results, total)];
    return this.render({ title, description, path, noindex: Boolean(query.q) || total === 0, jsonLd }, body);
  }

  /** Every skill on one page, grouped by first letter, so each one is a link away from the home page. */
  allSkills(skills: Skill[]): string {
    const groups = new Map<string, Skill[]>();
    for (const s of skills) {
      const letter = /^[a-z]/i.test(s.name) ? s.name[0]!.toUpperCase() : "#";
      groups.set(letter, [...(groups.get(letter) ?? []), s]);
    }
    const letters = [...groups.keys()].sort((a, b) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)));
    const title = `All ${skills.length} agent skills, A to Z`;
    const description = `Every agent skill in the index on one page, from A to Z: ${listNames(skills)}. Each links to its source, install steps and safety box score.`;
    const body = `
      ${this.crumbs([{ name: "Skills", path: "/" }], "A to Z")}
      <h1>${esc(title)}</h1>
      <p>Every skill in the index, by name. <a href="/search">Browse with descriptions</a> or filter by tag, collection or repository from the <a href="/">home page</a>.</p>
      <nav class="az-nav" aria-label="Letters">${letters.map((l) => `<a href="#${l === "#" ? "other" : l}">${l}</a>`).join(" ")}</nav>
      ${letters
        .map((l) => `<h2 id="${l === "#" ? "other" : l}">${l === "#" ? "Other" : l}</h2><ul class="az-list">${groups.get(l)!.map((s) => `<li><a href="/skill/${enc(s.slug)}" title="${esc(summary(s.description, 120))}">${esc(s.name)}</a></li>`).join("")}</ul>`)
        .join("")}`;
    return this.render({ title, description, path: "/skills", jsonLd: [this.breadcrumbs([{ name: "Skills", path: "/" }, { name: "A to Z", path: "/skills" }])] }, body);
  }

  about(total: number): string {
    const title = "About Skills Explorer: what an agent skill is";
    const description = `What an agent skill (SKILL.md) is, how ${total} of them from GitHub ended up in this index, what each skill page shows, and how to suggest one.`;
    const body = `
      ${this.crumbs([{ name: "Skills", path: "/" }], "About")}
      <article class="prose">
      <h1>About Skills Explorer</h1>
      <p>Skills Explorer is a browsable index of ${total} agent skills published on GitHub. Each skill has its own page with the source, an install command, a safety box score that anyone can request, and a visual flow that walks through what the skill does.</p>
      <h2 id="what-is-a-skill">What is an agent skill?</h2>
      <p>An agent skill is a folder with a <code>SKILL.md</code> file that teaches an AI coding agent how to do one job: review a pull request, build a slide deck, run a security scan, plan a trip. The file starts with a name and a one-line description, followed by instructions the agent follows when the job comes up. A skill can ship scripts and reference files next to the <code>SKILL.md</code>, and the agent loads the whole folder only when it is needed.</p>
      <p>Skills use the open Agent Skills format, so one folder works across agents that support it, including Claude Code, Codex and Cursor. Installing a skill means copying its folder into the directory the agent reads skills from, which the <a href="${SKILLS_CLI_URL}" rel="noopener">skills</a> CLI does in one command.</p>
      <h2 id="how-skills-get-here">How skills get into the index</h2>
      <p>Skills are registered from public GitHub repositories. The index records each skill's name, description, repository, path and branch as they appear in its <code>SKILL.md</code>, and tags it by topic. Descriptions are the authors' own words. Every skill page links to the file on GitHub, so you can read exactly what an agent would load before you install it.</p>
      <p>To suggest a repository, open an issue on <a href="${GITHUB_URL}/issues" rel="noopener">GitHub</a> with a link to it. Anything with a <code>SKILL.md</code> can be indexed.</p>
      <h2 id="what-a-page-shows">What each skill page shows</h2>
      <ul>
        <li><strong>What it does</strong>: the description from the skill's <code>SKILL.md</code>, with its tags and collection.</li>
        <li><strong>Install</strong>: the <code>skills</code> CLI command for the skill, and the manual copy for Claude Code.</li>
        <li><strong>Safety box score</strong>: a grade from A to F for what the skill and its scripts can reach, built from the skill's own files. Anyone can request it, and the result is saved for everyone. <a href="/safety">How the score works</a>.</li>
        <li><strong>Visual flow</strong>: an interactive walkthrough of the skill's stages, commands and checks, generated from its files on request.</li>
        <li><strong>Source</strong>: the repository, path and branch on GitHub, and the other skills from the same repository.</li>
      </ul>
      <h2 id="who">Who runs it</h2>
      <p>Skills Explorer is an open-source project. The code, the issue tracker and the way to reach the maintainers are all at <a href="${GITHUB_URL}" rel="noopener">${esc(repoLabel(GITHUB_URL))}</a> on GitHub. Skills belong to their authors and stay in their repositories; this site indexes and describes them.</p>
      </article>`;
    return this.render({ title, description, path: "/about", jsonLd: [this.breadcrumbs([{ name: "Skills", path: "/" }, { name: "About", path: "/about" }])] }, body);
  }

  /** The safety box score methodology, kept in step with the categories and grade bands in code. */
  safety(): string {
    const title = "Safety box score: how skills are rated";
    const description = "How the safety box score grades an agent skill from A to F: eight categories rated 0 to 3 from the skill's own files, weighted into risk points, with caps for any high-level category.";
    const rows = CATEGORIES.map((c) => `<tr><th scope="row">${esc(c.name)}</th><td>${esc(c.question)}</td><td>${c.weight === 1 ? "1" : "1.5"}</td></tr>`).join("");
    const bands = [["A", "0 to 10"], ["B", "11 to 25"], ["C", "26 to 45"], ["D", "46 to 65"], ["F", "66 to 100"]] as const;
    const body = `
      ${this.crumbs([{ name: "Skills", path: "/" }], "Safety box score")}
      <article class="prose">
      <h1>${esc(title)}</h1>
      <p>A safety box score rates the <strong>reach</strong> of a skill, not its intent: what an agent could do to the machine, accounts and data of someone who installs it. It is a grade from A (minimal risk) to F (high risk), with a 0 to 100 risk-point total and a level for each of eight categories. The score is built from the skill's own files and is a snapshot of them at rating time.</p>
      <h2 id="steps">How a rating is made</h2>
      <ol>
        <li><strong>Inventory and scan.</strong> Every file in the skill folder is listed. The text files (the <code>SKILL.md</code>, docs, config, and scripts in shell, Python, JavaScript, TypeScript, PowerShell and other languages) are read and matched line by line against about sixty risk signals, such as piping a download into a shell, <code>sudo</code>, reading <code>~/.aws</code>, <code>rm -rf</code>, instructions to skip confirmations, and encoded blobs. Each signal has a category and a severity. Binaries that cannot be read count against transparency.</li>
        <li><strong>Model review.</strong> The files, the inventory and the scan hits go to a language model with fixed instructions. It rates each category from 0 to 3 with a one-sentence rationale, lists findings with the file and the quoted evidence, and writes a short “before you install” checklist. The scan hits are hints the model must confirm or dismiss. Skill files are treated as evidence, never as instructions: a skill that tells the agent to ignore its rules gets that noted as a finding.</li>
        <li><strong>Grade.</strong> The grade is computed in code, never by the model. Category levels are weighted and summed, the sum becomes 0 to 100 risk points, and the points map to a grade. Any category at level 3 caps the grade at C; two or more cap it at D.</li>
      </ol>
      <h2 id="categories">The eight categories</h2>
      <p>Each category is rated 0 (none), 1 (low), 2 (moderate) or 3 (high). The weight is how much the category counts toward the risk points.</p>
      <table>
        <thead><tr><th scope="col">Category</th><th scope="col">The question it answers</th><th scope="col">Weight</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <h2 id="grades">Grade bands</h2>
      <table>
        <thead><tr><th scope="col">Grade</th><th scope="col">Label</th><th scope="col">Risk points</th></tr></thead>
        <tbody>${bands.map(([g, pts]) => `<tr><th scope="row">${g}</th><td>${esc(GRADE_LABELS[g])}</td><td>${pts}</td></tr>`).join("")}</tbody>
      </table>
      <h2 id="limits">What the score is not</h2>
      <p>It is an automated reading of the files at the moment of rating, not a security audit, and it cannot see what a skill fetches at run time. A skill that changes in its repository keeps its old score until someone re-rates it; every skill page has a re-rate button. Read the findings and the “before you install” checklist, not just the letter, and treat a grade as one input to your own judgement.</p>
      <p><a href="/search">Browse skills</a> or read <a href="/about">what an agent skill is</a>.</p>
      </article>`;
    return this.render({ title, description, path: "/safety", jsonLd: [this.breadcrumbs([{ name: "Skills", path: "/" }, { name: "Safety box score", path: "/safety" }])] }, body);
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
    const pages = Math.max(1, Math.ceil(skills.length / PAGE_SIZE));
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
      entry("/", newest),
      entry("/skills", newest),
      entry("/about"),
      entry("/safety"),
      ...Array.from({ length: pages }, (_, i) => entry(this.searchPath({}, i + 1), newest)),
      ...collections.map((c) => entry(`/search?collection=${enc(c.collection)}`)),
      ...skills.map((s) => entry(`/skill/${enc(s.slug)}`, s.updatedAt)),
    ].join("\n")}\n</urlset>\n`;
  }

  robots(): string {
    return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /flows/\nDisallow: /favorites\nSitemap: ${this.url("/sitemap.xml")}\n`;
  }
}
