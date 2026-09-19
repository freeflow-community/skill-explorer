import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";
import type { Skill } from "../db.ts";
import { fetchSkillSources, parseRepo } from "../github.ts";
import type { BlobStore } from "../storage.ts";
import type { FlowGenerator, SourceFile } from "./generator.ts";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface FlowJob {
  id: string;
  slug: string;
  status: JobStatus;
  model: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Stored next to each flow page as flows/<slug>.json. */
export interface FlowMeta {
  slug: string;
  model: string;
  builtAt: string;
  jobId: string;
  sourceFiles: string[];
  usage?: { inputTokens: number; outputTokens: number };
}

export type FlowState =
  | { state: "none" }
  | { state: "queued" | "running"; job: FlowJob; flow?: FlowMeta }
  | { state: "ready"; flow: FlowMeta; job?: FlowJob }
  | { state: "failed"; job: FlowJob; flow?: FlowMeta };

type Row = Record<string, string | null>;
const toJob = (r: Row): FlowJob => ({
  id: r.id!,
  slug: r.slug!,
  status: r.status as JobStatus,
  model: r.model!,
  error: r.error,
  createdAt: r.created_at!,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

/**
 * Builds visual flows in the background. Job state lives in a small local SQLite file
 * (not the synced index, so the server never writes the index); finished flows go to blob storage.
 */
export class FlowService {
  private db: DatabaseSync;
  private store: BlobStore;
  private generator: FlowGenerator;
  private findSkill: (slug: string) => Skill | null;
  private loadSources: (skill: Skill) => Promise<SourceFile[]>;
  private running = 0;
  private waiting: (() => void)[] = [];
  private metaCache = new Map<string, { meta: FlowMeta | null; at: number }>();

  constructor(opts: {
    store: BlobStore;
    generator: FlowGenerator;
    findSkill: (slug: string) => Skill | null;
    jobsDbPath?: string;
    loadSources?: (skill: Skill) => Promise<SourceFile[]>;
  }) {
    const path = opts.jobsDbPath ?? config.jobsDbPath;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS flow_jobs (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL,
        error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS flow_jobs_slug ON flow_jobs(slug, created_at);
    `);
    // Jobs run in this process, so anything unfinished from a previous run is dead.
    this.db
      .prepare("UPDATE flow_jobs SET status = 'failed', error = 'Interrupted by a server restart', finished_at = ? WHERE status IN ('queued', 'running')")
      .run(new Date().toISOString());
    this.store = opts.store;
    this.generator = opts.generator;
    this.findSkill = opts.findSkill;
    this.loadSources =
      opts.loadSources ??
      ((skill) => fetchSkillSources(parseRepo(skill.repoUrl), skill.repoRef, skill.path, config.flow.sourceBudget));
  }

  get model(): string {
    return this.generator.model;
  }

  htmlKey(slug: string): string {
    return `${config.storage.flowPrefix}${slug}.html`;
  }
  metaKey(slug: string): string {
    return `${config.storage.flowPrefix}${slug}.json`;
  }

  private latestJob(slug: string): FlowJob | null {
    const r = this.db.prepare("SELECT * FROM flow_jobs WHERE slug = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(slug) as Row | undefined;
    return r ? toJob(r) : null;
  }

  getJob(id: string): FlowJob | null {
    const r = this.db.prepare("SELECT * FROM flow_jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? toJob(r) : null;
  }

  async getMeta(slug: string): Promise<FlowMeta | null> {
    const cached = this.metaCache.get(slug);
    // Found flows are cached until rebuilt; misses are re-checked each minute in case another server built one.
    if (cached && (cached.meta || Date.now() - cached.at < 60_000)) return cached.meta;
    const blob = await this.store.get(this.metaKey(slug));
    const meta = blob ? (JSON.parse(blob.body.toString("utf8")) as FlowMeta) : null;
    this.metaCache.set(slug, { meta, at: Date.now() });
    return meta;
  }

  async getHtml(slug: string): Promise<string | null> {
    const blob = await this.store.get(this.htmlKey(slug));
    return blob ? blob.body.toString("utf8") : null;
  }

  async status(slug: string): Promise<FlowState> {
    const [job, flow] = [this.latestJob(slug), await this.getMeta(slug)];
    if (job && (job.status === "queued" || job.status === "running")) return { state: job.status, job, ...(flow ? { flow } : {}) };
    if (job?.status === "failed" && (!flow || job.createdAt > flow.builtAt)) return { state: "failed", job, ...(flow ? { flow } : {}) };
    if (flow) return { state: "ready", flow, ...(job ? { job } : {}) };
    return { state: "none" };
  }

  /** Queue a build, or return the one already in progress for this skill. */
  start(slug: string): FlowJob {
    if (!this.findSkill(slug)) throw new Error(`Unknown skill: ${slug}`);
    const active = this.latestJob(slug);
    if (active && (active.status === "queued" || active.status === "running")) return active;
    const job: FlowJob = {
      id: randomUUID(),
      slug,
      status: "queued",
      model: this.generator.model,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.db
      .prepare("INSERT INTO flow_jobs (id, slug, status, model, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(job.id, slug, job.status, job.model, job.createdAt);
    void this.run(job.id);
    return job;
  }

  /** Resolves when the job finishes; used by the CLI and tests. */
  async waitFor(id: string, pollMs = 200): Promise<FlowJob> {
    for (;;) {
      const job = this.getJob(id);
      if (!job) throw new Error(`Unknown job ${id}`);
      if (job.status === "succeeded" || job.status === "failed") return job;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < Math.max(1, config.flow.concurrency)) {
      this.running++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r));
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }

  private async run(id: string): Promise<void> {
    await this.acquire();
    const set = (status: JobStatus, extra: { error?: string } = {}) => {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE flow_jobs SET status = ?, error = ?, ${status === "running" ? "started_at" : "finished_at"} = ? WHERE id = ?`,
        )
        .run(status, extra.error ?? null, now, id);
    };
    try {
      const job = this.getJob(id)!;
      const skill = this.findSkill(job.slug);
      if (!skill) throw new Error(`Skill ${job.slug} is no longer in the index`);
      set("running");
      const sources = await this.loadSources(skill);
      if (!sources.length) throw new Error("Could not read any files for this skill from GitHub");
      const flow = await this.generator.generate(skill, sources);
      const meta: FlowMeta = {
        slug: skill.slug,
        model: flow.model,
        builtAt: new Date().toISOString(),
        jobId: id,
        sourceFiles: sources.map((s) => s.path),
        ...(flow.usage ? { usage: flow.usage } : {}),
      };
      await this.store.put(this.htmlKey(skill.slug), flow.html, "text/html; charset=utf-8");
      await this.store.put(this.metaKey(skill.slug), JSON.stringify(meta, null, 2), "application/json");
      this.metaCache.set(skill.slug, { meta, at: Date.now() });
      set("succeeded");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`flow job ${id} failed:`, message);
      set("failed", { error: message.slice(0, 2000) });
    } finally {
      this.release();
    }
  }
}
