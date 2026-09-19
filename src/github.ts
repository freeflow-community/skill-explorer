import { parse as parseYaml } from "yaml";
import { config } from "./config.ts";

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
  if (t.truncated) console.warn(`warning: GitHub truncated the file tree of ${r.owner}/${r.repo}; some skills may be missed`);
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

export interface DiscoveredSkill {
  name: string;
  description: string;
  path: string;
  collection: string | null;
}

/** Find every SKILL.md in a repo (optionally under a sub-path) and read its frontmatter. */
export async function discoverSkills(r: RepoRef, ref: string, subPath?: string): Promise<DiscoveredSkill[]> {
  const prefix = subPath ? `${subPath.replace(/\/$/, "")}/` : "";
  const files = (await listTree(r, ref)).filter(
    (e) =>
      e.type === "blob" &&
      (e.path === "SKILL.md" || e.path.endsWith("/SKILL.md")) &&
      (!prefix || e.path.startsWith(prefix) || e.path === `${prefix}SKILL.md`) &&
      !e.path.split("/").some((seg) => seg === "node_modules" || seg.startsWith(".") && seg !== ".claude"),
  );
  const out: DiscoveredSkill[] = [];
  for (const f of files) {
    const { meta } = parseSkillMd(await fetchFile(r, ref, f.path));
    const dir = skillDir(f.path);
    out.push({
      name: String(meta.name ?? (dir.split("/").at(-1) || r.repo)).trim(),
      description: String(meta.description ?? "").replace(/\s+/g, " ").trim(),
      path: dir,
      collection: guessCollection(f.path),
    });
  }
  return out;
}

const TEXT_EXT = /\.(md|mdx|txt|sh|bash|zsh|py|ts|tsx|js|mjs|cjs|json|ya?ml|toml|html|css|sql)$/i;

/** Gather a skill's SKILL.md plus its text resources, largest-last, within a character budget. */
export async function fetchSkillSources(
  r: RepoRef,
  ref: string,
  dir: string,
  budget: number,
): Promise<{ path: string; content: string }[]> {
  const prefix = dir ? `${dir}/` : "";
  const skillMd = `${prefix}SKILL.md`;
  const entries = (await listTree(r, ref))
    .filter((e) => e.type === "blob" && (e.path.startsWith(prefix) || !prefix) && TEXT_EXT.test(e.path))
    // A root-level skill would otherwise pull in the whole repo; keep to one directory level there.
    .filter((e) => prefix || !e.path.includes("/") || e.path.split("/").length <= 3)
    .sort((a, b) => (a.path === skillMd ? -1 : b.path === skillMd ? 1 : (a.size ?? 0) - (b.size ?? 0)));
  const out: { path: string; content: string }[] = [];
  let used = 0;
  for (const e of entries) {
    if ((e.size ?? 0) > 100_000 && e.path !== skillMd) continue;
    if (used + (e.size ?? 0) > budget && e.path !== skillMd) continue;
    const content = await fetchFile(r, ref, e.path);
    used += content.length;
    out.push({ path: e.path.slice(prefix.length) || e.path, content });
  }
  return out;
}
