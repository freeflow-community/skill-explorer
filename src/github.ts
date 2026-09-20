import { parse as parseYaml } from "yaml";
import { config } from "./config.ts";
import { createLogger, type Logger } from "./log.ts";

const ghLog = createLogger("github");

export interface RepoRef {
  owner: string;
  repo: string;
  /** Branch/tag from a /tree/<ref>/ URL, if given. */
  ref?: string;
  /** Sub-path from a /tree/<ref>/<path> URL, if given. */
  subPath?: string;
}

/** Accepts owner/repo, https URLs (including /tree/<ref>/<path>), and git@ remotes. */
export function parseRepo(input: string): RepoRef {
  const s = input.trim().replace(/\.git$/, "");
  let m = s.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
  if (m) return { owner: m[1]!, repo: m[2]! };
  m = s.match(/^(?:https?:\/\/)?github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/);
  if (m) return { owner: m[1]!, repo: m[2]!, ref: m[3], subPath: m[4]?.replace(/\/$/, "") };
  m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m) return { owner: m[1]!, repo: m[2]! };
  throw new Error(`Not a GitHub repository: ${input}`);
}

export const repoUrl = (r: RepoRef) => `https://github.com/${r.owner}/${r.repo}`;

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "skills-explorer",
      ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}),
    },
  });
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? " (rate limited? set GITHUB_TOKEN)" : "";
    throw new Error(`GitHub ${path}: ${res.status} ${res.statusText}${hint}`);
  }
  return (await res.json()) as T;
}

export async function defaultBranch(r: RepoRef): Promise<string> {
  return (await gh<{ default_branch: string }>(`/repos/${r.owner}/${r.repo}`)).default_branch;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

export async function listTree(r: RepoRef, ref: string): Promise<TreeEntry[]> {
  const t = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  if (t.truncated) ghLog.warn("GitHub truncated the file tree; some files may be missed", { repo: `${r.owner}/${r.repo}`, ref });
  return t.tree;
}

export async function fetchFile(r: RepoRef, ref: string, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${encodeURIComponent(ref)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const res = await fetch(url, {
    headers: config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {},
  });
  if (!res.ok) throw new Error(`GitHub raw ${path}: ${res.status} ${res.statusText}`);
  return res.text();
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  [k: string]: unknown;
}

/** Split a SKILL.md into its YAML frontmatter and markdown body. */
export function parseSkillMd(text: string): { meta: SkillFrontmatter; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  let meta: SkillFrontmatter = {};
  try {
    const parsed = parseYaml(m[1]!);
    if (parsed && typeof parsed === "object") meta = parsed as SkillFrontmatter;
  } catch {
    // Malformed frontmatter: fall back to directory name and no description.
  }
  return { meta, body: m[2]! };
}

export function skillDir(skillMdPath: string): string {
  return skillMdPath.includes("/") ? skillMdPath.slice(0, skillMdPath.lastIndexOf("/")) : "";
}

/** Guess a collection from common layouts, e.g. plugins/<name>/skills/<skill>/SKILL.md. */
export function guessCollection(skillMdPath: string): string | null {
  const m = skillMdPath.match(/(?:^|\/)plugins\/([^/]+)\/skills\//);
  return m ? m[1]! : null;
}

/** Directories whose SKILL.md files are test data or vendored copies, not skills the repo offers. */
const IGNORED_DIRS = new Set([".git", "node_modules", "test", "tests", "__tests__", "fixtures", "__fixtures__", "testdata", "test-data"]);

/** True for a SKILL.md path that should be indexed (optionally only under `subPath`). */
export function isSkillPath(path: string, subPath?: string): boolean {
  if (path !== "SKILL.md" && !path.endsWith("/SKILL.md")) return false;
  const prefix = subPath ? `${subPath.replace(/\/$/, "")}/` : "";
  if (prefix && !path.startsWith(prefix)) return false;
  return !path.split("/").slice(0, -1).some((seg) => IGNORED_DIRS.has(seg));
}

/** Count indexable SKILL.md files without downloading them. */
export async function countSkills(r: RepoRef, ref: string, subPath?: string): Promise<number> {
  return (await listTree(r, ref)).filter((e) => e.type === "blob" && isSkillPath(e.path, subPath)).length;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  path: string;
  collection: string | null;
}

/** Find every SKILL.md in a repo (optionally under a sub-path) and read its frontmatter. */
export async function discoverSkills(r: RepoRef, ref: string, subPath?: string): Promise<DiscoveredSkill[]> {
  const hidden = (p: string) => p.split("/").some((seg) => seg.startsWith("."));
  // Visible paths first, so a skill also committed as an installed copy (e.g. .claude/skills/x) keeps its real location.
  const files = (await listTree(r, ref))
    .filter((e) => e.type === "blob" && isSkillPath(e.path, subPath))
    .sort((a, b) => Number(hidden(a.path)) - Number(hidden(b.path)));
  const out: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const { meta } = parseSkillMd(await fetchFile(r, ref, f.path));
    const dir = skillDir(f.path);
    const name = String(meta.name ?? (dir.split("/").at(-1) || r.repo)).trim();
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({
      name,
      description: String(meta.description ?? "").replace(/\s+/g, " ").trim(),
      path: dir,
      collection: guessCollection(f.path),
    });
  }
  return out;
}

const TEXT_EXT = /\.(md|mdx|txt|sh|bash|zsh|py|ts|tsx|js|mjs|cjs|json|ya?ml|toml|html|css|sql)$/i;

/** Every file under a skill's directory (repo-relative paths, with sizes). A root-level skill keeps to one directory level. */
export async function listSkillFiles(r: RepoRef, ref: string, dir: string): Promise<TreeEntry[]> {
  const prefix = dir ? `${dir}/` : "";
  return (await listTree(r, ref))
    .filter((e) => e.type === "blob" && (e.path.startsWith(prefix) || !prefix))
    // A root-level skill would otherwise pull in the whole repo; keep to one directory level there.
    .filter((e) => prefix || !e.path.includes("/") || e.path.split("/").length <= 3);
}

/** Path of a file relative to the skill directory. */
export const relativeToSkill = (path: string, dir: string): string => (dir ? path.slice(dir.length + 1) || path : path);

/**
 * Gather a skill's SKILL.md plus its text resources, largest-last, within a character budget.
 * `pattern` picks which files count as text (default: the flow builder's set); `entries` skips the tree fetch.
 */
export async function fetchSkillSources(
  r: RepoRef,
  ref: string,
  dir: string,
  budget: number,
  log?: Logger,
  opts: { pattern?: RegExp | ((path: string) => boolean); entries?: TreeEntry[] } = {},
): Promise<{ path: string; content: string }[]> {
  const prefix = dir ? `${dir}/` : "";
  const skillMd = `${prefix}SKILL.md`;
  const pattern = opts.pattern ?? TEXT_EXT;
  const isText = typeof pattern === "function" ? pattern : (p: string) => pattern.test(p);
  const entries = (opts.entries ?? (await listSkillFiles(r, ref, dir)))
    .filter((e) => e.type === "blob" && isText(e.path))
    .sort((a, b) => (a.path === skillMd ? -1 : b.path === skillMd ? 1 : (a.size ?? 0) - (b.size ?? 0)));
  const out: { path: string; content: string }[] = [];
  let used = 0;
  for (const e of entries) {
    if ((e.size ?? 0) > 100_000 && e.path !== skillMd) {
      log?.info("skipping large file", { path: e.path, bytes: e.size });
      continue;
    }
    if (used + (e.size ?? 0) > budget && e.path !== skillMd) {
      log?.info("skipping file: over the source budget", { path: e.path, bytes: e.size, budget });
      continue;
    }
    const content = await fetchFile(r, ref, e.path);
    used += content.length;
    log?.debug("fetched file", { path: e.path, chars: content.length });
    out.push({ path: relativeToSkill(e.path, dir), content });
  }
  return out;
}
