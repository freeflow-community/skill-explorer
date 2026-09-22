// Skills Explorer front end: a small client-routed app over the JSON API. The server pre-renders
// each page for crawlers; this script draws the interactive version over it and handles navigation.
import { initializePosthog } from "./posthog.js";

const app = document.getElementById("app");
const qInput = document.getElementById("q");
let routeId = 0; // bumps on every navigation so stale polls and timers stop
let pendingAnchor = null; // element to scroll to after the route renders
let anchorRetry = 0; // the flow iframe loads late, so a requested anchor is re-applied when it resizes
let serverConfig = { flowModel: "", scoreModel: "", buildRequiresToken: false };

/** Push an event to Google Tag Manager's dataLayer (a no-op if GTM is blocked). */
function track(event, fields = {}) {
  try {
    (window.dataLayer = window.dataLayer || []).push({ event, ...fields });
  } catch {
    // Analytics must never break the page.
  }
}

/** Capture product actions when the optional browser SDK has initialized. */
function capture(event, properties = {}) {
  try {
    window.posthog?.capture(event, properties);
  } catch {
    // Analytics must never break the page.
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const enc = encodeURIComponent;

function storage(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

function relTime(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [u, n] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v > 1 ? "s" : ""} ago`; }
  return "just now";
}
const fullDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/* ---------------- stars (this browser's favourites) ---------------- */

const STAR_KEY = "se-stars";
let starred = new Set();
try {
  starred = new Set(JSON.parse(storage(STAR_KEY) || "[]"));
} catch {
  starred = new Set();
}
const isStarred = (slug) => starred.has(slug);

/** Toggle a star locally, then tell the server so the Popular list can count it. */
async function toggleStar(slug) {
  const now = !isStarred(slug);
  if (now) starred.add(slug);
  else starred.delete(slug);
  try {
    storage(STAR_KEY, JSON.stringify([...starred]));
  } catch {
    // A viewer with storage blocked still gets the visual toggle for this page view.
  }
  capture(now ? "skill_starred" : "skill_unstarred", { skill: slug });
  track(now ? "skill_starred" : "skill_unstarred", { skill: slug });
  try {
    const d = await api(`/api/skills/${enc(slug)}/star`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: now }),
    });
    return d.stars;
  } catch {
    return null; // the local star stands even if the count could not be recorded
  }
}

function starButton(slug, count) {
  const on = isStarred(slug);
  return `<button type="button" class="star ${on ? "on" : ""}" data-star="${esc(slug)}"
    aria-pressed="${on}" aria-label="${on ? "Remove" : "Add"} ${esc(slug)} ${on ? "from" : "to"} your favourites" title="${on ? "Starred" : "Star this skill"}">
    <span class="star-icon" aria-hidden="true">${on ? "★" : "☆"}</span><span class="star-count">${count ? count : ""}</span></button>`;
}

/** Safety grade tile for the box score and its modal. */
function gradeBadge(safety) {
  if (!safety) return "";
  const text = `Safety ${safety.grade}: ${safety.label}, ${safety.score}/100 risk points`;
  return `<span class="grade grade-${esc(safety.grade)}" title="${esc(text)}" aria-label="${esc(text)}">${esc(safety.grade)}</span>`;
}

/** Escape text, then wrap each search term in <mark>. */
function highlight(text, terms) {
  let out = esc(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(`(${esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    out = out.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, txt) => tag || txt.replace(re, "<mark>$1</mark>"));
  }
  return out;
}

/** First sentence, or a word-boundary cut near `max` chars; the detail page always shows the full text. */
function excerpt(text, max = 200) {
  const t = String(text ?? "").trim();
  const first = t.match(/^.{40,}?[.!?](?=\s|$)/)?.[0];
  if (first && first.length <= max) return first;
  if (t.length <= max) return t;
  return `${t.slice(0, t.lastIndexOf(" ", max) > 0 ? t.lastIndexOf(" ", max) : max).replace(/[,;:\s]+$/, "")}…`;
}

const repoLabel = (url) => String(url).replace("https://github.com/", "");
const repoOwner = (url) => repoLabel(url).split("/")[0] ?? "";
/** Small owner/org label linking to that repository's skills. */
const ownerChip = (url) =>
  `<a class="owner" href="/search?repo=${enc(url)}" title="All skills from ${esc(repoLabel(url))}">${esc(repoOwner(url))}</a>`;
const repoLink = (url, text) => `<a href="/search?repo=${enc(url)}">${esc(text ?? repoLabel(url))}</a>`;

const tagChips = (tags) => (tags.length ? `<div class="chips">${tags.map((t) => `<a class="chip" href="/search?tag=${enc(t)}">${esc(t)}</a>`).join("")}</div>` : "");
const collChip = (c) => (c ? `<a class="coll" href="/search?collection=${enc(c)}">${esc(c)}</a>` : "");

function card(s) {
  // The card is a div (not a link) so its tag, collection and star controls stay separate targets.
  return `<article class="card">
    <div class="card-top"><h3><a href="/skill/${enc(s.slug)}">${esc(s.name)}</a></h3>
      <span class="card-right">${collChip(s.collection)}${starButton(s.slug, s.stars ?? 0)}</span></div>
    ${s.description ? `<p class="desc">${esc(excerpt(s.description))}</p>` : `<p class="desc muted">No description in its SKILL.md.</p>`}
    <div class="foot">${tagChips(s.tags)}
      <span class="foot-right">${ownerChip(s.repoUrl)}<span class="date" title="${esc(fullDate(s.createdAt))}">added ${relTime(s.createdAt)}</span></span></div>
  </article>`;
}

function examplePromo(ex) {
  return `<a class="promo" href="/skill/${enc(ex.slug)}?flow">
    <span class="eyebrow">Example flow</span>
    <span class="promo-text"><strong>${esc(ex.name)}</strong> — see what a built visual flow looks like</span>
    <span class="btn primary" aria-hidden="true">Open the flow</span>
  </a>`;
}

function tagCloud(tags) {
  if (!tags.length) return `<p class="muted">No tags yet.</p>`;
  const max = Math.max(...tags.map((t) => t.count));
  const size = (n) => (0.85 + (Math.log(n) / Math.log(Math.max(max, 2))) * 0.85).toFixed(2);
  return `<div class="cloud">${[...tags]
    .sort((a, b) => a.tag.localeCompare(b.tag))
    .map((t) => `<a href="/search?tag=${enc(t.tag)}" style="font-size:${size(t.count)}rem" title="${t.count} skill${t.count > 1 ? "s" : ""}">${esc(t.tag)}<sup>${t.count}</sup></a>`)
    .join("")}</div>`;
}

/* ---------------- views ---------------- */

let homeData = null;

function favoritesSummary() {
  const n = starred.size;
  return n
    ? `<p><a href="/favorites">${n} starred skill${n === 1 ? "" : "s"}</a></p>`
    : `<p class="muted">Star a skill with ☆ and it shows up here, on this browser.</p>`;
}

async function viewHome() {
  const d = await api("/api/home");
  homeData = d;
  document.title = "Agent Skills Directory for Claude Code & Codex · Skills Explorer";
  if (!d.total) {
    app.innerHTML = `<div class="empty"><h1>No skills indexed yet</h1>
      <p class="lede">Add a repository with the index tool, then reload this page:</p>
      <code>npm run cli -- register anthropics/skills --auto-tags</code></div>`;
    return;
  }
  app.innerHTML = `
    <section class="intro">
      <span class="eyebrow">Index · <span class="count">${d.total}</span> skill${d.total > 1 ? "s" : ""}</span>
      <h1>Find a skill, then see how it works</h1>
      <p class="lede">Browse agent skills from GitHub by tag or collection, or search by name and description. Each skill page can show a safety box score, a grade for what the skill and its scripts can reach, and a visual flow: an interactive walkthrough of the skill, built by Claude from its SKILL.md.</p>
    </section>
    <div class="home">
      <section class="section">
        ${d.example ? examplePromo(d.example) : ""}
        <div class="section-head">
          <div class="tabs" role="tablist">
            <button type="button" role="tab" class="tab" id="tab-discover" aria-selected="true" data-tab="discover">Discover</button>
            <button type="button" role="tab" class="tab" id="tab-popular" aria-selected="false" data-tab="popular">Popular</button>
          </div>
          <a href="/search">Browse all</a>
        </div>
        <div class="cards" id="homeList">${d.discover.map(card).join("")}</div>
      </section>
      <aside class="side">
        <section class="section"><h2>Favorites</h2>${favoritesSummary()}</section>
        <section class="section"><h2>Tags</h2>${tagCloud(d.tags)}</section>
        ${d.collections.length ? `<section class="section"><h2>Collections</h2><ul class="list-plain">${d.collections
          .map((c) => `<li><a href="/search?collection=${enc(c.collection)}"><span>${esc(c.collection)}</span><span class="n">${c.count}</span></a></li>`)
          .join("")}</ul></section>` : ""}
      </aside>
    </div>`;
  bindHomeTabs();
}

function bindHomeTabs() {
  document.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const which = btn.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
      const list = document.getElementById("homeList");
      capture("home_tab_changed", { tab: which });
      if (which !== "popular") {
        list.innerHTML = homeData.discover.map(card).join("");
        return;
      }
      // Re-fetch so stars added since the page loaded are counted.
      const items = await api("/api/popular?limit=12").then((d) => d.results).catch(() => homeData.popular);
      list.innerHTML = items.length
        ? items.map(card).join("")
        : `<p class="muted">No skills have been starred yet. Star one with ☆ and it appears here.</p>`;
    }),
  );
}

async function viewFavorites() {
  const slugs = [...starred];
  if (!slugs.length) {
    app.innerHTML = `<div class="empty"><h1>No favorites yet</h1>
      <p class="muted">Star a skill with ☆ on any skill page or card. Favorites are kept in this browser only, so they don't follow you to another device.</p>
      <a class="btn" href="/">Back to the index</a></div>`;
    return;
  }
  const d = await api(`/api/skills?slugs=${enc(slugs.join(","))}`);
  const missing = slugs.length - d.results.length;
  app.innerHTML = `<section class="intro"><span class="eyebrow">Favorites</span>
      <h1>${d.results.length} starred skill${d.results.length === 1 ? "" : "s"}</h1>
      <p class="lede">Kept in this browser only.${missing ? ` ${missing} starred skill${missing === 1 ? " is" : "s are"} no longer in the index.` : ""}</p></section>
    <div class="cards">${d.results.map(card).join("")}</div>`;
}

async function viewSearch(params) {
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const collection = params.get("collection") ?? "";
  const repo = params.get("repo") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  qInput.value = q;
  const d = await api(`/api/search?q=${enc(q)}&tag=${enc(tag)}&collection=${enc(collection)}&repo=${enc(repo)}&page=${page}`);
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const pageHref = (n) => {
    const p = new URLSearchParams(params);
    if (n > 1) p.set("page", String(n));
    else p.delete("page");
    return `/search${p.toString() ? `?${p}` : ""}`;
  };
  const pager = pages > 1
    ? `<nav class="pager" aria-label="Pages">${page > 1 ? `<a rel="prev" href="${pageHref(page - 1)}">Previous</a>` : `<span class="muted">Previous</span>`}
        <span class="pager-pages">Page ${page} of ${pages}: ${Array.from({ length: pages }, (_, i) => i + 1).map((n) => (n === page ? `<strong aria-current="page">${n}</strong>` : `<a href="${pageHref(n)}">${n}</a>`)).join(" ")}</span>
        ${page < pages ? `<a rel="next" href="${pageHref(page + 1)}">Next</a>` : `<span class="muted">Next</span>`}</nav>`
    : "";
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const without = (key) => {
    const p = new URLSearchParams(params);
    p.delete(key);
    return `/search?${p}`;
  };
  const filters = [
    q && `<span class="filter">matching “${esc(q)}”<a href="${without("q")}" aria-label="Clear search">×</a></span>`,
    tag && `<span class="filter">tag <strong>${esc(tag)}</strong><a href="${without("tag")}" aria-label="Remove tag filter">×</a></span>`,
    collection && `<span class="filter">collection <strong>${esc(collection)}</strong><a href="${without("collection")}" aria-label="Remove collection filter">×</a></span>`,
    repo && `<span class="filter">repo <strong>${esc(repoLabel(repo))}</strong><a href="${without("repo")}" aria-label="Remove repository filter">×</a></span>`,
  ].filter(Boolean);
  const title = q || tag || collection || repo ? `${d.total} result${d.total === 1 ? "" : "s"}` : `All ${d.total} skills`;
  document.title = `${collection ? `${collection} collection` : tag ? `Skills tagged ${tag}` : repo ? `Skills from ${repoLabel(repo)}` : q ? `Search: ${q}` : "All skills"}${page > 1 ? `, page ${page}` : ""} · Skills Explorer`;
  app.innerHTML = `
    <section class="intro"><span class="eyebrow">Search</span><h1>${title}</h1>
      ${filters.length ? `<div class="filters">${filters.join("")}</div>` : ""}</section>
    ${d.results.length ? `<div class="results">${d.results
      .map((s) => `<a class="result" href="/skill/${enc(s.slug)}">
          <h3>${highlight(s.name, terms)}</h3><span class="card-right">${s.collection ? `<span class="coll">${esc(s.collection)}</span>` : ""}${starButton(s.slug, s.stars ?? 0)}</span>
          ${s.description ? `<p class="desc">${highlight(excerpt(s.description, 320), terms)}</p>` : ""}
          <div class="chips">${s.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}<span class="owner-inline">${esc(repoLabel(s.repoUrl))}</span></div>
        </a>`).join("")}</div>${pager}`
      : `<div class="empty"><h2>No skills match</h2><p class="muted">Search looks at skill names and descriptions. Try fewer or shorter words, or remove a filter.</p><a class="btn" href="/">Back to the index</a></div>`}`;
}

async function viewSkill(slug, params = new URLSearchParams()) {
  const myRoute = routeId;
  let d;
  try {
    d = await api(`/api/skills/${enc(slug)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    app.innerHTML = `<div class="empty"><h1>Skill not found</h1><p class="muted">“${esc(slug)}” isn't in the index. It may have been renamed or removed.</p><a class="btn" href="/">Back to the index</a></div>`;
    return;
  }
  const s = d.skill;
  const repoName = s.repoUrl.replace("https://github.com/", "");
  document.title = `${s.name}: Claude Code skill by ${repoOwner(s.repoUrl)} · Skills Explorer`;
  app.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Skills</a><span>/</span>${s.collection ? `<a href="/search?collection=${enc(s.collection)}">${esc(s.collection)}</a><span>/</span>` : ""}<span>${esc(s.name)}</span></nav>
    <div class="detail-grid">
    <div class="detail-main">
    <section class="detail-head">
      <span class="eyebrow">Skill</span>
      <div class="title-row"><h1>${esc(s.name)}</h1>${starButton(s.slug, d.stars ?? 0)}</div>
      ${s.description ? `<p class="desc">${esc(s.description)}</p>` : `<p class="desc muted">No description in its SKILL.md.</p>`}
      ${tagChips(s.tags)}
      ${d.repoSkillCount > 1 ? `<p class="sibling">Part of <strong>${esc(repoName)}</strong> — ${repoLink(s.repoUrl, `see all ${d.repoSkillCount} skills from this repository`)}</p>` : ""}
    </section>
    <dl class="meta">
      <div><dt>Repository</dt><dd>${repoLink(s.repoUrl, repoName)} <a class="out" href="${esc(s.repoUrl)}" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open ${esc(repoName)} on GitHub">↗</a></dd></div>
      <div><dt>Path</dt><dd><a class="mono" href="${esc(d.links.skillMd)}" target="_blank" rel="noopener">${esc(s.path ? `${s.path}/SKILL.md` : "SKILL.md")}</a>
        <button type="button" class="out preview-btn" data-preview title="Preview this SKILL.md" aria-label="Preview this SKILL.md">👁 Preview</button></dd></div>
      <div><dt>Branch</dt><dd class="mono">${esc(s.repoRef)}</dd></div>
      <div><dt>Collection</dt><dd>${s.collection ? collChip(s.collection) : `<span class="muted">None</span>`}</dd></div>
      <div><dt>Added</dt><dd title="${esc(fullDate(s.createdAt))}">${relTime(s.createdAt)}</dd></div>
      <div><dt>Updated</dt><dd title="${esc(fullDate(s.updatedAt))}">${relTime(s.updatedAt)}</dd></div>
    </dl>
    ${installSection(d.install)}
    </div>
    <aside class="boxscore" id="safety" aria-live="polite" aria-label="Safety box score"></aside>
    </div>
    <section class="flow" id="flow" aria-live="polite"></section>
    ${d.related?.length ? `<section class="section related"><h2>Related skills</h2><div class="cards">${d.related.map(card).join("")}</div></section>` : ""}`;
  document.querySelector("[data-preview]")?.addEventListener("click", () => openSourceModal(s, d.links.skillMd));
  renderSafety(s, d.safety, myRoute);
  renderFlow(s, d.flow, myRoute);
  // /skill/<slug>?flow (or ?safety) links straight to that panel; the router scrolls there once it's done.
  if (params.has("flow")) pendingAnchor = "flow";
  else if (params.has("safety")) pendingAnchor = "safety";
}

/** How to get the skill onto a machine: the skills CLI, or a copy into Claude Code's skills directory. */
function installSection(install) {
  if (!install) return "";
  return `<section class="install" id="install">
    <h2>Install<a class="anchor" href="#install" title="Link to the install steps" aria-label="Link to the install steps">#</a></h2>
    <p>With the <a href="https://github.com/vercel-labs/skills" target="_blank" rel="noopener">skills</a> CLI, which installs into Claude Code, Codex, Cursor and other agents:</p>
    <pre><code>${esc(install.cli)}</code></pre>
    <p class="muted">Or copy the skill folder into Claude Code's skills directory by hand (<code>~/.claude/skills</code> for every project, or <code>.claude/skills</code> inside one):</p>
    <pre><code>${esc(install.manual)}</code></pre>
  </section>`;
}

/* ---------------- safety box score panel ---------------- */

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

function scorecard(r) {
  const dots = (level) => `<span class="dots level-${level}" aria-label="level ${level} of 3">${[1, 2, 3].map((i) => `<i class="${i <= level ? "on" : ""}"></i>`).join("")}</span>`;
  const findings = [...r.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const inv = r.inventory;
  const kinds = Object.entries(inv.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");
  return `<div class="scorecard">
    <div class="score-top">
      ${gradeBadge(r)}
      <div class="score-headline"><strong>${esc(r.label)}</strong><span class="muted">${r.score} / 100 risk points · grade ${esc(r.grade)}</span></div>
    </div>
    <p class="score-summary">${esc(r.summary)}</p>
    <ul class="cats">${r.categories.map((c) => `<li class="cat level-${c.level}">
        <div class="cat-head"><span class="cat-name">${esc(c.name)}</span>${dots(c.level)}</div>
        <p class="cat-why">${esc(c.rationale)}</p></li>`).join("")}</ul>
    ${findings.length ? `<h3>Findings</h3><ul class="findings">${findings.map((f) => `<li class="finding sev-${esc(f.severity)}">
        <div class="finding-head"><span class="sev">${esc(f.severity)}</span><strong>${esc(f.title)}</strong>${f.file ? `<span class="mono finding-file">${esc(f.file)}</span>` : ""}</div>
        <p>${esc(f.detail)}</p>${f.evidence ? `<code class="evidence">${esc(f.evidence)}</code>` : ""}</li>`).join("")}</ul>` : `<p class="muted">No findings.</p>`}
    ${r.beforeInstalling.length ? `<h3>Before you install</h3><ul class="checks">${r.beforeInstalling.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    <details class="scan-details"><summary>Automated scan: ${r.scan.hits.length} signal${r.scan.hits.length === 1 ? "" : "s"} in ${inv.files} file${inv.files === 1 ? "" : "s"} (${esc(kinds)})</summary>
      ${inv.scripts.length ? `<p class="muted">Native scripts: ${inv.scripts.map((p) => `<span class="mono">${esc(p)}</span>`).join(", ")}</p>` : `<p class="muted">No native scripts ship with this skill.</p>`}
      ${inv.binaries.length ? `<p class="muted">Binaries (not readable): ${inv.binaries.map((p) => `<span class="mono">${esc(p)}</span>`).join(", ")}</p>` : ""}
      ${inv.skipped.length ? `<p class="muted">Not read (size or budget): ${inv.skipped.map((p) => `<span class="mono">${esc(p)}</span>`).join(", ")}</p>` : ""}
      ${r.scan.hits.length ? `<table class="hits"><thead><tr><th>Sev</th><th>Signal</th><th>Where</th><th>Line</th></tr></thead><tbody>${r.scan.hits.map((h) => `<tr class="sev-${h.severity}">
        <td>${h.severity}</td><td>${esc(h.what)}</td><td class="mono">${esc(h.file)}:${h.line}</td><td><code>${esc(h.excerpt)}</code></td></tr>`).join("")}</tbody></table>` : ""}
    </details>
  </div>`;
}

/** Compact category rows for the box: name, dots. */
function boxRows(r) {
  const short = { execution: "Execution", network: "Network", filesystem: "Filesystem", secrets: "Secrets", privilege: "Privilege", injection: "Hijack surface", autonomy: "Irreversible", opacity: "Transparency" };
  return `<ul class="box-rows">${r.categories.map((c) => `<li class="level-${c.level}" title="${esc(c.name)}: ${esc(c.rationale)}">
      <span>${esc(short[c.key] || c.name)}</span>
      <span class="dots" aria-label="level ${c.level} of 3">${[1, 2, 3].map((i) => `<i class="${i <= c.level ? "on" : ""}"></i>`).join("")}</span></li>`).join("")}</ul>`;
}

/** One reusable <dialog> per kind of modal; clicking the backdrop closes it. */
function modal(id) {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = id;
    dlg.className = "modal";
    dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());
    document.body.appendChild(dlg);
  }
  return dlg;
}

/** The skill's own SKILL.md, frontmatter first, rendered by the server. */
async function openSourceModal(s, githubUrl) {
  const dlg = modal("sourceModal");
  const path = s.path ? `${s.path}/SKILL.md` : "SKILL.md";
  const gh = `<a href="${esc(githubUrl)}" target="_blank" rel="noopener">View on GitHub ↗</a>`;
  const shell = (note, body) => {
    dlg.innerHTML = `<div class="modal-head"><div><span class="eyebrow">SKILL.md</span><h2>${esc(s.name)}</h2>
        <p class="flow-meta mono">${esc(path)}</p><p class="muted small">${note}</p></div>
        <button type="button" class="btn modal-close" aria-label="Close" data-close>✕</button></div>
      <div class="modal-body">${body}</div>`;
    dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  };

  shell(gh, `<p class="muted">Reading it from GitHub…</p>`);
  dlg.showModal();
  capture("skill_source_previewed", { skill: s.slug });

  try {
    const d = await api(`/api/skills/${enc(s.slug)}/source`);
    if (!dlg.open) return;
    const front = d.frontmatter.length
      ? `<dl class="frontmatter">${d.frontmatter.map((f) => `<div><dt>${esc(f.key)}</dt><dd>${esc(f.value)}</dd></div>`).join("")}</dl>`
      : "";
    shell(
      `${(d.bytes / 1024).toFixed(1)} kB · ${gh}`,
      `<article class="markdown">${front}${d.html || `<p class="muted">This SKILL.md is only frontmatter — it has no body.</p>`}</article>`,
    );
  } catch (e) {
    if (!dlg.open) return;
    shell(gh, `<div class="note bad">${esc(e.message)}</div><p class="muted">You can still read it on GitHub.</p>`);
  }
}

/** The full scorecard in a modal dialog. */
function openSafetyModal(s, r) {
  const dlg = modal("safetyModal");
  dlg.innerHTML = `<div class="modal-head"><div><span class="eyebrow">Safety box score</span><h2>${esc(s.name)}</h2>
      <p class="flow-meta">Rated ${relTime(r.ratedAt)} with <span class="mono">${esc(r.model)}</span> from ${r.sourceFiles.length} file${r.sourceFiles.length === 1 ? "" : "s"}</p></div>
      <button type="button" class="btn modal-close" aria-label="Close" data-close>✕</button></div>
    <div class="modal-body">${scorecard(r)}</div>`;
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  dlg.showModal();
  capture("safety_detail_opened", { grade: r.grade });
}

function renderSafety(s, st, myRoute) {
  const el = document.getElementById("safety");
  if (!el || myRoute !== routeId) return;
  const model = serverConfig.scoreModel;
  const head = `<div class="box-head"><span class="eyebrow">Safety box score</span><a class="anchor" href="/skill/${enc(s.slug)}?safety" title="Link to this skill's safety score" aria-label="Link to this skill's safety score">#</a></div>`;
  const rateBtn = (label, primary) => `<button type="button" class="btn ${primary ? "primary" : ""} ${primary ? "" : "small"}" data-rate>${label}</button>`;
  const summary = (r, extra = "") => `
    <div class="box-grade">${gradeBadge(r)}<div><strong>${esc(r.label)}</strong><span class="muted">${r.score} / 100 risk points</span></div></div>
    ${boxRows(r)}
    <div class="box-actions"><button type="button" class="btn primary" data-detail>Detail</button>${extra}</div>`;

  if (st.state === "queued" || st.state === "running") {
    const since = st.job.startedAt || st.job.createdAt;
    el.innerHTML = `${head}
      <div class="building box-building"><span class="spinner" aria-hidden="true"></span>
        <div><strong>${st.state === "queued" ? "Waiting to start…" : "Rating…"}</strong>
        <p class="progress small" id="safetyProgress">${esc(st.job.progress || "")}</p>
        <p class="muted small">Elapsed <span class="elapsed" id="safetyElapsed">0:00</span></p></div></div>
      ${st.report ? `<p class="muted small">Previous rating, from ${relTime(st.report.ratedAt)}:</p>${summary(st.report)}` : ""}`;
    tickElapsed(since, myRoute, "safetyElapsed");
    pollSafety(s, myRoute, st.state);
  } else if (st.state === "ready") {
    const r = st.report;
    el.innerHTML = `${head}${summary(r, rateBtn("Re-rate", false))}
      <p class="muted small box-foot" title="${esc(r.model)}">Rated ${relTime(r.ratedAt)} from ${r.sourceFiles.length} file${r.sourceFiles.length === 1 ? "" : "s"} · <a href="/safety">How it works</a></p>`;
  } else if (st.state === "failed") {
    el.innerHTML = `${head}
      <div class="note bad small"><strong>The last rating failed.</strong> ${esc(st.job.error || "No error message was recorded.")}</div>
      <div class="box-actions">${rateBtn("Try again", true)}</div>
      ${st.report ? `<p class="muted small">Previous rating, from ${relTime(st.report.ratedAt)}:</p>${summary(st.report)}` : ""}`;
  } else {
    el.innerHTML = `${head}
      <p class="muted small">What installing this skill lets an agent do: eight categories from shell execution to secrets access, rated from its own files and scripts${model ? ` by <span class="mono">${esc(model)}</span>` : ""}. Takes a minute or two; saved for everyone. <a href="/safety">How it works</a>.</p>
      <div class="box-actions">${rateBtn("Request score", true)}</div>`;
  }
  el.querySelector("[data-rate]")?.addEventListener("click", (e) => startRating(s, e.currentTarget, myRoute));
  const report = st.report;
  el.querySelectorAll("[data-detail]").forEach((b) => b.addEventListener("click", () => openSafetyModal(s, report)));
}

async function startRating(s, btn, myRoute) {
  btn.disabled = true;
  const rerate = btn.textContent.trim() === "Re-rate";
  track("safety_rating_started", { skill: s.slug, rerate });
  const token = storage("se-build-token");
  try {
    const d = await api(`/api/skills/${enc(s.slug)}/safety`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} });
    capture("safety_rating_requested", { rating_type: rerate ? "rerate" : "initial" });
    renderSafety(s, d.safety, myRoute);
  } catch (e) {
    btn.disabled = false;
    if (e.status === 401) return askToken(s, btn, myRoute, () => startRating(s, btn, myRoute));
    toast(`Couldn't start the rating: ${e.message}`);
  }
}

async function pollSafety(s, myRoute, lastState) {
  await new Promise((r) => setTimeout(r, 3000));
  if (myRoute !== routeId) return;
  try {
    const st = await api(`/api/skills/${enc(s.slug)}/safety`);
    if (myRoute !== routeId) return;
    if (st.state === lastState && (st.state === "queued" || st.state === "running")) {
      const p = document.getElementById("safetyProgress");
      if (p) p.textContent = st.job.progress || "";
      return pollSafety(s, myRoute, lastState);
    }
    if (st.state === "ready") {
      capture("safety_rating_completed", { grade: st.report.grade });
      toast(`Safety grade ${st.report.grade}: ${st.report.label}`);
    }
    if (st.state === "failed") capture("safety_rating_failed", { previous_state: lastState });
    renderSafety(s, st, myRoute);
  } catch {
    pollSafety(s, myRoute, lastState);
  }
}

/* ---------------- visual flow panel ---------------- */

let frameEl = null;
window.addEventListener("message", (e) => {
  if (frameEl && e.source === frameEl.contentWindow && e.data?.type === "skills-explorer:flow-height") {
    frameEl.style.height = `${Math.max(480, Math.min(Number(e.data.height) || 0, 20000)) + 2}px`;
    if (anchorRetry === routeId && window.scrollY < 40) scrollToAnchor("flow");
  }
});

function flowFrame(s, flow) {
  return `<iframe class="flow-frame" id="flowFrame" title="Visual flow for ${esc(s.name)}"
      src="/flows/${enc(s.slug)}?v=${enc(flow.builtAt)}"
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" allow="clipboard-write" loading="lazy"></iframe>`;
}

function renderFlow(s, st, myRoute) {
  const el = document.getElementById("flow");
  if (!el || myRoute !== routeId) return;
  frameEl = null;
  const model = serverConfig.flowModel;
  const head = (right = "") =>
    `<div class="flow-head"><div><h2>Visual flow<a class="anchor" href="/skill/${enc(s.slug)}?flow" title="Link to this skill's visual flow" aria-label="Link to this skill's visual flow">#</a></h2>${right}</div>`;
  const buildBtn = (label, primary) => `<button type="button" class="btn ${primary ? "primary" : ""}" data-build>${label}</button>`;

  if (st.state === "queued" || st.state === "running") {
    const since = st.job.startedAt || st.job.createdAt;
    el.innerHTML = `${head()}</div>
      <div class="flow-empty"><div class="building"><span class="spinner" aria-hidden="true"></span>
        <div><strong>${st.state === "queued" ? "Waiting to start…" : "Building the visual flow…"}</strong>
        <p class="muted">Reading this skill's files from GitHub and generating the page with <span class="mono">${esc(st.job.model)}</span>. This usually takes a few minutes. You can leave this page and come back.</p>
        <p class="progress" id="progress">${esc(st.job.progress || "")}</p>
        <p class="muted">Elapsed: <span class="elapsed" id="elapsed">0:00</span></p></div></div></div>
      ${st.flow ? `<p class="flow-meta">The previous version is shown below until the new one is ready.</p>${flowFrame(s, st.flow)}` : ""}`;
    tickElapsed(since, myRoute);
    pollFlow(s, myRoute, st.state);
  } else if (st.state === "ready") {
    const f = st.flow;
    el.innerHTML = `${head(`<p class="flow-meta">Built ${relTime(f.builtAt)} with <span class="mono">${esc(f.model)}</span> from ${f.sourceFiles.length} file${f.sourceFiles.length === 1 ? "" : "s"}</p>`)}
        <div class="actions"><a class="btn" href="/flows/${enc(s.slug)}" target="_blank" rel="noopener">Open full page</a>${buildBtn("Rebuild", false)}</div></div>
      ${flowFrame(s, f)}`;
  } else if (st.state === "failed") {
    el.innerHTML = `${head()}<div class="actions">${buildBtn("Try again", true)}</div></div>
      <div class="note bad"><strong>The last build failed.</strong> ${esc(st.job.error || "No error message was recorded.")}</div>
      ${st.flow ? `<p class="flow-meta">Showing the previous version, built ${relTime(st.flow.builtAt)}.</p>${flowFrame(s, st.flow)}` : ""}`;
  } else {
    el.innerHTML = `${head()}</div>
      <div class="flow-empty">
        <h3>No visual flow yet</h3>
        <p class="muted">A visual flow is an interactive walkthrough of this skill: its setup choices, each stage with the real commands, checks and stop points, and a checklist to track progress. Claude builds it from the skill's SKILL.md and reference files${model ? ` using <span class="mono">${esc(model)}</span>` : ""}. It takes a few minutes and is saved for everyone.</p>
        ${buildBtn("Build visual flow", true)}
      </div>`;
  }
  frameEl = document.getElementById("flowFrame");
  el.querySelector("[data-build]")?.addEventListener("click", (e) => startBuild(s, e.currentTarget, myRoute));
}

async function startBuild(s, btn, myRoute) {
  btn.disabled = true;
  track("flow_build_started", { skill: s.slug, rebuild: btn.textContent.trim() === "Rebuild" });
  const token = storage("se-build-token");
  try {
    const d = await api(`/api/skills/${enc(s.slug)}/flow`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    capture("visual_flow_build_requested", { build_type: btn.textContent.trim() === "Rebuild" ? "rebuild" : "initial" });
    renderFlow(s, d.flow, myRoute);
  } catch (e) {
    btn.disabled = false;
    if (e.status === 401) return askToken(s, btn, myRoute);
    toast(`Couldn't start the build: ${e.message}`);
  }
}

function askToken(s, btn, myRoute, retry = () => startBuild(s, btn, myRoute)) {
  const el = btn.closest("section") || document.getElementById("flow");
  if (el.querySelector(".token-row")) return;
  btn.insertAdjacentHTML("afterend", `<div class="token-row"><label for="buildToken" class="muted">This server needs a build token to start builds.</label>
    <input id="buildToken" type="password" placeholder="Paste the build token" autocomplete="off"><button type="button" class="btn primary" id="tokenGo">Build with this token</button></div>`);
  const input = document.getElementById("buildToken");
  input.focus();
  const go = () => {
    if (!input.value.trim()) return;
    storage("se-build-token", input.value.trim());
    el.querySelector(".token-row").remove();
    retry();
  };
  document.getElementById("tokenGo").addEventListener("click", go);
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
}

const elapsedTimers = {};
function tickElapsed(since, myRoute, id = "elapsed") {
  clearInterval(elapsedTimers[id]);
  const start = new Date(since).getTime();
  const t = (elapsedTimers[id] = setInterval(() => {
    const out = document.getElementById(id);
    if (!out || myRoute !== routeId) return clearInterval(t);
    const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
    out.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 1000));
}

async function pollFlow(s, myRoute, lastState) {
  await new Promise((r) => setTimeout(r, 3000));
  if (myRoute !== routeId) return;
  try {
    const st = await api(`/api/skills/${enc(s.slug)}/flow`);
    if (myRoute !== routeId) return;
    // Same in-progress state: keep the current view (and its elapsed timer), refresh the progress line, poll again.
    if (st.state === lastState && (st.state === "queued" || st.state === "running")) {
      const p = document.getElementById("progress");
      if (p) p.textContent = st.job.progress || "";
      return pollFlow(s, myRoute, lastState);
    }
    if (st.state === "ready") {
      capture("visual_flow_build_completed", { previous_state: lastState });
      toast("The visual flow is ready");
    }
    if (st.state === "failed") capture("visual_flow_build_failed", { previous_state: lastState });
    renderFlow(s, st, myRoute); // re-renders on queued → running too, which starts the next poll
  } catch {
    pollFlow(s, myRoute, lastState); // transient network error: keep polling
  }
}

function scrollToAnchor(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

/* ---------------- router ---------------- */

/** Paths this script renders itself. Everything else (/about, /safety, /skills, 404s) is the server's page, left as is. */
const clientRendered = (path) => path === "/" || path === "/index.html" || path === "/search" || path === "/favorites" || path.startsWith("/skill/");

async function route() {
  routeId++;
  frameEl = null;
  document.getElementById("safetyModal")?.close();
  const path = location.pathname || "/";
  const params = new URLSearchParams(location.search);
  if (!path.startsWith("/search")) qInput.value = "";
  if (!clientRendered(path)) return;
  try {
    if (path.startsWith("/skill/")) await viewSkill(decodeURIComponent(path.slice("/skill/".length)), params);
    else if (path === "/favorites") await viewFavorites();
    else if (path === "/search") await viewSearch(params);
    else await viewHome();
  } catch (e) {
    app.innerHTML = `<div class="note bad"><strong>Something went wrong loading this page.</strong> ${esc(e.message)}</div>`;
  }
  const anchorId = pendingAnchor;
  pendingAnchor = null;
  if (anchorId) {
    anchorRetry = routeId;
    scrollToAnchor(anchorId);
    // The page is often too short to scroll until the flow iframe has loaded; try again when it has.
    setTimeout(() => anchorRetry === routeId && scrollToAnchor(anchorId), 1200);
  } else {
    window.scrollTo({ top: 0 });
  }
  // Navigation happens without a page load, which GTM's built-in page view doesn't see, so report each one.
  track("virtual_page_view", {
    page_path: `${location.pathname}${location.search}`,
    page_location: location.href,
    page_title: document.title,
  });
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-star]");
  if (!btn) return;
  e.preventDefault();
  const slug = btn.dataset.star;
  const count = await toggleStar(slug);
  // Redraw every star for this skill (a card and the detail header can both be on screen).
  document.querySelectorAll(`[data-star="${CSS.escape(slug)}"]`).forEach((el) => {
    const shown = count ?? (Number(el.querySelector(".star-count")?.textContent) || 0) + (isStarred(slug) ? 1 : -1);
    el.outerHTML = starButton(slug, Math.max(0, shown));
  });
  const fav = document.querySelector(".side .section p");
  if (fav && location.pathname === "/") fav.outerHTML = favoritesSummary();
});

document.getElementById("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  track("search", { search_term: q });
  capture("search_performed", { has_query: Boolean(q), query_length: q.length });
  navigate(`/search?q=${enc(q)}`);
});

function navigate(url) {
  history.pushState(null, "", url);
  route();
}

// Same-site links render in place; everything else (GitHub, flows, new tabs, modified clicks) is left to the browser.
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a[href]");
  if (!a || a.target === "_blank" || a.hasAttribute("download") || a.origin !== location.origin) return;
  const href = a.getAttribute("href");
  if (!href.startsWith("/") || href.startsWith("//") || !clientRendered(a.pathname)) return; // server pages load normally
  e.preventDefault();
  if (href === `${location.pathname}${location.search}`) route();
  else navigate(href);
});
window.addEventListener("popstate", route);

// Links from the hash-router days (/#/skill/x) still work: swap them for the real path before the first render.
if (location.hash.startsWith("#/")) history.replaceState(null, "", location.hash.slice(1));

// The page must render even when config or analytics fail, so nothing here is fatal.
api("/api/config")
  .then(async (c) => {
    serverConfig = c;
    // Unconfigured PostHog throws in development on purpose; log it rather than blanking the page.
    await initializePosthog(c.posthog).catch((e) => console.warn("PostHog not initialized:", e.message));
  })
  .catch(() => {})
  .finally(route);
