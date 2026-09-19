import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { createLogger } from "./log.ts";
import type { BlobStore } from "./storage.ts";

const log = createLogger("stars");
/** How long to batch star changes before snapshotting them to blob storage. */
const SNAPSHOT_DELAY_MS = 30_000;

/**
 * Star counts per skill. Visitors keep their own stars in the browser; the server only
 * keeps totals. They live in a local SQLite file (on the Railway volume) and are
 * snapshotted to blob storage, so a rebuilt volume doesn't lose them.
 */
export class StarStore {
  private db: DatabaseSync;
  private store: BlobStore | null;
  private key: string;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(opts: { dbPath?: string; store?: BlobStore | null; key?: string } = {}) {
    const path = opts.dbPath ?? config.starsDbPath;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS skill_stars (
        slug TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    this.store = opts.store ?? null;
    this.key = opts.key ?? config.storage.starsKey;
  }

  /** Load counts from storage when this instance has none yet (fresh or rebuilt volume). */
  async restore(): Promise<void> {
    if (!this.store || this.total() > 0) return;
    const blob = await this.store.get(this.key);
    if (!blob) return;
    const counts = JSON.parse(blob.body.toString("utf8")) as Record<string, number>;
    const stmt = this.db.prepare("INSERT OR REPLACE INTO skill_stars (slug, count, updated_at) VALUES (?, ?, ?)");
    const now = new Date().toISOString();
    for (const [slug, count] of Object.entries(counts)) stmt.run(slug, count, now);
    log.info("restored star counts from storage", { skills: Object.keys(counts).length, key: this.key });
  }

  private total(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM skill_stars").get() as { n: number }).n;
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT slug, count FROM skill_stars WHERE count > 0").all() as { slug: string; count: number }[];
    return Object.fromEntries(rows.map((r) => [r.slug, r.count]));
  }

  get(slug: string): number {
    const r = this.db.prepare("SELECT count FROM skill_stars WHERE slug = ?").get(slug) as { count: number } | undefined;
    return r?.count ?? 0;
  }

  /** Apply +1 or -1 and return the new count (never negative). */
  change(slug: string, delta: 1 | -1): number {
    this.db
      .prepare(
        `INSERT INTO skill_stars (slug, count, updated_at) VALUES (?, max(0, ?), ?)
         ON CONFLICT(slug) DO UPDATE SET count = max(0, count + ?), updated_at = excluded.updated_at`,
      )
      .run(slug, delta, new Date().toISOString(), delta);
    this.scheduleSnapshot();
    return this.get(slug);
  }

  /** Slugs ordered by stars, most first. */
  top(limit = 12): { slug: string; count: number }[] {
    return this.db
      .prepare("SELECT slug, count FROM skill_stars WHERE count > 0 ORDER BY count DESC, slug LIMIT ?")
      .all(limit) as { slug: string; count: number }[];
  }

  private scheduleSnapshot(): void {
    this.dirty = true;
    if (!this.store || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.snapshot();
    }, SNAPSHOT_DELAY_MS);
    this.timer.unref();
  }

  /** Write current counts to blob storage. */
  async snapshot(): Promise<void> {
    if (!this.store || !this.dirty) return;
    this.dirty = false;
    try {
      const counts = this.counts();
      await this.store.put(this.key, JSON.stringify(counts), "application/json");
      log.debug("snapshotted star counts", { skills: Object.keys(counts).length });
    } catch (e) {
      this.dirty = true;
      log.warn("could not snapshot star counts", { error: e instanceof Error ? e : String(e) });
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.db.close();
  }
}
