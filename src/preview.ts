import type { Skill } from "./db.ts";
import { fetchFile, parseRepo, parseSkillMd } from "./github.ts";
import { renderMarkdown } from "./markdown.ts";

/** A skill's SKILL.md, ready for the preview modal: its frontmatter as rows, its body as HTML. */
export interface SkillPreview {
  slug: string;
  path: string;
  url: string;
  /** Frontmatter keys in file order, values flattened to one line. */
  frontmatter: { key: string; value: string }[];
  html: string;
  bytes: number;
  fetchedAt: string;
}

/** Frontmatter values are usually strings, but a skill can put a list or a map there. */
function flatten(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join(", ");
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${flatten(v)}`).join(", ");
  return String(value).replace(/\s+/g, " ").trim();
}

/**
 * Reads a skill's SKILL.md from GitHub for the preview modal. Files are cached for a few
 * minutes: the same file is opened repeatedly, and GitHub rate-limits anonymous reads.
 */
export class PreviewService {
  private read: (skill: Skill) => Promise<string>;
  private ttlMs: number;
  private cache = new Map<string, { at: number; preview: SkillPreview }>();

  constructor(opts: { read?: (skill: Skill) => Promise<string>; ttlMs?: number } = {}) {
    this.read = opts.read ?? ((skill) => fetchFile(parseRepo(skill.repoUrl), skill.repoRef, skillMdPath(skill)));
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
  }

  async get(skill: Skill, url: string): Promise<SkillPreview> {
    const hit = this.cache.get(skill.slug);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.preview;

    const text = await this.read(skill);
    const { meta, body } = parseSkillMd(text);
    const preview: SkillPreview = {
      slug: skill.slug,
      path: skillMdPath(skill),
      url,
      frontmatter: Object.entries(meta).map(([key, value]) => ({ key, value: flatten(value) })),
      html: renderMarkdown(body),
      bytes: Buffer.byteLength(text),
      fetchedAt: new Date().toISOString(),
    };
    // Keep the map from growing without bound on a busy day; oldest entry goes first.
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(skill.slug, { at: Date.now(), preview });
    return preview;
  }
}

export const skillMdPath = (skill: Skill): string => (skill.path ? `${skill.path}/SKILL.md` : "SKILL.md");
