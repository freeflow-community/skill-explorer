import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "./config.ts";

export interface Blob {
  body: Buffer;
  etag: string;
}

/** Minimal object store: the index file and generated flow pages live here. */
export interface BlobStore {
  readonly name: string;
  get(key: string): Promise<Blob | null>;
  head(key: string): Promise<{ etag: string } | null>;
  put(key: string, body: Buffer | string, contentType: string): Promise<{ etag: string }>;
}

function md5(body: Buffer): string {
  return createHash("md5").update(body).digest("hex");
}

/** Filesystem store for local development and tests. ETags are content hashes. */
export class LocalBlobStore implements BlobStore {
  readonly name: string;
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    this.name = `local:${root}`;
  }
  private path(key: string): string {
    if (key.split("/").some((p) => p === ".." || p === "")) throw new Error(`bad key: ${key}`);
    return join(this.root, key);
  }
  async get(key: string): Promise<Blob | null> {
    try {
      const body = await readFile(this.path(key));
      return { body, etag: md5(body) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async head(key: string): Promise<{ etag: string } | null> {
    const blob = await this.get(key);
    return blob && { etag: blob.etag };
  }
  async put(key: string, body: Buffer | string): Promise<{ etag: string }> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    await writeFile(`${p}.tmp`, buf);
    await rename(`${p}.tmp`, p);
    return { etag: md5(buf) };
  }
  async exists(key: string): Promise<boolean> {
    return stat(this.path(key)).then(() => true, () => false);
  }
}

/** Cloudflare R2 through its S3-compatible API. */
export class R2BlobStore implements BlobStore {
  readonly name: string;
  private s3: S3Client;
  private bucket: string;
  constructor(opts: typeof config.storage.r2) {
    if (!opts.bucket || !opts.accessKeyId || !opts.secretAccessKey || !(opts.accountId || opts.endpoint)) {
      throw new Error("R2 storage needs R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_ACCOUNT_ID (or R2_ENDPOINT)");
    }
    this.bucket = opts.bucket;
    this.name = `r2:${opts.bucket}`;
    this.s3 = new S3Client({
      region: "auto",
      endpoint: opts.endpoint || `https://${opts.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }
  async get(key: string): Promise<Blob | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = Buffer.from(await res.Body!.transformToByteArray());
      return { body, etag: stripQuotes(res.ETag) };
    } catch (e) {
      if (e instanceof NoSuchKey || e instanceof NotFound) return null;
      throw e;
    }
  }
  async head(key: string): Promise<{ etag: string } | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { etag: stripQuotes(res.ETag) };
    } catch (e) {
      if (e instanceof NotFound || (e as { name?: string }).name === "NotFound") return null;
      throw e;
    }
  }
  async put(key: string, body: Buffer | string, contentType: string): Promise<{ etag: string }> {
    const res = await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return { etag: stripQuotes(res.ETag) };
  }
}

function stripQuotes(etag: string | undefined): string {
  return (etag ?? "").replaceAll('"', "");
}

let store: BlobStore | undefined;
export function getStore(): BlobStore {
  store ??=
    config.storage.backend === "r2"
      ? new R2BlobStore(config.storage.r2)
      : new LocalBlobStore(config.storage.localDir);
  return store;
}
