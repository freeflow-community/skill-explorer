/**
 * Tiny structured logger.
 *   LOG_LEVEL=debug|info|warn|error   (default info)
 *   LOG_FORMAT=text|json              (default text)
 * Text lines look like:
 *   2026-09-19T20:31:02.123Z INFO  [flow mcp-builder] generating elapsed=42s outputChars=12340
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;
export type Fields = Record<string, unknown>;

const envLevel = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
const threshold = LEVELS[envLevel] ?? LEVELS.info;
const json = (process.env.LOG_FORMAT ?? "text").toLowerCase() === "json";

function fmtValue(v: unknown): string {
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === "string") return /[\s="]/.test(v) || v === "" ? JSON.stringify(v) : v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return JSON.stringify(v);
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** A logger whose lines carry an extra scope, e.g. log.child("flow mcp-builder"). */
  child(scope: string): Logger;
  enabled(level: Level): boolean;
}

export function createLogger(scope = ""): Logger {
  const write = (level: Level, msg: string, fields: Fields = {}) => {
    if (LEVELS[level] < threshold) return;
    const time = new Date().toISOString();
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    if (json) {
      const extra = Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, v instanceof Error ? { message: v.message, stack: v.stack } : v]),
      );
      stream.write(`${JSON.stringify({ time, level, scope: scope || undefined, msg, ...extra })}\n`);
      return;
    }
    const kv = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${fmtValue(v)}`)
      .join(" ");
    stream.write(`${time} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ""}${msg}${kv ? ` ${kv}` : ""}\n`);
    // Stack traces only at debug, so errors stay one line in normal operation.
    if (threshold <= LEVELS.debug) {
      for (const v of Object.values(fields)) if (v instanceof Error && v.stack) stream.write(`${v.stack}\n`);
    }
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (s) => createLogger(scope ? `${scope} ${s}` : s),
    enabled: (level) => LEVELS[level] >= threshold,
  };
}

export const log = createLogger();

export function ms(since: number): number {
  return Math.round(performance.now() - since);
}
export function secs(since: number): string {
  return `${((performance.now() - since) / 1000).toFixed(1)}s`;
}
