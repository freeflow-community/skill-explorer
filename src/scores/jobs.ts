import { config } from "../config.ts";
import type { Skill } from "../db.ts";
import type { SourceFile } from "../flows/generator.ts";
import { fetchSkillSources, listSkillFiles, parseRepo, relativeToSkill } from "../github.ts";
import { JobQueue, type Job, type JobContext } from "../jobs.ts";
import { log as rootLog, secs, type Logger } from "../log.ts";
import type { BlobStore } from "../storage.ts";
import type { Finding, Rater } from "./rater.ts";
import {
  applyInventory, buildInventory, CATEGORIES, classifyFile, SCANNABLE_KINDS, scanSources, scoreLevels,
  type CategoryKey, type Grade, type Inventory, type Level, type ScanHit,
} from "./scan.ts";

export type ScoreJob = Job;

/** Stored as scores/<slug>.json. */
export interface SafetyReport {
  slug: string;
  model: string;
  ratedAt: string;
  jobId: string;
  score: number;
  grade: Grade;
  label: string;
  summary: string;
  beforeInstalling: string[];
  categories: { key: CategoryKey; name: string; level: Level; rationale: string }[];
  findings: Finding[];
  inventory: Inventory;
  scan: { hits: ScanHit[]; levels: Record<CategoryKey, Level> };
  sourceFiles: string[];
  usage?: { inputTokens: number; outputTokens: number };
}

/** The part of a report that lists and cards show. Kept for every rated skill in scores/summary.json. */
export interface SafetySummary {
  grade: Grade;
  score: number;
  label: string;
  ratedAt: string;
}

export type ScoreState =
  | { state: "none" }
  | { state: "queued" | "running"; job: ScoreJob; report?: SafetyReport }
  | { state: "ready"; report: SafetyReport; job?: ScoreJob }
  | { state: "failed"; job: ScoreJob; report?: SafetyReport };

export interface SkillFiles {
  /** Every file under the skill directory, paths relative to it. */
  files: { path: string; size?: number }[];
  /** The text files that were read. */
  sources: SourceFile[];
}

const summaryOf = (r: SafetyReport): SafetySummary => ({ grade: r.grade, score: r.score, label: r.label, ratedAt: r.ratedAt });

/** Read every scannable text file in the skill directory: docs, config and native scripts. */
export async function loadSkillFiles(skill: Skill, log: Logger, budget = config.score.sourceBudget): Promise<SkillFiles> {
  const repo = parseRepo(skill.repoUrl);
  const entries = await listSkillFiles(repo, skill.repoRef, skill.path);
  const sources = await fetchSkillSources(repo, skill.repoRef, skill.path, budget, log, {
    entries,
    pattern: (path) => SCANNABLE_KINDS.has(classifyFile(path)),
  });
  return { files: entries.map((e) => ({ path: relativeToSkill(e.path, skill.path), size: e.size })), sources };
}

/**
 * Rates skills in the background: static scan, model review, deterministic grade.
 * Reports go to blob storage; a summary of every grade is kept alongside for lists and cards.
 */
export class ScoreService {
  private jobs: JobQueue;
  private store: BlobStore;
  private rater: Rater;
  private findSkill: (slug: string) => Skill | null;
  private loadFiles: (skill: Skill, log: Logger) => Promise<SkillFiles>;
  private log: Logger;
  private reportCache = new Map<string, { report: SafetyReport | null; at: number }>();
  private summary: Record<string, SafetySummary> = {};
  private summaryLoaded = false;
  /** When each auto-rating started, so the hourly budget can be counted. */
  private autoRated: number[] = [];

  constructor(opts: {
    store: BlobStore;
    rater: Rater;
    findSkill: (slug: string) => Skill | null;
    jobsDbPath?: string;
    loadFiles?: (skill: Skill, log: Logger) => Promise<SkillFiles>;
    log?: Logger;
  }) {
    this.log = opts.log ?? rootLog.child("scores");
    this.jobs = new JobQueue({ table: "score_jobs", dbPath: opts.jobsDbPath, concurrency: config.score.concurrency, log: this.log });
    this.store = opts.store;
    this.rater = opts.rater;
    this.findSkill = opts.findSkill;
    this.loadFiles = opts.loadFiles ?? ((skill, log) => loadSkillFiles(skill, log));
  }

  get model(): string {
    return this.rater.model;
  }

  reportKey(slug: string): string {
    return `${config.storage.scorePrefix}${slug}.json`;
  }
  get summaryKey(): string {
    return `${config.storage.scorePrefix}summary.json`;
  }

  getJob(id: string): ScoreJob | null {
    return this.jobs.get(id);
  }

  /** Load the grade summary from storage (once); lists show grades from it. */
  async restore(): Promise<void> {
    if (this.summaryLoaded) return;
    this.summaryLoaded = true;
    const blob = await this.store.get(this.summaryKey);
    if (!blob) return;
    try {
      this.summary = JSON.parse(blob.body.toString("utf8")) as Record<string, SafetySummary>;
      this.log.info("restored safety grades from storage", { skills: Object.keys(this.summary).length });
    } catch (e) {
      this.log.warn("could not parse the safety summary; starting empty", { error: e instanceof Error ? e : String(e) });
    }
  }

  /** Grade summaries for every rated skill. */
  summaries(): Record<string, SafetySummary> {
    return this.summary;
  }

  async getReport(slug: string): Promise<SafetyReport | null> {
    const cached = this.reportCache.get(slug);
    // Found reports are cached until re-rated; misses are re-checked each minute in case another server rated it.
    if (cached && (cached.report || Date.now() - cached.at < 60_000)) return cached.report;
    const blob = await this.store.get(this.reportKey(slug));
    const report = blob ? (JSON.parse(blob.body.toString("utf8")) as SafetyReport) : null;
    this.reportCache.set(slug, { report, at: Date.now() });
    if (report && !this.summary[slug]) this.summary[slug] = summaryOf(report);
    return report;
  }

  async status(slug: string): Promise<ScoreState> {
    const [job, report] = [this.jobs.latest(slug), await this.getReport(slug)];
    if (job && (job.status === "queued" || job.status === "running")) return { state: job.status, job, ...(report ? { report } : {}) };
    if (job?.status === "failed" && (!report || job.createdAt > report.ratedAt)) return { state: "failed", job, ...(report ? { report } : {}) };
    if (report) return { state: "ready", report, ...(job ? { job } : {}) };
    return { state: "none" };
  }

  /** Queue a rating, or return the one already in progress for this skill. */
  start(slug: string): ScoreJob {
    if (!this.findSkill(slug)) throw new Error(`Unknown skill: ${slug}`);
    return this.jobs.start(slug, this.rater.model, (ctx) => this.rate(ctx));
  }

  /**
   * Rate a skill a visitor opened that nobody has rated yet, and return where it stands.
   * Every rating is a model call, so this runs on a budget: only skills with no report and
   * no earlier job, only while the queue is short, and only so many per hour. Skills whose
   * last rating failed are left alone so a broken one isn't retried on every page view.
   */
  async autoRate(slug: string): Promise<ScoreState> {
    const state = await this.status(slug);
    const auto = config.score.auto;
    if (state.state !== "none" || !auto.enabled || auto.perHour <= 0) return state;

    const pending = this.jobs.pending();
    if (pending >= auto.maxPending) {
      this.log.debug("not auto-rating: ratings are already queued", { slug, pending, maxPending: auto.maxPending });
      return state;
    }
    const hourAgo = Date.now() - 3_600_000;
    this.autoRated = this.autoRated.filter((at) => at > hourAgo);
    if (this.autoRated.length >= auto.perHour) {
      this.log.warn("not auto-rating: the hourly budget is spent", { slug, perHour: auto.perHour });
      return state;
    }

    this.autoRated.push(Date.now());
    const job = this.start(slug);
    this.log.info("auto-rating a skill a visitor opened", {
      slug, job: job.id.slice(0, 8), usedThisHour: this.autoRated.length, perHour: auto.perHour, pending,
    });
    return this.status(slug);
  }

  waitFor(id: string, pollMs = 200): Promise<ScoreJob> {
    return this.jobs.waitFor(id, pollMs);
  }

  private async rate(ctx: JobContext): Promise<void> {
    const { log, job } = ctx;
    const skill = this.findSkill(job.slug);
    if (!skill) throw new Error(`Skill ${job.slug} is no longer in the index`);

    ctx.phase = "fetching sources";
    ctx.progress("Listing and reading the skill's files from GitHub");
    const tFetch = performance.now();
    const { files, sources } = await this.loadFiles(skill, log);
    if (!sources.length) throw new Error("Could not read any files for this skill from GitHub");
    const inventory = buildInventory(files, sources.map((s) => s.path));
    log.info("fetched skill files", { files: files.length, read: sources.length, scripts: inventory.scripts.length, binaries: inventory.binaries.length, took: secs(tFetch) });

    ctx.phase = "scanning";
    ctx.progress(`Scanning ${sources.length} file${sources.length === 1 ? "" : "s"} for risk signals`);
    const scan = applyInventory(scanSources(sources), inventory);
    log.info("static scan done", { hits: scan.hits.length, levels: scan.levels });

    ctx.phase = "reviewing";
    ctx.progress(`Asking ${this.rater.model} to review ${sources.length} file${sources.length === 1 ? "" : "s"} and ${scan.hits.length} scan signal${scan.hits.length === 1 ? "" : "s"}`);
    const tReview = performance.now();
    const review = await this.rater.review({ skill, sources, inventory, scan }, { log });
    log.info("review done", { model: review.model, findings: review.findings.length, levels: review.levels, took: secs(tReview) });

    ctx.phase = "storing";
    ctx.progress("Saving the score");
    const { score, grade, label } = scoreLevels(review.levels);
    const report: SafetyReport = {
      slug: skill.slug,
      model: review.model,
      ratedAt: new Date().toISOString(),
      jobId: job.id,
      score,
      grade,
      label,
      summary: review.summary,
      beforeInstalling: review.beforeInstalling,
      categories: CATEGORIES.map((c) => ({ key: c.key, name: c.name, level: review.levels[c.key], rationale: review.rationales[c.key] })),
      findings: review.findings,
      inventory,
      scan: { hits: scan.hits, levels: scan.levels },
      sourceFiles: sources.map((s) => s.path),
      ...(review.usage ? { usage: review.usage } : {}),
    };
    await this.store.put(this.reportKey(skill.slug), JSON.stringify(report, null, 2), "application/json");
    this.reportCache.set(skill.slug, { report, at: Date.now() });
    await this.updateSummary(skill.slug, summaryOf(report), log);
    log.info("stored safety report", { store: this.store.name, key: this.reportKey(skill.slug), grade, score });
  }

  /** Merge one grade into the shared summary. Re-read first so two servers don't drop each other's entries. */
  private async updateSummary(slug: string, entry: SafetySummary, log: Logger): Promise<void> {
    try {
      const blob = await this.store.get(this.summaryKey);
      if (blob) this.summary = { ...(JSON.parse(blob.body.toString("utf8")) as Record<string, SafetySummary>), ...this.summary };
    } catch (e) {
      log.warn("could not re-read the safety summary before updating it", { error: e instanceof Error ? e : String(e) });
    }
    this.summary[slug] = entry;
    await this.store.put(this.summaryKey, JSON.stringify(this.summary), "application/json");
  }
}
