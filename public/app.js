// Skills Explorer front end: a small hash-routed app over the JSON API.
import { initializePosthog } from "./posthog.js";

const app = document.getElementById("app");
const qInput = document.getElementById("q");
let routeId = 0; // bumps on every navigation so stale polls and timers stop
let pendingAnchor = null; // element to scroll to after the route renders
let anchorRetry = 0; // the flow iframe loads late, so a requested anchor is re-applied when it resizes
let serverConfig = { flowModel: "", buildRequiresToken: false };

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

const tagChips = (tags) => (tags.length ? `<div class="chips">${tags.map((t) => `<a class="chip" href="#/search?tag=${enc(t)}">${esc(t)}</a>`).join("")}</div>` : "");
const collChip = (c) => (c ? `<a class="coll" href="#/search?collection=${enc(c)}">${esc(c)}</a>` : "");

function card(s) {
  // The card is a div (not a link) so its tag and collection links stay separate targets.
  return `<article class="card">
    <div class="card-top"><h3><a href="#/skill/${enc(s.slug)}">${esc(s.name)}</a></h3>${collChip(s.collection)}</div>
    ${s.description ? `<p class="desc">${esc(excerpt(s.description))}</p>` : `<p class="desc muted">No description in its SKILL.md.</p>`}
    <div class="foot">${tagChips(s.tags)}<span class="date" title="${esc(fullDate(s.createdAt))}">added ${relTime(s.createdAt)}</span></div>
  </article>`;
}

function examplePromo(ex) {
  return `<a class="promo" href="#/skill/${enc(ex.slug)}?flow">
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
    .map((t) => `<a href="#/search?tag=${enc(t.tag)}" style="font-size:${size(t.count)}rem" title="${t.count} skill${t.count > 1 ? "s" : ""}">${esc(t.tag)}<sup>${t.count}</sup></a>`)
    .join("")}</div>`;
}

/* ---------------- views ---------------- */

async function viewHome() {
  const d = await api("/api/home");
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
      <p class="lede">Browse agent skills from GitHub by tag or collection, or search by name and description. Each skill page can show a visual flow: an interactive walkthrough of the skill, built by Claude from its SKILL.md.</p>
    </section>
    <div class="home">
      <section class="section">
        ${d.example ? examplePromo(d.example) : ""}
        <div class="section-head"><h2>New in the index</h2><a href="#/search">Browse all</a></div>
        <div class="cards">${d.recent.map(card).join("")}</div>
      </section>
      <aside class="side">
        <section class="section"><h2>Tags</h2>${tagCloud(d.tags)}</section>
        ${d.collections.length ? `<section class="section"><h2>Collections</h2><ul class="list-plain">${d.collections
          .map((c) => `<li><a href="#/search?collection=${enc(c.collection)}"><span>${esc(c.collection)}</span><span class="n">${c.count}</span></a></li>`)
          .join("")}</ul></section>` : ""}
      </aside>
    </div>`;
}

async function viewSearch(params) {
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const collection = params.get("collection") ?? "";
  qInput.value = q;
  const d = await api(`/api/search?q=${enc(q)}&tag=${enc(tag)}&collection=${enc(collection)}`);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const without = (key) => {
    const p = new URLSearchParams(params);
    p.delete(key);
    return `#/search?${p}`;
  };
  const filters = [
    q && `<span class="filter">matching “${esc(q)}”<a href="${without("q")}" aria-label="Clear search">×</a></span>`,
    tag && `<span class="filter">tag <strong>${esc(tag)}</strong><a href="${without("tag")}" aria-label="Remove tag filter">×</a></span>`,
    collection && `<span class="filter">collection <strong>${esc(collection)}</strong><a href="${without("collection")}" aria-label="Remove collection filter">×</a></span>`,
  ].filter(Boolean);
  const title = q || tag || collection ? `${d.results.length} result${d.results.length === 1 ? "" : "s"}` : "All skills";
  app.innerHTML = `
    <section class="intro"><span class="eyebrow">Search</span><h1>${title}</h1>
      ${filters.length ? `<div class="filters">${filters.join("")}</div>` : ""}</section>
    ${d.results.length ? `<div class="results">${d.results
      .map((s) => `<a class="result" href="#/skill/${enc(s.slug)}">
          <h3>${highlight(s.name, terms)}</h3>${s.collection ? `<span class="coll">${esc(s.collection)}</span>` : "<span></span>"}
          ${s.description ? `<p class="desc">${highlight(excerpt(s.description, 320), terms)}</p>` : ""}
          ${s.tags.length ? `<div class="chips">${s.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}
        </a>`).join("")}</div>`
      : `<div class="empty"><h2>No skills match</h2><p class="muted">Search looks at skill names and descriptions. Try fewer or shorter words, or remove a filter.</p><a class="btn" href="#/">Back to the index</a></div>`}`;
}

async function viewSkill(slug, params = new URLSearchParams()) {
  const myRoute = routeId;
  let d;
  try {
    d = await api(`/api/skills/${enc(slug)}`);
  } catch (e) {
    if (e.status !== 404) throw e;
    app.innerHTML = `<div class="empty"><h1>Skill not found</h1><p class="muted">“${esc(slug)}” isn't in the index. It may have been renamed or removed.</p><a class="btn" href="#/">Back to the index</a></div>`;
    return;
  }
  const s = d.skill;
  const repoName = s.repoUrl.replace("https://github.com/", "");
  document.title = `${s.name} · Skills Explorer`;
  app.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Index</a><span>/</span>${s.collection ? `<a href="#/search?collection=${enc(s.collection)}">${esc(s.collection)}</a><span>/</span>` : ""}<span>${esc(s.name)}</span></nav>
    <section class="detail-head">
      <span class="eyebrow">Skill</span>
      <h1>${esc(s.name)}</h1>
      ${s.description ? `<p class="desc">${esc(s.description)}</p>` : `<p class="desc muted">No description in its SKILL.md.</p>`}
      ${tagChips(s.tags)}
    </section>
    <dl class="meta">
      <div><dt>Repository</dt><dd><a href="${esc(s.repoUrl)}" target="_blank" rel="noopener">${esc(repoName)}</a></dd></div>
      <div><dt>Path</dt><dd><a class="mono" href="${esc(d.links.skillMd)}" target="_blank" rel="noopener">${esc(s.path ? `${s.path}/SKILL.md` : "SKILL.md")}</a></dd></div>
      <div><dt>Branch</dt><dd class="mono">${esc(s.repoRef)}</dd></div>
      <div><dt>Collection</dt><dd>${s.collection ? collChip(s.collection) : `<span class="muted">None</span>`}</dd></div>
      <div><dt>Added</dt><dd title="${esc(fullDate(s.createdAt))}">${relTime(s.createdAt)}</dd></div>
      <div><dt>Updated</dt><dd title="${esc(fullDate(s.updatedAt))}">${relTime(s.updatedAt)}</dd></div>
    </dl>
    <section class="flow" id="flow" aria-live="polite"></section>`;
  renderFlow(s, d.flow, myRoute);
  // #/skill/<slug>?flow links straight to the visual flow; the router scrolls there once it's done.
  if (params.has("flow")) pendingAnchor = "flow";
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
    `<div class="flow-head"><div><h2>Visual flow<a class="anchor" href="#/skill/${enc(s.slug)}?flow" title="Link to this skill's visual flow" aria-label="Link to this skill's visual flow">#</a></h2>${right}</div>`;
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

function askToken(s, btn, myRoute) {
  const el = document.getElementById("flow");
  if (el.querySelector(".token-row")) return;
  btn.insertAdjacentHTML("afterend", `<div class="token-row"><label for="buildToken" class="muted">This server needs a build token to start builds.</label>
    <input id="buildToken" type="password" placeholder="Paste the build token" autocomplete="off"><button type="button" class="btn primary" id="tokenGo">Build with this token</button></div>`);
  const input = document.getElementById("buildToken");
  input.focus();
  const go = () => {
    if (!input.value.trim()) return;
    storage("se-build-token", input.value.trim());
    el.querySelector(".token-row").remove();
    startBuild(s, btn, myRoute);
  };
  document.getElementById("tokenGo").addEventListener("click", go);
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
}

let elapsedTimer;
function tickElapsed(since, myRoute) {
  clearInterval(elapsedTimer);
  const start = new Date(since).getTime();
  const t = (elapsedTimer = setInterval(() => {
    const out = document.getElementById("elapsed");
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

async function route() {
  routeId++;
  frameEl = null;
  document.title = "Skills Explorer";
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = hash.split("?");
  const params = new URLSearchParams(query);
  if (!path.startsWith("/search")) qInput.value = "";
  try {
    if (path.startsWith("/skill/")) await viewSkill(decodeURIComponent(path.slice("/skill/".length)), params);
    else if (path.startsWith("/search")) await viewSearch(params);
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
  // Routes change the #hash, which GTM's built-in page view doesn't see, so report each one.
  track("virtual_page_view", {
    page_path: `${location.pathname}${location.hash}`,
    page_location: location.href,
    page_title: document.title,
  });
}

document.getElementById("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = qInput.value.trim();
  track("search", { search_term: q });
  capture("search_performed", { has_query: Boolean(q), query_length: q.length });
  location.hash = `#/search?q=${enc(q)}`;
});
window.addEventListener("hashchange", route);

// The page must render even when config or analytics fail, so nothing here is fatal.
api("/api/config")
  .then(async (c) => {
    serverConfig = c;
    // Unconfigured PostHog throws in development on purpose; log it rather than blanking the page.
    await initializePosthog(c.posthog).catch((e) => console.warn("PostHog not initialized:", e.message));
  })
  .catch(() => {})
  .finally(route);
