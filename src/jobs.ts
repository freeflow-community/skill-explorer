import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { secs, type Logger } from "./log.ts";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  slug: string;
  status: JobStatus;
  model: string;
  error: string | null;
  /** Human-readable description of what the job is doing right now. */
  progress: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What a job's work function gets: its row, a scoped logger, and ways to report where it is. */
export interface JobContext {
  job: Job;
  log: Logger;
  /** Update the progress line the UI polls. */
  progress(text: string): void;
  /** Coarse stage name, used in the failure message ("Failed while fetching sources"). */
  phase: string;
}

type Row = Record<string, string | null>;
const toJob = (r: Row): Job => ({
  id: r.id!,
  slug: r.slug!,
  status: r.status as JobStatus,
  model: r.model!,
  error: r.error,
  progress: r.progress ?? null,
  createdAt: r.created_at!,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

/**
 * Background jobs keyed by skill slug, one table per kind of job (flows, safety scores).
 * State lives in a small local SQLite file, never the synced index. Jobs run in this
 * process with a concurrency limit; at most one job per slug is queued or running.
 */
export class JobQueue {
  private db: DatabaseSync;
  private table: string;
  private log: Logger;
  private concurrency: number;
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(opts: { table: string; dbPath?: string; concurrency: number; log: Logger }) {
    if (!/^[a-z_]+$/.test(opts.table)) throw new Error(`bad job table name: ${opts.table}`);
    this.table = opts.table;
    this.log = opts.log;
    this.concurrency = Math.max(1, opts.concurrency);
    const path = opts.dbPath ?? config.jobsDbPath;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL,
        error TEXT, progress TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS ${this.table}_slug ON ${this.table}(slug, created_at);
    `);
    // The flow_jobs table predates the progress column.
    const cols = (this.db.prepare(`PRAGMA table_info(${this.table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("progress")) this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN progress TEXT`);
    // Jobs run in this process, so anything unfinished from a previous run is dead.
    const interrupted = this.db
      .prepare(`UPDATE ${this.table} SET status = 'failed', error = 'Interrupted by a server restart', finished_at = ? WHERE status IN ('queued', 'running')`)
      .run(new Date().toISOString()).changes;
    if (interrupted) this.log.warn("marked unfinished jobs from a previous run as failed", { count: Number(interrupted) });
  }

  latest(slug: string): Job | null {
    const r = this.db.prepare(`SELECT * FROM ${this.table} WHERE slug = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(slug) as Row | undefined;
    return r ? toJob(r) : null;
  }

  get(id: string): Job | null {
    const r = this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as Row | undefined;
    return r ? toJob(r) : null;
  }

  /** The queued or running job for a slug, if any. */
  active(slug: string): Job | null {
    const job = this.latest(slug);
    return job && (job.status === "queued" || job.status === "running") ? job : null;
  }

  /** Queue `work` for a slug, or return the job already in progress for it. */
  start(slug: string, model: string, work: (ctx: JobContext) => Promise<void>): Job {
    const active = this.active(slug);
    if (active) {
      this.log.info("job already in progress; returning it", { slug, job: active.id.slice(0, 8), status: active.status });
      return active;
    }
    const job: Job = {
      id: randomUUID(),
      slug,
      status: "queued",
      model,
      error: null,
      progress: "Queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.db
      .prepare(`INSERT INTO ${this.table} (id, slug, status, model, progress, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(job.id, slug, job.status, job.model, job.progress, job.createdAt);
    this.log.info("job queued", {
      slug, job: job.id.slice(0, 8), model,
      running: this.running, waiting: this.waiting.length, concurrency: this.concurrency,
    });
    void this.run(job.id, work);
    return job;
  }

  /** Resolves when the job finishes; used by the CLI and tests. */
  async waitFor(id: string, pollMs = 200): Promise<Job> {
    for (;;) {
      const job = this.get(id);
      if (!job) throw new Error(`Unknown job ${id}`);
      if (job.status === "succeeded" || job.status === "failed") return job;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private setProgress(id: string, text: string): void {
    this.db.prepare(`UPDATE ${this.table} SET progress = ? WHERE id = ?`).run(text, id);
  }

  private setStatus(id: string, status: JobStatus, error?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE ${this.table} SET status = ?, error = ?, ${status === "running" ? "started_at" : "finished_at"} = ? WHERE id = ?`)
      .run(status, error ?? null, now, id);
  }

  private async acquire(log: Logger): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    log.info("waiting for a free slot", { running: this.running, concurrency: this.concurrency, ahead: this.waiting.length });
    await new Promise<void>((r) => this.waiting.push(r));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }

  private async run(id: string, work: (ctx: JobContext) => Promise<void>): Promise<void> {
    const queued = this.get(id)!;
    const log = this.log.child(`${queued.slug} ${id.slice(0, 8)}`);
    const t0 = performance.now();
    await this.acquire(log);
    const ctx: JobContext = { job: queued, log, progress: (text) => this.setProgress(id, text), phase: "starting" };
    try {
      this.setStatus(id, "running");
      log.info("job started", { model: queued.model, queuedFor: secs(t0) });
      await work(ctx);
      this.setProgress(id, "Done");
      this.setStatus(id, "succeeded");
      log.info("job succeeded", { total: secs(t0) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(`job failed while ${ctx.phase}`, { error: e instanceof Error ? e : message, total: secs(t0) });
      this.setProgress(id, `Failed while ${ctx.phase}`);
      this.setStatus(id, "failed", message.slice(0, 2000));
    } finally {
      this.release();
    }
  }
}
