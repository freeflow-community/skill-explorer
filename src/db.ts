import { DatabaseSync } from "node:sqlite";

export interface Skill {
  id: number;
  slug: string;
  name: string;
  description: string;
  collection: string | null;
  repoUrl: string;
  repoRef: string;
  /** Directory of the SKILL.md inside the repo ("" for the repo root). */
  path: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SkillInput {
  name: string;
  description: string;
  collection: string | null;
  repoUrl: string;
  repoRef: string;
  path: string;
  tags?: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  collection TEXT,
  repo_url TEXT NOT NULL,
  repo_ref TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_url, path)
);
CREATE TABLE IF NOT EXISTS skill_tags (
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (skill_id, tag)
);
CREATE INDEX IF NOT EXISTS skill_tags_tag ON skill_tags(tag);
CREATE INDEX IF NOT EXISTS skills_created ON skills(created_at);
`;

const SELECT = `
SELECT s.*, (SELECT group_concat(tag, char(31)) FROM (SELECT tag FROM skill_tags t WHERE t.skill_id = s.id ORDER BY tag)) AS tag_list
FROM skills s`;

type Row = Record<string, string | number | null>;

function toSkill(r: Row): Skill {
  return {
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    description: r.description as string,
    collection: (r.collection as string | null) ?? null,
    repoUrl: r.repo_url as string,
    repoRef: r.repo_ref as string,
    path: r.path as string,
    tags: r.tag_list ? String(r.tag_list).split("\x1f") : [],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/[^a-z0-9+#.]+/g, "-").replace(/^-+|-+$/g, "");
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The skills index: one SQLite file, written by the CLI and read by the server. */
export class SkillIndex {
  readonly db: DatabaseSync;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (!opts.readOnly) {
      // Rollback journal (not WAL) so the file can be copied or swapped as a single unit.
      this.db.exec("PRAGMA journal_mode = DELETE;");
      this.db.exec(SCHEMA);
      this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
    }
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }

  private touch(): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('updated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.now());
  }

  private uniqueSlug(name: string, repoUrl: string): string {
    const taken = (s: string) => !!this.db.prepare("SELECT 1 FROM skills WHERE slug = ?").get(s);
    const base = slugify(name);
    if (!taken(base)) return base;
    const owner = repoUrl.split("/").at(-2) ?? "";
    const withOwner = slugify(`${name}-${owner}`);
    if (!taken(withOwner)) return withOwner;
    for (let i = 2; ; i++) if (!taken(`${withOwner}-${i}`)) return `${withOwner}-${i}`;
  }

  /** Insert a skill, or update it when the same repo + path is already indexed. */
  upsert(input: SkillInput): { skill: Skill; created: boolean } {
    const now = this.now();
    const existing = this.db
      .prepare("SELECT id FROM skills WHERE repo_url = ? AND path = ?")
      .get(input.repoUrl, input.path) as { id: number } | undefined;
    let id: number;
    if (existing) {
      id = existing.id;
      this.db
        .prepare("UPDATE skills SET name = ?, description = ?, collection = ?, repo_ref = ?, updated_at = ? WHERE id = ?")
        .run(input.name, input.description, input.collection, input.repoRef, now, id);
    } else {
      const slug = this.uniqueSlug(input.name, input.repoUrl);
      const res = this.db
        .prepare(
          "INSERT INTO skills (slug, name, description, collection, repo_url, repo_ref, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(slug, input.name, input.description, input.collection, input.repoUrl, input.repoRef, input.path, now, now);
      id = Number(res.lastInsertRowid);
    }
    if (input.tags) this.addTags(id, input.tags);
    this.touch();
    return { skill: this.getById(id)!, created: !existing };
  }

  addTags(id: number, tags: string[]): void {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO skill_tags (skill_id, tag) VALUES (?, ?)");
    for (const t of tags.map(normalizeTag).filter(Boolean)) stmt.run(id, t);
    this.touch();
  }

  removeTags(id: number, tags: string[]): void {
    const stmt = this.db.prepare("DELETE FROM skill_tags WHERE skill_id = ? AND tag = ?");
    for (const t of tags.map(normalizeTag)) stmt.run(id, t);
    this.touch();
  }

  setCollection(id: number, collection: string | null): void {
    this.db.prepare("UPDATE skills SET collection = ?, updated_at = ? WHERE id = ?").run(collection, this.now(), id);
    this.touch();
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    this.touch();
  }

  getById(id: number): Skill | null {
    const r = this.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    return r ? toSkill(r) : null;
  }

  getBySlug(slug: string): Skill | null {
    const r = this.db.prepare(`${SELECT} WHERE s.slug = ?`).get(slug) as Row | undefined;
    return r ? toSkill(r) : null;
  }

  recent(limit = 12): Skill[] {
    return (this.db.prepare(`${SELECT} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`).all(limit) as Row[]).map(toSkill);
  }

  all(): Skill[] {
    return (this.db.prepare(`${SELECT} ORDER BY s.name COLLATE NOCASE`).all() as Row[]).map(toSkill);
  }

  /** Every term must appear in the name or description; name matches rank first. */
  search(q: string, opts: { tag?: string; collection?: string; limit?: number } = {}): Skill[] {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const t of terms) {
      where.push("(lower(s.name) LIKE ? ESCAPE '\\' OR lower(s.description) LIKE ? ESCAPE '\\')");
      params.push(likeTerm(t), likeTerm(t));
    }
    if (opts.tag) {
      where.push("EXISTS (SELECT 1 FROM skill_tags t WHERE t.skill_id = s.id AND t.tag = ?)");
      params.push(normalizeTag(opts.tag));
    }
    if (opts.collection) {
      where.push("s.collection = ?");
      params.push(opts.collection);
    }
    const phrase = terms.join(" ");
    const sql = `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE
        WHEN ? = '' THEN 3
        WHEN lower(s.name) = ? THEN 0
        WHEN lower(s.name) LIKE ? ESCAPE '\\' THEN 1
        WHEN lower(s.name) LIKE ? ESCAPE '\\' THEN 2
        ELSE 3 END, s.name COLLATE NOCASE
      LIMIT ?`;
    params.push(phrase, phrase, `${phrase.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, likeTerm(terms[0] ?? ""), opts.limit ?? 100);
    return (this.db.prepare(sql).all(...params) as Row[]).map(toSkill);
  }

  tagCounts(): { tag: string; count: number }[] {
    return this.db
      .prepare("SELECT tag, count(*) AS count FROM skill_tags GROUP BY tag ORDER BY count DESC, tag")
      .all() as { tag: string; count: number }[];
  }

  collections(): { collection: string; count: number }[] {
    return this.db
      .prepare("SELECT collection, count(*) AS count FROM skills WHERE collection IS NOT NULL GROUP BY collection ORDER BY collection")
      .all() as { collection: string; count: number }[];
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM skills").get() as { n: number }).n;
  }
}
