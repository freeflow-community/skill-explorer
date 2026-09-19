import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SkillIndex } from "../src/db.ts";
import { extractHtml, StubFlowGenerator } from "../src/flows/generator.ts";
import { FlowService } from "../src/flows/jobs.ts";
import { validateFlowHtml } from "../src/flows/validate.ts";
import { guessCollection, isSkillPath, parseRepo, parseSkillMd } from "../src/github.ts";
import { hasUnpushedChanges, pullIndex, pushIndex, SyncConflictError } from "../src/indexSync.ts";
import { createApp, IndexHolder } from "../src/server.ts";
import { StarStore } from "../src/stars.ts";
import { LocalBlobStore } from "../src/storage.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "skills-explorer-"));

function seed(path: string): SkillIndex {
  const index = new SkillIndex(path);
  index.upsert({
    name: "review-pr", description: "Check out a PR, drive the UI and post a GIF verdict",
    collection: null, repoUrl: "https://github.com/acme/skills", repoRef: "main", path: "review-pr", tags: ["GitHub", "QA"],
  });
  index.upsert({
    name: "provision-cloud-agent", description: "Provision an always-on cloud coding agent on AWS or Railway",
    collection: "cloud", repoUrl: "https://github.com/acme/cloud-agents", repoRef: "main", path: "skills/provision-cloud-agent", tags: ["aws", "agents"],
  });
  return index;
}

test("upsert keeps one row per repo+path and gives unique slugs", () => {
  const index = seed(join(tmp(), "i.db"));
  const again = index.upsert({
    name: "review-pr", description: "updated", collection: "qa",
    repoUrl: "https://github.com/acme/skills", repoRef: "main", path: "review-pr",
  });
  assert.equal(again.created, false);
  assert.equal(again.skill.slug, "review-pr");
  assert.equal(again.skill.description, "updated");
  assert.deepEqual(again.skill.tags, ["github", "qa"]);
  const other = index.upsert({
    name: "review-pr", description: "", collection: null,
    repoUrl: "https://github.com/other/repo", repoRef: "main", path: "x",
  });
  assert.equal(other.skill.slug, "review-pr-other");
  assert.equal(index.count(), 3);
});

test("search matches name and description, name first, and filters by tag", () => {
  const index = seed(join(tmp(), "i.db"));
  assert.deepEqual(index.search("aws").map((s) => s.slug), ["provision-cloud-agent"]);
  assert.deepEqual(index.search("GIF verdict").map((s) => s.slug), ["review-pr"]);
  assert.deepEqual(index.search("review").map((s) => s.slug)[0], "review-pr");
  assert.deepEqual(index.search("", { tag: "QA" }).map((s) => s.slug), ["review-pr"]);
  assert.deepEqual(index.search("100%"), []);
  assert.deepEqual(index.search("", { repo: "https://github.com/acme/skills" }).map((s) => s.slug), ["review-pr"]);
  assert.equal(index.countByRepo("https://github.com/acme/skills"), 1);
  assert.equal(index.countByRepo("https://github.com/nobody/nothing"), 0);
  assert.deepEqual(index.tagCounts().map((t) => t.tag).sort(), ["agents", "aws", "github", "qa"]);
  assert.equal(index.renameTag("qa", "GitHub"), 1);
  assert.deepEqual(index.getBySlug("review-pr")!.tags, ["github"]);
  assert.equal(index.renameTag("aws", null), 1);
  assert.deepEqual(index.tagCounts().map((t) => t.tag).sort(), ["agents", "github"]);
});

test("parseRepo handles the common forms", () => {
  assert.deepEqual(parseRepo("anthropics/skills"), { owner: "anthropics", repo: "skills" });
  assert.deepEqual(parseRepo("git@github.com:freeflow-community/cloud-agents.git"), { owner: "freeflow-community", repo: "cloud-agents" });
  assert.deepEqual(parseRepo("https://github.com/o/r/tree/dev/skills/x/"), { owner: "o", repo: "r", ref: "dev", subPath: "skills/x" });
  assert.throws(() => parseRepo("https://gitlab.com/o/r"));
});

test("parseSkillMd reads folded YAML descriptions", () => {
  const { meta, body } = parseSkillMd("---\nname: x\ndescription: >\n  line one\n  line two\n---\n# Body\n");
  assert.equal(meta.name, "x");
  assert.equal(String(meta.description).trim(), "line one line two");
  assert.equal(body, "# Body\n");
  assert.equal(guessCollection("plugins/slack/skills/digest/SKILL.md"), "slack");
});

test("isSkillPath skips test fixtures and vendored dirs", () => {
  assert.equal(isSkillPath("skills/pdf/SKILL.md"), true);
  assert.equal(isSkillPath("SKILL.md"), true);
  assert.equal(isSkillPath(".claude/skills/x/SKILL.md"), true);
  assert.equal(isSkillPath("tests/fixtures/mcp_poisoned_tool/SKILL.md"), false);
  assert.equal(isSkillPath("pkg/node_modules/x/SKILL.md"), false);
  assert.equal(isSkillPath(".github/skills/x/SKILL.md"), true);
  assert.equal(isSkillPath("skills/pdf/README.md"), false);
  assert.equal(isSkillPath("plugins/a/SKILL.md", "skills"), false);
});

test("extractHtml strips fences and surrounding prose", () => {
  assert.equal(extractHtml("```html\n<!doctype html><html><body>x</body></html>\n```"), "<!doctype html><html><body>x</body></html>");
  assert.equal(extractHtml("Here:\n<!DOCTYPE html>\n<html></html> done"), "<!DOCTYPE html>\n<html></html>");
  assert.throws(() => extractHtml("<html><body>cut off"));
});

test("validateFlowHtml catches script syntax errors like stray backticks in template literals", () => {
  const good = "<html><body><script>const x = `<p>Use <code>GIFBuilder</code></p>`;</script><script src=\"x.js\"></script></body></html>";
  assert.deepEqual(validateFlowHtml(good), []);
  const bad = "<html><body><script>\nconst x = `<p>the `GIFBuilder` helper</p>`;\n</script></body></html>";
  const problems = validateFlowHtml(bad);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /syntax error .*GIFBuilder/);
  assert.deepEqual(validateFlowHtml('<script type="application/json">{not js}</script>'), []);
});

test("a page that fails validation is regenerated once with feedback, then stored", async () => {
  const dir = tmp();
  const index = seed(join(dir, "i.db"));
  const feedbackSeen: string[][] = [];
  let calls = 0;
  const generator = {
    model: "fake",
    async generate(_s: unknown, _src: unknown, opts: { feedback?: string[] } = {}) {
      feedbackSeen.push(opts.feedback ?? []);
      calls++;
      const html = calls === 1 ? "<html><body><script>const a = `x `y` z`;</script></body></html>" : "<html><body><script>const a = 1;</script></body></html>";
      return { html, model: "fake" };
    },
  };
  const flows = new FlowService({
    store: new LocalBlobStore(join(dir, "blobs")), generator, jobsDbPath: ":memory:",
    findSkill: (s) => index.getBySlug(s), loadSources: async () => [{ path: "SKILL.md", content: "x" }],
  });
  const job = await flows.waitFor(flows.start("review-pr").id, 5);
  assert.equal(job.status, "succeeded");
  assert.equal(calls, 2);
  assert.equal(feedbackSeen[0]!.length, 0);
  assert.match(feedbackSeen[1]![0]!, /syntax error/);
  assert.match((await flows.getHtml("review-pr"))!, /const a = 1/);
});

test("index sync: push, pull, unpushed edits and conflicts", async () => {
  const store = new LocalBlobStore(tmp());
  const a = join(tmp(), "a.db");
  seed(a).close();
  assert.equal(await hasUnpushedChanges(a), true);
  await pushIndex(store, { dbPath: a });
  assert.equal(await hasUnpushedChanges(a), false);

  const b = join(tmp(), "b.db");
  assert.equal(await pullIndex(store, b), true);
  const ib = new SkillIndex(b);
  assert.equal(ib.count(), 2);
  ib.addTags(ib.getBySlug("review-pr")!.id, ["browser"]);
  ib.close();
  assert.equal(await hasUnpushedChanges(b), true);
  await pushIndex(store, { dbPath: b });

  // a is now stale: its push must be refused unless forced.
  const ia = new SkillIndex(a);
  ia.remove(ia.getBySlug("review-pr")!.id);
  ia.close();
  await assert.rejects(pushIndex(store, { dbPath: a }), SyncConflictError);
  await pushIndex(store, { dbPath: a, force: true });
});

test("flow jobs run in the background and store the page", async () => {
  const dir = tmp();
  const store = new LocalBlobStore(join(dir, "blobs"));
  const index = seed(join(dir, "i.db"));
  const flows = new FlowService({
    store, generator: new StubFlowGenerator(20), jobsDbPath: ":memory:",
    findSkill: (s) => index.getBySlug(s),
    loadSources: async () => [{ path: "SKILL.md", content: "## Step one\n## Step two" }],
  });
  assert.deepEqual(await flows.status("review-pr"), { state: "none" });
  const job = flows.start("review-pr");
  assert.equal(flows.start("review-pr").id, job.id, "a second start joins the running job");
  assert.match((await flows.status("review-pr")).state, /queued|running/);
  assert.equal((await flows.waitFor(job.id, 5)).status, "succeeded");
  const st = await flows.status("review-pr");
  assert.equal(st.state, "ready");
  assert.match((await flows.getHtml("review-pr"))!, /Step two/);

  const bad = new FlowService({
    store, generator: new StubFlowGenerator(0), jobsDbPath: ":memory:",
    findSkill: (s) => index.getBySlug(s), loadSources: async () => [],
  });
  const failed = await bad.waitFor(bad.start("provision-cloud-agent").id, 5);
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /Could not read/);
});

test("stars: counted per skill, never negative, restored from storage", async () => {
  const store = new LocalBlobStore(tmp());
  const stars = new StarStore({ dbPath: ":memory:", store, key: "index/stars.json" });
  assert.equal(stars.get("review-pr"), 0);
  assert.equal(stars.change("review-pr", 1), 1);
  assert.equal(stars.change("review-pr", 1), 2);
  assert.equal(stars.change("provision-cloud-agent", 1), 1);
  assert.equal(stars.change("review-pr", -1), 1);
  assert.equal(stars.change("provision-cloud-agent", -1), 0);
  assert.equal(stars.change("provision-cloud-agent", -1), 0, "counts never go below zero");
  assert.deepEqual(stars.top(5).map((r) => [r.slug, r.count]), [["review-pr", 1]]);
  await stars.snapshot();

  const rebuilt = new StarStore({ dbPath: ":memory:", store, key: "index/stars.json" });
  await rebuilt.restore();
  assert.equal(rebuilt.get("review-pr"), 1, "counts survive a rebuilt volume");
});

test("HTTP API: stars, popular tab and favourites lookup", async () => {
  const dir = tmp();
  const dbPath = join(dir, "i.db");
  seed(dbPath).close();
  const holder = new IndexHolder(dbPath);
  const generator = new StubFlowGenerator(5);
  const stars = new StarStore({ dbPath: ":memory:" });
  const flows = new FlowService({
    store: new LocalBlobStore(join(dir, "blobs")), generator, jobsDbPath: ":memory:",
    findSkill: (s) => holder.current.getBySlug(s), loadSources: async () => [{ path: "SKILL.md", content: "x" }],
  });
  const app = createApp({ index: holder, flows, generator, stars });

  const post = (slug: string, body: unknown) =>
    app.request(`/api/skills/${slug}/star`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  assert.equal((await (await post("review-pr", { starred: true })).json()).stars, 1);
  await post("provision-cloud-agent", { starred: true });
  await post("provision-cloud-agent", { starred: true });
  assert.equal((await post("nope", { starred: true })).status, 404);

  const home = await (await app.request("/api/home")).json();
  assert.deepEqual(home.popular.map((s: { slug: string; stars: number }) => [s.slug, s.stars]), [["provision-cloud-agent", 2], ["review-pr", 1]]);
  assert.equal(home.stars["review-pr"], 1);

  const detail = await (await app.request("/api/skills/review-pr")).json();
  assert.equal(detail.stars, 1);
  assert.equal(detail.repoSkillCount, 1);
  const byRepo = await (await app.request(`/api/search?repo=${encodeURIComponent("https://github.com/acme/cloud-agents")}`)).json();
  assert.deepEqual(byRepo.results.map((s: { slug: string }) => s.slug), ["provision-cloud-agent"]);

  const favs = await (await app.request("/api/skills?slugs=review-pr,gone,provision-cloud-agent")).json();
  assert.deepEqual(favs.results.map((s: { slug: string }) => s.slug), ["review-pr", "provision-cloud-agent"]);

  assert.equal((await (await post("review-pr", { starred: false })).json()).stars, 0);
  assert.deepEqual((await (await app.request("/api/popular")).json()).results.map((s: { slug: string }) => s.slug), ["provision-cloud-agent"]);
});

test("HTTP API: home, search, detail, build and sandboxed flow page", async () => {
  const dir = tmp();
  const dbPath = join(dir, "i.db");
  seed(dbPath).close();
  const holder = new IndexHolder(dbPath);
  const generator = new StubFlowGenerator(10);
  const flows = new FlowService({
    store: new LocalBlobStore(join(dir, "blobs")), generator, jobsDbPath: ":memory:",
    findSkill: (s) => holder.current.getBySlug(s),
    loadSources: async () => [{ path: "SKILL.md", content: "## Only step" }],
  });
  const app = createApp({ index: holder, flows, generator, stars: new StarStore({ dbPath: ":memory:" }) });

  const home = await (await app.request("/api/home")).json();
  assert.equal(home.total, 2);
  assert.equal(home.recent[0].slug, "provision-cloud-agent");
  const search = await (await app.request("/api/search?q=railway")).json();
  assert.deepEqual(search.results.map((s: { slug: string }) => s.slug), ["provision-cloud-agent"]);

  assert.equal((await app.request("/api/skills/nope")).status, 404);
  const detail = await (await app.request("/api/skills/review-pr")).json();
  assert.equal(detail.flow.state, "none");
  assert.equal(detail.links.skillMd, "https://github.com/acme/skills/blob/main/review-pr/SKILL.md");
  assert.equal((await app.request("/flows/review-pr")).status, 404);

  const started = await app.request("/api/skills/review-pr/flow", { method: "POST" });
  assert.equal(started.status, 202);
  const { job } = await started.json();
  await flows.waitFor(job.id, 5);
  const polled = await (await app.request("/api/skills/review-pr/flow")).json();
  assert.equal(polled.state, "ready");
  assert.equal(polled.flow.model, "stub");

  const page = await app.request("/flows/review-pr");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy")!, /^sandbox allow-scripts/);
  assert.match(await page.text(), /skills-explorer:flow-height/);
});
