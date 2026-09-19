import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SkillIndex } from "../src/db.ts";
import { extractHtml, StubFlowGenerator } from "../src/flows/generator.ts";
import { FlowService } from "../src/flows/jobs.ts";
import { guessCollection, parseRepo, parseSkillMd } from "../src/github.ts";
import { hasUnpushedChanges, pullIndex, pushIndex, SyncConflictError } from "../src/indexSync.ts";
import { createApp, IndexHolder } from "../src/server.ts";
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
  assert.deepEqual(index.tagCounts().map((t) => t.tag).sort(), ["agents", "aws", "github", "qa"]);
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

test("extractHtml strips fences and surrounding prose", () => {
  assert.equal(extractHtml("```html\n<!doctype html><html><body>x</body></html>\n```"), "<!doctype html><html><body>x</body></html>");
  assert.equal(extractHtml("Here:\n<!DOCTYPE html>\n<html></html> done"), "<!DOCTYPE html>\n<html></html>");
  assert.throws(() => extractHtml("<html><body>cut off"));
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
  const app = createApp({ index: holder, flows, generator });

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
