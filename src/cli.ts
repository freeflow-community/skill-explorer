import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { config } from "./config.ts";
import { SkillIndex, normalizeTag, type Skill } from "./db.ts";
import { createGenerator } from "./flows/generator.ts";
import { FlowService } from "./flows/jobs.ts";
import { countSkills, defaultBranch, discoverSkills, parseRepo, repoUrl } from "./github.ts";
import { SyncConflictError, ensureLocalIndex, hasUnpushedChanges, pullIndex, pushIndex, readSyncState, remoteIsNewer } from "./indexSync.ts";
import { getStore } from "./storage.ts";
import { suggestTags } from "./tagger.ts";

const HELP = `Skills Explorer index tool

Usage: npm run cli -- <command> [options]

  register <repo> [<repo>...]   Find every SKILL.md in each GitHub repo and add or update it in the index
      --from-file <path>        Also read repos from a file: a CSV with a "repo" or "url" column, or one per line
      --max-skills <n>          Skip repos with more than n skills (see --allow-large)
      --allow-large a/b,c/d     Repos exempt from --max-skills
      --collection <name>       Collection for all skills found (default: guessed from plugins/<name>/skills/...)
      --tags a,b,c              Tags to add to every skill found
      --auto-tags               Ask the tagging model (TAG_MODEL) to suggest tags for each skill
      --path <dir>              Only look under this directory of the repo
      --ref <branch>            Branch or tag (default: the repo's default branch)
      --dry-run                 Show what would be registered without changing the index
      --push                    Push the index to storage afterwards
  list                          List every skill in the index
  show <slug>                   Show one skill
  tag <slug> +tag -tag ...      Add (+) or remove (-) tags
  rename-tag <old> [<new>]      Rename a tag on every skill (merging into <new>), or delete it if <new> is omitted
  set <slug> --collection <c>   Set a skill's collection (--collection "" clears it)
  remove <slug>                 Remove a skill from the index
  sync status|pull|push         Compare, download or upload the index (push --force overwrites)
  build-flow <slug>             Build a skill's visual flow now (instead of from the web page)

The index lives at ${config.indexDbPath}; storage is ${config.storage.backend}.
`;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function ensureGithubToken(): void {
  if (config.githubToken) return;
  try {
    config.githubToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // Unauthenticated GitHub requests still work, with a low rate limit.
  }
}

function describe(s: Skill): string {
  return [
    `${s.name}  (${s.slug})`,
    s.description && `  ${s.description}`,
    `  repo: ${s.repoUrl}${s.path ? ` › ${s.path}` : ""} @ ${s.repoRef}`,
    s.collection && `  collection: ${s.collection}`,
    s.tags.length ? `  tags: ${s.tags.join(", ")}` : "  tags: (none)",
  ]
    .filter(Boolean)
    .join("\n");
}

async function openIndex(): Promise<SkillIndex> {
  const store = getStore();
  const source = await ensureLocalIndex(store);
  if (source === "pulled") console.log(`Pulled the index from ${store.name}.`);
  if (source === "created") console.log(`Created a new, empty index at ${config.indexDbPath}.`);
  return new SkillIndex(config.indexDbPath);
}

function mustGet(index: SkillIndex, slug: string | undefined): Skill {
  if (!slug) fail("give a skill slug (see `list`)");
  return index.getBySlug(slug) ?? fail(`no skill "${slug}" in the index`);
}

async function push(force: boolean): Promise<void> {
  try {
    const { etag } = await pushIndex(getStore(), { force });
    console.log(`Pushed the index to ${getStore().name} (etag ${etag}).`);
  } catch (e) {
    if (e instanceof SyncConflictError) fail(e.message);
    throw e;
  }
}

const pushHint = () => console.log("\nThe index changed locally. Run `npm run cli -- sync push` to publish it.");

/** Repos from a CSV (first "repo" or "url" column) or a plain one-per-line list. */
export function readRepoFile(path: string): string[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  const header = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const col = header.findIndex((h) => h === "repo" || h === "url");
  if (col < 0) return lines.map((l) => l.trim());
  return lines.slice(1).map((l) => (l.split(",")[col] ?? "").trim().replace(/^"|"$/g, "")).filter(Boolean);
}

async function register(args: string[], v: Record<string, string | boolean | undefined>): Promise<void> {
  const repos = [...args, ...(v["from-file"] ? readRepoFile(String(v["from-file"])) : [])];
  if (!repos.length) fail("give at least one GitHub repo, e.g. `register anthropics/skills`");
  const maxSkills = v["max-skills"] !== undefined ? Number(v["max-skills"]) : Infinity;
  const allowLarge = new Set(String(v["allow-large"] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const skipped: string[] = [];
  ensureGithubToken();
  const index = await openIndex();
  let changed = false;
  try {
    for (const input of repos) {
      const r = parseRepo(input);
      const ref = (v.ref as string) || r.ref || (await defaultBranch(r));
      const subPath = (v.path as string) || r.subPath;
      console.log(`\n${r.owner}/${r.repo} @ ${ref}${subPath ? ` › ${subPath}` : ""}`);
      if (Number.isFinite(maxSkills) && !allowLarge.has(`${r.owner}/${r.repo}`.toLowerCase())) {
        const n = await countSkills(r, ref, subPath);
        if (n > maxSkills) {
          console.log(`  Skipped: ${n} skills is more than --max-skills ${maxSkills}.`);
          skipped.push(`${r.owner}/${r.repo} (${n})`);
          continue;
        }
      }
      const found = await discoverSkills(r, ref, subPath);
      if (!found.length) {
        console.log("  No SKILL.md files found.");
        continue;
      }
      const manual = String(v.tags ?? "").split(",").map(normalizeTag).filter(Boolean);
      let auto = new Map<string, string[]>();
      if (v["auto-tags"]) {
        process.stdout.write(`  Suggesting tags with ${config.tagModel}… `);
        auto = await suggestTags(found, index.tagCounts().map((t) => t.tag));
        console.log("done");
      }
      for (const s of found) {
        const collection = v.collection !== undefined ? (v.collection as string) || null : s.collection;
        const tags = [...new Set([...manual, ...(auto.get(s.name) ?? [])])];
        if (v["dry-run"]) {
          console.log(`  would register ${s.name}${collection ? ` [${collection}]` : ""}${tags.length ? `  tags: ${tags.join(", ")}` : ""}`);
          continue;
        }
        const { skill, created } = index.upsert({
          name: s.name,
          description: s.description,
          collection,
          repoUrl: repoUrl(r),
          repoRef: ref,
          path: s.path,
          tags,
        });
        changed = true;
        console.log(`  ${created ? "added  " : "updated"} ${skill.slug}${skill.tags.length ? `  tags: ${skill.tags.join(", ")}` : ""}`);
      }
    }
  } finally {
    index.close();
  }
  if (skipped.length) console.log(`\nSkipped ${skipped.length} large repo(s): ${skipped.join(", ")}`);
  if (!changed) return;
  if (v.push) await push(false);
  else pushHint();
}

async function sync(action: string | undefined, force: boolean): Promise<void> {
  const store = getStore();
  if (action === "push") return push(force);
  if (action === "pull") {
    if (!force && (await hasUnpushedChanges())) fail("the local index has unpushed changes; push them first, or `sync pull --force` to discard them");
    if (!(await pullIndex(store))) fail(`${store.name} has no index yet; register some skills and push`);
    console.log(`Pulled the index from ${store.name}.`);
    return;
  }
  if (action === "status" || !action) {
    const state = await readSyncState();
    const remote = await store.head(config.storage.indexKey);
    console.log(`local:   ${config.indexDbPath}${state ? `  (last ${state.direction} ${state.at})` : "  (never synced)"}`);
    console.log(`storage: ${store.name}/${config.storage.indexKey}${remote ? "" : "  (none yet)"}`);
    if (await hasUnpushedChanges()) console.log("→ local changes not yet pushed");
    if (remote && (await remoteIsNewer(store))) console.log("→ storage has a newer index than the one last synced here");
    return;
  }
  fail(`unknown sync action "${action}" (status, pull or push)`);
}

async function buildFlow(slug: string | undefined): Promise<void> {
  ensureGithubToken();
  const index = await openIndex();
  const skill = mustGet(index, slug);
  const generator = createGenerator();
  const flows = new FlowService({ store: getStore(), generator, findSkill: (s) => index.getBySlug(s) });
  console.log(`Building the visual flow for ${skill.slug} with ${generator.model}…`);
  const job = await flows.waitFor(flows.start(skill.slug).id, 1000);
  index.close();
  if (job.status === "failed") fail(job.error ?? "build failed");
  console.log(`Done. Stored ${flows.htmlKey(skill.slug)} in ${getStore().name}.`);
}

async function main(): Promise<void> {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      collection: { type: "string" },
      tags: { type: "string" },
      "auto-tags": { type: "boolean" },
      "from-file": { type: "string" },
      "max-skills": { type: "string" },
      "allow-large": { type: "string" },
      path: { type: "string" },
      ref: { type: "string" },
      "dry-run": { type: "boolean" },
      push: { type: "boolean" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    // `tag <slug> -old` passes tag removals that look like flags.
    strict: false,
  });
  const [cmd, ...args] = positionals;
  if (!cmd || v.help) {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "register":
      return register(args, v as Record<string, string | boolean | undefined>);
    case "sync":
      return sync(args[0], !!v.force);
    case "build-flow":
      return buildFlow(args[0]);
  }

  const index = await openIndex();
  try {
    switch (cmd) {
      case "list": {
        const all = index.all();
        if (v.json) console.log(JSON.stringify(all, null, 2));
        else if (!all.length) console.log("The index is empty. Add skills with `register <repo>`.");
        else for (const s of all) console.log(`${s.slug.padEnd(32)} ${s.collection ? `[${s.collection}] ` : ""}${s.tags.join(", ")}`);
        return;
      }
      case "show":
        console.log(describe(mustGet(index, args[0])));
        return;
      case "tag": {
        const skill = mustGet(index, args[0]);
        // parseArgs puts "-foo" style tokens into values when strict is off, so read the raw argv.
        const raw = process.argv.slice(process.argv.indexOf(args[0]!) + 1);
        const add = raw.filter((t) => t.startsWith("+")).map((t) => t.slice(1));
        const remove = raw.filter((t) => t.startsWith("-")).map((t) => t.replace(/^-+/, ""));
        if (!add.length && !remove.length) fail("give tags to add (+tag) or remove (-tag)");
        index.addTags(skill.id, add);
        index.removeTags(skill.id, remove);
        console.log(describe(index.getById(skill.id)!));
        pushHint();
        return;
      }
      case "rename-tag": {
        if (!args[0]) fail("give the tag to rename, e.g. `rename-tag development-tools developer-tools`");
        const n = index.renameTag(args[0], args[1] ?? null);
        console.log(args[1] ? `Renamed "${args[0]}" to "${args[1]}" on ${n} skill(s).` : `Removed "${args[0]}" from ${n} skill(s).`);
        pushHint();
        return;
      }
      case "set": {
        const skill = mustGet(index, args[0]);
        if (v.collection === undefined) fail("nothing to set; use --collection <name>");
        index.setCollection(skill.id, (v.collection as string) || null);
        console.log(describe(index.getById(skill.id)!));
        pushHint();
        return;
      }
      case "remove": {
        const skill = mustGet(index, args[0]);
        index.remove(skill.id);
        console.log(`Removed ${skill.slug}. Its visual flow (if any) stays in storage.`);
        pushHint();
        return;
      }
      default:
        fail(`unknown command "${cmd}"\n\n${HELP}`);
    }
  } finally {
    index.close();
  }
}

await main();
