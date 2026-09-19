import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (existsSync(".env")) process.loadEnvFile(".env");

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function int(name: string, fallback: number): number {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = resolve(env("DATA_DIR", "./data"));
type Provider = "anthropic" | "openai";
const DEFAULT_MODEL: Record<Provider, string> = { anthropic: "claude-opus-5", openai: "gpt-5.4-mini" };
const flowGenerator = env("FLOW_GENERATOR", "anthropic") as Provider | "stub";
const tagProvider = env("TAG_PROVIDER", flowGenerator === "stub" ? "anthropic" : flowGenerator) as Provider;
const r2Bucket = env("R2_BUCKET");

export const config = {
  port: int("PORT", 8787),
  dataDir,
  indexDbPath: resolve(env("INDEX_DB", `${dataDir}/skills.db`)),
  jobsDbPath: resolve(env("JOBS_DB", `${dataDir}/jobs.db`)),

  storage: {
    backend: env("STORAGE", r2Bucket ? "r2" : "local") as "r2" | "local",
    localDir: resolve(env("LOCAL_BLOB_DIR", `${dataDir}/blobs`)),
    r2: {
      accountId: env("R2_ACCOUNT_ID"),
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
      bucket: r2Bucket,
      endpoint: env("R2_ENDPOINT"),
    },
    indexKey: env("INDEX_KEY", "index/skills.db"),
    flowPrefix: env("FLOW_PREFIX", "flows/"),
  },

  /** How often the server checks storage for a newer index (0 disables). */
  indexRefreshSeconds: int("INDEX_REFRESH_SECONDS", 300),

  flow: {
    /** Which API builds flows: "anthropic", "openai", or "stub" (offline placeholder). */
    generator: flowGenerator,
    model: env("FLOW_MODEL", DEFAULT_MODEL[flowGenerator === "stub" ? "anthropic" : flowGenerator]),
    effort: env("FLOW_EFFORT", "high") as "low" | "medium" | "high" | "xhigh" | "max",
    maxTokens: int("FLOW_MAX_TOKENS", 64000),
    concurrency: int("FLOW_CONCURRENCY", 2),
    /** When set, building a flow requires `Authorization: Bearer <token>`. */
    buildToken: env("FLOW_BUILD_TOKEN"),
    /** Max characters of skill source sent to the model. */
    sourceBudget: int("FLOW_SOURCE_BUDGET", 300_000),
  },

  /** Skill whose flow the home page shows as an example (empty disables the promo). */
  exampleFlowSlug: env("EXAMPLE_FLOW_SLUG", "canvas-design"),
  tagProvider,
  tagModel: env("TAG_MODEL", DEFAULT_MODEL[tagProvider]),
  githubToken: env("GITHUB_TOKEN", env("GH_TOKEN")),
};

export type Config = typeof config;
