import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { backup } from "node:sqlite";
import { config } from "./config.ts";
import { SkillIndex } from "./db.ts";
import type { BlobStore } from "./storage.ts";

/**
 * The index is a local SQLite file mirrored to blob storage as one object.
 * `<index>.sync.json` records the ETag of the copy we last pulled or pushed, so a push
 * that would overwrite someone else's newer upload is refused instead of silently lost.
 */
interface SyncState {
  etag: string;
  at: string;
  direction: "pull" | "push";
  /** The index's own `meta.updated_at` at sync time; a later value means unpushed local edits. */
  localUpdatedAt: string | null;
}

function localUpdatedAt(dbPath: string): string | null {
  const index = new SkillIndex(dbPath, { readOnly: true });
  try {
    const row = index.db.prepare("SELECT value FROM meta WHERE key = 'updated_at'").get() as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    index.close();
  }
}

/** True when the local index was edited after it was last pulled or pushed. */
export async function hasUnpushedChanges(dbPath = config.indexDbPath): Promise<boolean> {
  if (!existsSync(dbPath)) return false;
  const state = await readSyncState(dbPath);
  const current = localUpdatedAt(dbPath);
  if (!state) return current !== null;
  return current !== state.localUpdatedAt;
}

const statePath = (dbPath: string) => `${dbPath}.sync.json`;

export async function readSyncState(dbPath = config.indexDbPath): Promise<SyncState | null> {
  try {
    return JSON.parse(await readFile(statePath(dbPath), "utf8")) as SyncState;
  } catch {
    return null;
  }
}

async function writeSyncState(dbPath: string, s: SyncState): Promise<void> {
  await writeFile(statePath(dbPath), JSON.stringify(s, null, 2));
}

export class SyncConflictError extends Error {}

/** Download the index from storage, replacing the local file. Returns false if storage has none. */
export async function pullIndex(store: BlobStore, dbPath = config.indexDbPath): Promise<boolean> {
  const blob = await store.get(config.storage.indexKey);
  if (!blob) return false;
  await mkdir(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.download`;
  await writeFile(tmp, blob.body);
  await rm(`${dbPath}-journal`, { force: true });
  await rename(tmp, dbPath);
  await writeSyncState(dbPath, {
    etag: blob.etag,
    at: new Date().toISOString(),
    direction: "pull",
    localUpdatedAt: localUpdatedAt(dbPath),
  });
  return true;
}

/** Upload a consistent snapshot of the local index. Refuses if storage changed since our last sync. */
export async function pushIndex(
  store: BlobStore,
  opts: { force?: boolean; dbPath?: string } = {},
): Promise<{ etag: string }> {
  const dbPath = opts.dbPath ?? config.indexDbPath;
  if (!existsSync(dbPath)) throw new Error(`No local index at ${dbPath}`);
  const remote = await store.head(config.storage.indexKey);
  const state = await readSyncState(dbPath);
  if (remote && !opts.force && remote.etag !== state?.etag) {
    throw new SyncConflictError(
      "The index in storage changed since this copy was last pulled or pushed. " +
        "Run `sync pull` and re-apply your changes, or `sync push --force` to overwrite it.",
    );
  }
  const updatedAt = localUpdatedAt(dbPath);
  const snapshot = `${dbPath}.snapshot`;
  const index = new SkillIndex(dbPath);
  try {
    await backup(index.db, snapshot);
  } finally {
    index.close();
  }
  const body = await readFile(snapshot);
  await rm(snapshot, { force: true });
  const { etag } = await store.put(config.storage.indexKey, body, "application/vnd.sqlite3");
  await writeSyncState(dbPath, { etag, at: new Date().toISOString(), direction: "push", localUpdatedAt: updatedAt });
  return { etag };
}

/**
 * Make sure a local index exists: use the local file, else pull it from storage,
 * else create an empty one.
 */
export async function ensureLocalIndex(
  store: BlobStore,
  dbPath = config.indexDbPath,
): Promise<"local" | "pulled" | "created"> {
  if (existsSync(dbPath)) return "local";
  if (await pullIndex(store, dbPath)) return "pulled";
  await mkdir(dirname(dbPath), { recursive: true });
  new SkillIndex(dbPath).close();
  return "created";
}

/** True when storage holds an index different from the one we last synced. */
export async function remoteIsNewer(store: BlobStore, dbPath = config.indexDbPath): Promise<boolean> {
  const remote = await store.head(config.storage.indexKey);
  if (!remote) return false;
  const state = await readSyncState(dbPath);
  return remote.etag !== state?.etag;
}
