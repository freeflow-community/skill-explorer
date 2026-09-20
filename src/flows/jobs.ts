import { config } from "../config.ts";
import type { Skill } from "../db.ts";
import { fetchSkillSources, parseRepo } from "../github.ts";
import { JobQueue, type Job, type JobContext } from "../jobs.ts";
import { log as rootLog, secs, type Logger } from "../log.ts";
import type { BlobStore } from "../storage.ts";
import type { FlowGenerator, GeneratedFlow, GenerationProgress, SourceFile } from "./generator.ts";
import { validateFlowHtml } from "./validate.ts";

export type { JobStatus } from "../jobs.ts";
export type FlowJob = Job;

const HEARTBEAT_MS = 15_000;
/** One regeneration when the first page fails validation. */
const MAX_ATTEMPTS = 2;

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
export function fmtChars(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
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

/**
 * Builds visual flows in the background. Job state lives in a small local SQLite file
 * (not the synced index, so the server never writes the index); finished flows go to blob storage.
 */
export class FlowService {
  private jobs: JobQueue;
  private store: BlobStore;
  private generator: FlowGenerator;
  private findSkill: (slug: string) => Skill | null;
  private loadSources: (skill: Skill, log: Logger) => Promise<SourceFile[]>;
  private metaCache = new Map<string, { meta: FlowMeta | null; at: number }>();

  constructor(opts: {
    store: BlobStore;
    generator: FlowGenerator;
    findSkill: (slug: string) => Skill | null;
    jobsDbPath?: string;
    loadSources?: (skill: Skill, log: Logger) => Promise<SourceFile[]>;
    log?: Logger;
  }) {
    this.jobs = new JobQueue({
      table: "flow_jobs",
      dbPath: opts.jobsDbPath,
      concurrency: config.flow.concurrency,
      log: opts.log ?? rootLog.child("flows"),
    });
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

  getJob(id: string): FlowJob | null {
    return this.jobs.get(id);
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
    const [job, flow] = [this.jobs.latest(slug), await this.getMeta(slug)];
    if (job && (job.status === "queued" || job.status === "running")) return { state: job.status, job, ...(flow ? { flow } : {}) };
    if (job?.status === "failed" && (!flow || job.createdAt > flow.builtAt)) return { state: "failed", job, ...(flow ? { flow } : {}) };
    if (flow) return { state: "ready", flow, ...(job ? { job } : {}) };
    return { state: "none" };
  }

  /** Queue a build, or return the one already in progress for this skill. */
  start(slug: string): FlowJob {
    if (!this.findSkill(slug)) throw new Error(`Unknown skill: ${slug}`);
    return this.jobs.start(slug, this.generator.model, (ctx) => this.build(ctx));
  }

  /** Resolves when the job finishes; used by the CLI and tests. */
  waitFor(id: string, pollMs = 200): Promise<FlowJob> {
    return this.jobs.waitFor(id, pollMs);
  }

  private async build(ctx: JobContext): Promise<void> {
    const { log, job } = ctx;
    const skill = this.findSkill(job.slug);
    if (!skill) throw new Error(`Skill ${job.slug} is no longer in the index`);
    log.info("build started", { model: this.generator.model, repo: skill.repoUrl, path: skill.path || "/", ref: skill.repoRef });

    ctx.phase = "fetching sources";
    ctx.progress("Reading the skill's files from GitHub");
    const tFetch = performance.now();
    const sources = await this.loadSources(skill, log);
    if (!sources.length) throw new Error("Could not read any files for this skill from GitHub");
    const chars = sources.reduce((n, f) => n + f.content.length, 0);
    log.info("fetched skill sources", { files: sources.length, chars, took: secs(tFetch), paths: sources.map((f) => f.path).join(",") });

    ctx.phase = "generating";
    let flow: GeneratedFlow | undefined;
    let feedback: string[] = [];
    let heartbeat: NodeJS.Timeout | undefined;
    try {
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
        ctx.progress(`Sending ${sources.length} files (${fmtChars(chars)} characters) to ${this.generator.model}${label}`);
        heartbeat = setInterval(() => {
          ctx.progress(describe());
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

        ctx.phase = "validating";
        feedback = validateFlowHtml(candidate.html);
        if (!feedback.length) {
          attemptLog.info("page passed validation");
          flow = candidate;
          break;
        }
        for (const problem of feedback) attemptLog.warn("page failed validation", { problem });
        if (attempt < MAX_ATTEMPTS) {
          ctx.progress(`The page had a script error; regenerating (attempt ${attempt + 1} of ${MAX_ATTEMPTS})`);
          ctx.phase = "generating";
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    if (!flow) throw new Error(`The generated page would not run in a browser: ${feedback.join("; ")}`);

    ctx.phase = "storing";
    ctx.progress("Saving the page");
    const meta: FlowMeta = {
      slug: skill.slug,
      model: flow.model,
      builtAt: new Date().toISOString(),
      jobId: job.id,
      sourceFiles: sources.map((s) => s.path),
      ...(flow.usage ? { usage: flow.usage } : {}),
    };
    const tStore = performance.now();
    await this.store.put(this.htmlKey(skill.slug), flow.html, "text/html; charset=utf-8");
    await this.store.put(this.metaKey(skill.slug), JSON.stringify(meta, null, 2), "application/json");
    this.metaCache.set(skill.slug, { meta, at: Date.now() });
    log.info("stored flow", { store: this.store.name, key: this.htmlKey(skill.slug), bytes: Buffer.byteLength(flow.html), took: secs(tStore) });
    log.info("build succeeded", { inputTokens: flow.usage?.inputTokens, outputTokens: flow.usage?.outputTokens });
  }
}
