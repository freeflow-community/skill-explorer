import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.ts";
import type { Skill } from "../db.ts";
import { fetchSkillSources, parseRepo } from "../github.ts";
import { log as rootLog, secs, type Logger } from "../log.ts";
import type { BlobStore } from "../storage.ts";
import type { FlowGenerator, GeneratedFlow, GenerationProgress, SourceFile } from "./generator.ts";
import { validateFlowHtml } from "./validate.ts";

const HEARTBEAT_MS = 15_000;
/** One regeneration when the first page fails validation. */
const MAX_ATTEMPTS = 2;

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
function fmtChars(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface FlowJob {
  id: string;
  slug: string;
  status: JobStatus;
  model: string;
  error: string | null;
  /** Human-readable description of what the build is doing right now. */
  progress: string | null;
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
  progress: r.progress ?? null,
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
  private loadSources: (skill: Skill, log: Logger) => Promise<SourceFile[]>;
  private log: Logger;
  private running = 0;
  private waiting: (() => void)[] = [];
  private metaCache = new Map<string, { meta: FlowMeta | null; at: number }>();

  constructor(opts: {
    store: BlobStore;
    generator: FlowGenerator;
    findSkill: (slug: string) => Skill | null;
    jobsDbPath?: string;
    loadSources?: (skill: Skill, log: Logger) => Promise<SourceFile[]>;
    log?: Logger;
  }) {
    this.log = opts.log ?? rootLog.child("flows");
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
    const cols = (this.db.prepare("PRAGMA table_info(flow_jobs)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("progress")) this.db.exec("ALTER TABLE flow_jobs ADD COLUMN progress TEXT");
    // Jobs run in this process, so anything unfinished from a previous run is dead.
    const interrupted = this.db
      .prepare("UPDATE flow_jobs SET status = 'failed', error = 'Interrupted by a server restart', finished_at = ? WHERE status IN ('queued', 'running')")
      .run(new Date().toISOString()).changes;
    if (interrupted) this.log.warn("marked unfinished builds from a previous run as failed", { count: Number(interrupted) });
    this.store = opts.store;
    this.generator = opts.generator;
    this.findSkill = opts.findSkill;
    this.loadSources =
      opts.loadSources ??
      ((skill, log) => fetchSkillSources(parseRepo(skill.repoUrl), skill.repoRef, skill.path, config.flow.sourceBudget, log));
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
    if (active && (active.status === "queued" || active.status === "running")) {
      this.log.info("build already in progress; returning it", { slug, job: active.id.slice(0, 8), status: active.status });
      return active;
    }
    const job: FlowJob = {
      id: randomUUID(),
      slug,
      status: "queued",
      model: this.generator.model,
      error: null,
      progress: "Queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.db
      .prepare("INSERT INTO flow_jobs (id, slug, status, model, progress, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(job.id, slug, job.status, job.model, job.progress, job.createdAt);
    this.log.info("build queued", {
      slug, job: job.id.slice(0, 8), model: job.model,
      running: this.running, waiting: this.waiting.length, concurrency: config.flow.concurrency,
    });
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

  private async acquire(log: Logger): Promise<void> {
    if (this.running < Math.max(1, config.flow.concurrency)) {
      this.running++;
      return;
    }
    log.info("waiting for a free build slot", { running: this.running, concurrency: config.flow.concurrency, ahead: this.waiting.length });
    await new Promise<void>((r) => this.waiting.push(r));
  }

  private setProgress(id: string, text: string): void {
    this.db.prepare("UPDATE flow_jobs SET progress = ? WHERE id = ?").run(text, id);
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }

  private async run(id: string): Promise<void> {
    const queuedJob = this.getJob(id)!;
    const log = this.log.child(`${queuedJob.slug} ${id.slice(0, 8)}`);
    const t0 = performance.now();
    await this.acquire(log);
    const set = (status: JobStatus, extra: { error?: string } = {}) => {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE flow_jobs SET status = ?, error = ?, ${status === "running" ? "started_at" : "finished_at"} = ? WHERE id = ?`,
        )
        .run(status, extra.error ?? null, now, id);
    };
    let phase = "starting";
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      const skill = this.findSkill(queuedJob.slug);
      if (!skill) throw new Error(`Skill ${queuedJob.slug} is no longer in the index`);
      set("running");
      log.info("build started", { model: this.generator.model, repo: skill.repoUrl, path: skill.path || "/", ref: skill.repoRef, queuedFor: secs(t0) });

      phase = "fetching sources";
      this.setProgress(id, "Reading the skill's files from GitHub");
      const tFetch = performance.now();
      const sources = await this.loadSources(skill, log);
      if (!sources.length) throw new Error("Could not read any files for this skill from GitHub");
      const chars = sources.reduce((n, f) => n + f.content.length, 0);
      log.info("fetched skill sources", { files: sources.length, chars, took: secs(tFetch), paths: sources.map((f) => f.path).join(",") });

      phase = "generating";
      let flow: GeneratedFlow | undefined;
      let feedback: string[] = [];
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const attemptLog = attempt > 1 ? log.child(`attempt ${attempt}`) : log;
        const progress: GenerationProgress = { outputChars: 0, reasoningChars: 0 };
        const tGen = performance.now();
        const label = attempt > 1 ? ` (attempt ${attempt} of ${MAX_ATTEMPTS})` : "";
        const describe = () => {
          const elapsed = fmtDuration(performance.now() - tGen);
          return progress.outputChars
            ? `Writing the page${label}: ${fmtChars(progress.outputChars)} characters so far (${elapsed})`
            : `The model is planning the page${label}${progress.reasoningChars ? `, ${fmtChars(progress.reasoningChars)} characters of reasoning` : ""} (${elapsed})`;
        };
        this.setProgress(id, `Sending ${sources.length} files (${fmtChars(chars)} characters) to ${this.generator.model}${label}`);
        heartbeat = setInterval(() => {
          this.setProgress(id, describe());
          attemptLog.info("still generating", {
            elapsed: fmtDuration(performance.now() - tGen),
            outputChars: progress.outputChars,
            reasoningChars: progress.reasoningChars,
            stage: progress.outputChars ? "writing" : "reasoning",
            request: progress.requestId,
          });
        }, HEARTBEAT_MS);
        heartbeat.unref();
        const candidate = await this.generator.generate(skill, sources, { log: attemptLog, progress, feedback });
        clearInterval(heartbeat);
        heartbeat = undefined;
        attemptLog.info("page generated", { htmlChars: candidate.html.length, took: secs(tGen), servedBy: candidate.model });

        phase = "validating";
        feedback = validateFlowHtml(candidate.html);
        if (!feedback.length) {
          attemptLog.info("page passed validation");
          flow = candidate;
          break;
        }
        for (const problem of feedback) attemptLog.warn("page failed validation", { problem });
        if (attempt < MAX_ATTEMPTS) {
          this.setProgress(id, `The page had a script error; regenerating (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
          phase = "generating";
        }
      }
      if (!flow) throw new Error(`The generated page would not run in a browser: ${feedback.join("; ")}`);

      phase = "storing";
      this.setProgress(id, "Saving the page");
      const meta: FlowMeta = {
        slug: skill.slug,
        model: flow.model,
        builtAt: new Date().toISOString(),
        jobId: id,
        sourceFiles: sources.map((s) => s.path),
        ...(flow.usage ? { usage: flow.usage } : {}),
      };
      const tStore = performance.now();
      await this.store.put(this.htmlKey(skill.slug), flow.html, "text/html; charset=utf-8");
      await this.store.put(this.metaKey(skill.slug), JSON.stringify(meta, null, 2), "application/json");
      this.metaCache.set(skill.slug, { meta, at: Date.now() });
      log.info("stored flow", { store: this.store.name, key: this.htmlKey(skill.slug), bytes: Buffer.byteLength(flow.html), took: secs(tStore) });
      this.setProgress(id, "Done");
      set("succeeded");
      log.info("build succeeded", { total: secs(t0), inputTokens: flow.usage?.inputTokens, outputTokens: flow.usage?.outputTokens });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error(`build failed while ${phase}`, { error: e instanceof Error ? e : message, total: secs(t0) });
      this.setProgress(id, `Failed while ${phase}`);
      set("failed", { error: message.slice(0, 2000) });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.release();
    }
  }
}
