import { createHmac, timingSafeEqual } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { S3Client } from "bun";
import { IncibaseError } from "../errors.ts";
import type { DbSession } from "./database.ts";
import { collectHeldIds, contentTypeMatches } from "./files.ts";
import { ensurePrivateDir, quoteIdent } from "./store.ts";
import type { Engine, Identity, WriteTxOptions } from "./engine.ts";
import { logEvent } from "./log.ts";
import { bytesFromEnv, checkBytes, checkPositiveInt, LimitError, positiveIntFromEnv, s3Key, s3PrefixFrom } from "./limits.ts";
import { receiveToFile, removeTempFiles, tempPathFor, UploadGate } from "./upload.ts";

const UPLOAD_URL_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SIGNED_URL_SECONDS = 60 * 60;

export type Visibility = "public" | "private";

/** The row is gone (and its bytes no longer count toward the quota); its stored file is left behind and nothing collects it. */
function blobDeleteFailed(storageId: string, err: unknown) {
  logEvent("error", { ev: "storage_error", what: "blob delete", storageId, err }, ["[incibase] blob delete failed:", err]);
}

interface OwnerOptions {
  /** Skip the owner check because the calling code verified access itself (e.g. an HR role). */
  bypassOwnerCheck?: boolean;
}

interface UploadOptions {
  visibility?: Visibility;
  /** Owner of the new file; defaults to the calling user. Use it to upload on someone's behalf. */
  ownerId?: string | null;
  /** Reject larger uploads (bytes). */
  maxBytes?: number;
  /** Accepted content types, e.g. ["image/*", "application/pdf"]. */
  contentTypes?: string[];
}

/** What an upload URL allows; signed into its token. */
export interface UploadGrant {
  visibility?: Visibility;
  ownerId?: string | null;
  /** Uploaded without a user; anyone may attach such a file to a document. */
  anonymous?: boolean;
  /** Uploaded by this service key without a signed URL (the upload scope); it may attach the file. */
  serviceKeyId?: string;
  maxBytes?: number;
  contentTypes?: string[];
}

/** Types a browser may show inline; everything else downloads. */
const INLINE_TYPES = ["image/*", "video/*", "audio/*", "application/pdf", "text/plain"];

/** Content type from magic bytes for common formats, else null. */
export function sniffContentType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const ascii = (offset: number, text: string) => [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "%PDF-")) return "application/pdf";
  return null;
}

interface UrlOptions extends OwnerOptions {
  /** Lifetime of a private file's signed URL in seconds (default 3600). */
  expiresIn?: number;
}

function parseVisibility(value: unknown): Visibility {
  if (value === undefined || value === null || value === "public") return "public";
  if (value === "private") return "private";
  throw new IncibaseError({ code: "BAD_REQUEST", message: `visibility must be "public" or "private"` });
}

/** Files stored before visibility existed have no field and are public. */
export function visibilityOf(doc: Record<string, unknown>): Visibility {
  return doc.visibility === "private" ? "private" : "public";
}

export interface StorageOptions {
  /** `"local"` (default) stores files under `<dataDir>/storage`; `"s3"` uses Bun's S3 client and the `S3_*` env vars. */
  backend?: "local" | "s3";
  /** S3 bucket; falls back to `S3_BUCKET`. */
  bucket?: string;
  /** Max upload size in bytes. Default 100 MB. `INCIBASE_MAX_UPLOAD_BYTES` wins when set. */
  maxUploadBytes?: number;
  /** Max bytes of all stored files together; uploads past it fail with STORAGE_QUOTA. Default none. `INCIBASE_MAX_STORAGE_BYTES` wins when set. */
  maxStorageBytes?: number;
  /** Uploads processed at once (default: no limit, as in 0.2.0); `INCIBASE_UPLOAD_CONCURRENCY` wins when set. */
  uploadConcurrency?: number;
  /** How long an upload waits for a free slot before UPLOADS_BUSY (default 30 s). */
  uploadQueueTimeoutMs?: number;
  /** Prefix of every S3 object key, e.g. `"shop/b7k2m9q4/"`; falls back to `INCIBASE_S3_PREFIX`. */
  s3Prefix?: string;
  /** Deleting unused files (see StorageService.cleanup); false turns it off. */
  cleanup?: { unattachedHours?: number; detachedHours?: number } | false;
}

interface Backend {
  /** Stores the file at `path` (a temp file in the storage dir) under `key`; the caller removes `path` afterwards if it is still there. */
  putFile(key: string, path: string, contentType?: string): Promise<void>;
  get(key: string): Promise<Blob | null>;
  delete(key: string): Promise<void>;
  /** A direct download URL valid for `seconds`, when the backend can serve files itself. */
  presign?(key: string, seconds: number): string;
}

class LocalBackend implements Backend {
  constructor(private readonly dir: string) {
    ensurePrivateDir(dir);
  }
  async putFile(key: string, path: string) {
    renameSync(path, join(this.dir, key));
  }
  async get(key: string) {
    const file = Bun.file(join(this.dir, key));
    return (await file.exists()) ? file : null;
  }
  async delete(key: string) {
    rmSync(join(this.dir, key), { force: true });
  }
}

/** The parts of Bun's S3Client the backend uses (a test passes a fake). */
export type S3Like = Pick<S3Client, "write" | "file" | "delete" | "presign">;

/** Objects are keyed `<prefix><storage id>`, so branches can share a bucket without sharing keys. */
export class S3Backend implements Backend {
  private readonly client: S3Like;
  constructor(
    bucket?: string,
    private readonly prefix = "",
    client?: S3Like,
  ) {
    this.client = client ?? new S3Client(bucket ? { bucket } : {});
  }
  async putFile(key: string, path: string, contentType?: string) {
    await this.client.write(s3Key(this.prefix, key), Bun.file(path), contentType ? { type: contentType } : {});
  }
  async get(key: string) {
    const file = this.client.file(s3Key(this.prefix, key));
    return (await file.exists()) ? file : null;
  }
  async delete(key: string) {
    await this.client.delete(s3Key(this.prefix, key));
  }
  presign(key: string, seconds: number) {
    return this.client.presign(s3Key(this.prefix, key), { expiresIn: seconds });
  }
}

const STORAGE_BYTES_KEY = "storage_bytes";

/** Bytes of a `_storage` document's file. */
const sizeOf = (doc: Record<string, unknown>) => (typeof doc.size === "number" && Number.isFinite(doc.size) ? doc.size : 0);

/** Adds `delta` to the stored total, in the transaction that adds or removes the `_storage` rows. */
function addStoredBytes(session: DbSession, delta: number) {
  if (delta === 0) return;
  session.conn.query(`UPDATE _incibase_meta SET value = CAST(value AS INTEGER) + ? WHERE key = ?`).run(delta, STORAGE_BYTES_KEY);
}

/** Files are blobs keyed by their `_storage` document id. */
export class StorageService {
  private readonly backend: Backend;
  private readonly secret: string;
  readonly maxUploadBytes: number;
  readonly maxStorageBytes: number | undefined;
  readonly uploads: UploadGate;
  /** Where uploads are received before they are stored: the local storage dir, so storing one locally is a rename. */
  private readonly tempDir: string;
  /** File deletes running now (after a commit), which a stop waits for. */
  private readonly deleting = new Set<Promise<void>>();
  private readonly cleanupPolicy: { unattachedHours: number; detachedHours: number } | null;

  constructor(
    private readonly engine: Engine,
    options: StorageOptions = {},
  ) {
    const backend = options.backend ?? (process.env.INCIBASE_STORAGE === "s3" ? "s3" : "local");
    this.maxUploadBytes = bytesFromEnv("INCIBASE_MAX_UPLOAD_BYTES") ?? checkBytes(options.maxUploadBytes, "maxUploadBytes") ?? 100 * 1024 * 1024;
    this.maxStorageBytes = bytesFromEnv("INCIBASE_MAX_STORAGE_BYTES") ?? checkBytes(options.maxStorageBytes, "maxStorageBytes");
    // Unlimited unless a limit is set: the host sets one from its memory budget; a plain app keeps 0.2.0's behaviour.
    this.uploads = new UploadGate(
      positiveIntFromEnv("INCIBASE_UPLOAD_CONCURRENCY") ?? checkPositiveInt(options.uploadConcurrency, "uploadConcurrency") ?? Infinity,
      checkPositiveInt(options.uploadQueueTimeoutMs, "uploadQueueTimeoutMs") ?? 30_000,
    );
    this.tempDir = join(engine.options.dataDir, "storage");
    this.backend = backend === "s3" ? new S3Backend(options.bucket, s3PrefixFrom(options.s3Prefix)) : new LocalBackend(this.tempDir);
    ensurePrivateDir(this.tempDir);
    removeTempFiles(this.tempDir);
    this.syncStoredBytes();
    this.cleanupPolicy =
      options.cleanup === false || process.env.INCIBASE_STORAGE_CLEANUP === "off"
        ? null
        : { unattachedHours: options.cleanup?.unattachedHours ?? 24, detachedHours: options.cleanup?.detachedHours ?? 1 };
    // From the environment (hosted mode), it is never read from or written to the database.
    let secret = process.env.INCIBASE_STORAGE_SECRET || engine.store.getMeta("storage_secret");
    if (!secret) {
      secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      engine.store.setMeta("storage_secret", secret);
    }
    this.secret = secret;
  }

  private sign(payload: string) {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private signatureMatches(payload: string, signature: string | null | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Signed upload URL. The grant (owner, visibility, limits) travels inside the token. */
  createUploadUrl(grant: UploadGrant = {}): string {
    const payload = Buffer.from(
      JSON.stringify({
        exp: Date.now() + UPLOAD_URL_TTL_MS,
        v: parseVisibility(grant.visibility),
        u: grant.ownerId ?? null,
        a: grant.anonymous ? 1 : 0,
        mb: grant.maxBytes,
        ct: grant.contentTypes,
      }),
    ).toString("base64url");
    return `${this.engine.options.publicUrl}/api/storage/upload?token=${payload}.${this.sign(payload)}`;
  }

  /** The upload grant when the token is valid and unexpired, else null. */
  verifyUploadToken(token: string | null): UploadGrant | null {
    const [payload, signature] = token?.split(".") ?? [];
    if (!payload || !this.signatureMatches(payload, signature)) return null;
    try {
      const d = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (!(d.exp > Date.now())) return null;
      return {
        visibility: parseVisibility(d.v),
        ownerId: typeof d.u === "string" ? d.u : null,
        anonymous: d.a === 1,
        maxBytes: typeof d.mb === "number" ? d.mb : undefined,
        contentTypes: Array.isArray(d.ct) ? d.ct : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Public files get their plain URL. Private files get a signed URL valid for
   * `expiresIn` seconds (default 1 hour). The expiry is rounded up to a bucket
   * so repeated calls (e.g. a live query rerunning) return the same URL.
   */
  urlFor(doc: Record<string, unknown> & { _id: string }, options: { expiresIn?: number } = {}): string {
    const base = `${this.engine.options.publicUrl}/api/storage/${doc._id}`;
    if (visibilityOf(doc) === "public") return base;
    const seconds = options.expiresIn ?? DEFAULT_SIGNED_URL_SECONDS;
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("expiresIn must be a positive number of seconds");
    const bucketMs = Math.min(Math.max((seconds * 1000) / 4, 1000), 5 * 60 * 1000);
    const exp = Math.ceil((Date.now() + seconds * 1000) / bucketMs) * bucketMs;
    return `${base}?exp=${exp}&sig=${this.sign(`${doc._id}.${exp}`)}`;
  }

  async store(blob: Blob, options: UploadGrant & { contentType?: string } = {}): Promise<string> {
    const limit = Math.min(options.maxBytes ?? Infinity, this.maxUploadBytes);
    if (blob.size > limit) throw new IncibaseError({ code: "FILE_TOO_LARGE", message: `File exceeds ${limit} bytes` });
    return this.storeStream(blob.stream(), blob.size, { ...options, contentType: options.contentType || blob.type || undefined });
  }

  /**
   * Stores an upload's body (`POST /api/storage/upload`) under `grant`.
   * At most `uploads.limit` run at once; the rest wait their turn (see
   * UploadGate). `waiting` is called with true when this one has to wait
   * (its body is not read meanwhile), and with false once it may go on.
   */
  async receive(req: Request, grant: UploadGrant, waiting?: (queued: boolean) => void): Promise<string> {
    const declared = Number(req.headers.get("content-length") ?? NaN);
    // Refused before waiting for a slot, when the declared size already says no.
    this.checkUploadSize(declared, this.uploadLimit(grant.maxBytes), this.quotaLeft());
    const queued = this.uploads.full;
    if (queued) waiting?.(true);
    const release = await this.uploads.acquire(req.signal).finally(() => {
      if (queued) waiting?.(false);
    });
    try {
      return await this.storeStream(req.body, declared, { ...grant, contentType: req.headers.get("content-type") ?? undefined });
    } finally {
      release();
    }
  }

  /** Bytes of all stored files, as kept in `_incibase_meta`. */
  storedBytes(): number {
    return Number(this.engine.store.getMeta(STORAGE_BYTES_KEY) ?? 0);
  }

  /** Sets the stored total from the `_storage` rows, which a binary without the total (or a manual edit) may have changed. */
  private syncStoredBytes() {
    const { bytes } = this.engine.store.write
      .query(`SELECT COALESCE(SUM(json_extract(data, '$.size')), 0) AS bytes FROM _storage`)
      .get() as { bytes: number };
    const kept = this.engine.store.getMeta(STORAGE_BYTES_KEY);
    if (kept !== String(bytes)) this.engine.store.setMeta(STORAGE_BYTES_KEY, String(bytes));
  }

  private uploadLimit(grantMaxBytes: number | undefined) {
    return Math.min(grantMaxBytes ?? Infinity, this.maxUploadBytes);
  }

  private quotaLeft() {
    return this.maxStorageBytes === undefined ? Infinity : this.maxStorageBytes - this.storedBytes();
  }

  private quotaError() {
    return new LimitError(
      { code: "STORAGE_QUOTA", message: `Storage is full: this file would take the stored files past ${this.maxStorageBytes} bytes` },
      507,
    );
  }

  /** Throws when `size` bytes (NaN: unknown yet) cannot be stored. */
  private checkUploadSize(size: number, limit: number, quotaLeft: number) {
    if (size > limit) throw new LimitError({ code: "FILE_TOO_LARGE", message: `File exceeds ${limit} bytes` }, 413);
    if (size > quotaLeft) throw this.quotaError();
  }

  /**
   * Streams `body` into a temp file (counted, hashed, its type checked from
   * the first bytes), adds the `_storage` row (marked `storing`) and its bytes
   * to the total in one transaction, checking the quota, then stores the file
   * with the backend and clears the mark. The file is never in memory whole,
   * and nothing is left behind on failure. A process that dies on the way
   * leaves a temp file (removed on start) or a row marked `storing`, whose
   * bytes still count toward the quota and which the next start removes with
   * its stored file (see `recoverInterrupted`): never a stored file without
   * a row.
   */
  private async storeStream(
    body: ReadableStream<Uint8Array> | null,
    declaredSize: number,
    options: UploadGrant & { contentType?: string },
  ): Promise<string> {
    const limit = this.uploadLimit(options.maxBytes);
    const quotaLeft = this.quotaLeft();
    this.checkUploadSize(declaredSize, limit, quotaLeft);
    const visibility = parseVisibility(options.visibility);
    const table = this.engine.store.tables.get("_storage")!;
    const id = this.engine.store.newId(table);
    let type: string | undefined;
    const file = await receiveToFile(body, tempPathFor(this.tempDir, id), {
      checkSize: (size) => this.checkUploadSize(size, limit, quotaLeft),
      checkHead: (head) => {
        // Trust the bytes over the declared type when they are recognisable.
        type = sniffContentType(head) ?? (options.contentType || undefined);
        if (options.contentTypes && !contentTypeMatches(type, options.contentTypes)) {
          throw new IncibaseError({
            code: "UNSUPPORTED_FILE_TYPE",
            message: `Accepted types: ${options.contentTypes.join(", ")}; got ${type ?? "unknown"}`,
          });
        }
      },
    });
    const doc = {
      ...(type ? { contentType: type } : {}),
      size: file.size,
      sha256: file.sha256,
      visibility,
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
      ...(options.anonymous && !options.ownerId ? { anonymous: true } : {}),
      ...(options.serviceKeyId && !options.ownerId ? { serviceKeyId: options.serviceKeyId } : {}),
      // Collected by cleanup() unless a document references it in time.
      pending: true,
    };
    let stored = false;
    try {
      // Other uploads may have finished meanwhile; checked again in the transaction.
      if (file.size > this.quotaLeft()) throw this.quotaError();
      // The row (and its bytes) first, so a crash never leaves a stored file nothing counts or collects.
      await this.engine.writeTx((session) => {
        if (this.maxStorageBytes !== undefined && this.storedBytes() + file.size > this.maxStorageBytes) throw this.quotaError();
        session.insertRaw(table, JSON.stringify({ ...doc, storing: true }), id);
        addStoredBytes(session, file.size);
      });
      stored = true;
      await this.backend.putFile(id, file.path, type);
      await this.engine.writeTx((session) => session.updateRaw(table, id, JSON.stringify(doc)));
    } catch (err) {
      if (stored) await this.discardStoring(id, file.size);
      throw err;
    } finally {
      rmSync(file.path, { force: true });
    }
    return id;
  }

  /** Removes an upload that failed after its row was added: the row, its bytes and whatever the backend got. */
  private async discardStoring(id: string, size: number) {
    try {
      await this.engine.writeTx((session) => {
        if (!session.conn.query(`SELECT 1 FROM _storage WHERE _id = ?`).get(id)) return;
        session.deleteRaw(session.systemTable("_storage"), id);
        addStoredBytes(session, -size);
      });
    } catch (err) {
      // The row stays marked `storing`; the next start removes it.
      logEvent("error", { ev: "storage_error", what: "discard upload", storageId: id, err }, ["[incibase] could not discard a failed upload:", err]);
      return;
    }
    await this.deleteBlob(id);
  }

  /**
   * Removes uploads a previous process left half done: rows still marked
   * `storing`, with their bytes and whatever the backend stored for them.
   * Run by the scheduler's start (never by a `--migrate-only` preflight,
   * whose copy of the data shares the S3 bucket with the live process); rows
   * this process added are left alone.
   */
  async recoverInterrupted(options: WriteTxOptions = {}): Promise<number> {
    const startedAt = this.engine.startedAt;
    // Read first, on the read connection: almost always there is nothing, and then no write lock is needed.
    const any = this.engine.store.read
      .query(`SELECT 1 FROM _storage WHERE json_extract(data, '$.storing') = 1 AND _creationTime < ? LIMIT 1`)
      .get(startedAt);
    if (!any) return 0;
    const ids = await this.engine.writeTx((session) => {
      const rows = session.conn
        .query(`SELECT _id, data FROM _storage WHERE json_extract(data, '$.storing') = 1 AND _creationTime < ?`)
        .all(startedAt) as { _id: string; data: string }[];
      const table = session.systemTable("_storage");
      for (const row of rows) {
        session.deleteRaw(table, row._id);
        addStoredBytes(session, -sizeOf(JSON.parse(row.data)));
      }
      return rows.map((r) => r._id);
    }, undefined, options);
    if (ids.length) logEvent("warn", { ev: "uploads_recovered", msg: "removed uploads a stopped process left half stored", storageIds: ids });
    await Promise.all(ids.map((id) => this.deleteBlob(id)));
    return ids.length;
  }

  /** Deletes a stored file, logging a failure; `settled` waits for the deletes still running. */
  private deleteBlob(id: string): Promise<void> {
    const deleting = this.backend.delete(id).catch((err) => blobDeleteFailed(id, err));
    this.deleting.add(deleting);
    void deleting.finally(() => this.deleting.delete(deleting));
    return deleting;
  }

  /** Resolves once the file deletes started so far have finished, or after `timeoutMs`: for a stop, so they are not cut. */
  async settled(timeoutMs = 5000): Promise<void> {
    if (!this.deleting.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(this.deleting), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  /** Files and bytes owned by a user, e.g. for upload quotas. */
  usage(userId: string): { files: number; bytes: number } {
    const row = this.engine.store.write
      .query(`SELECT COUNT(*) AS files, COALESCE(SUM(json_extract(data, '$.size')), 0) AS bytes FROM _storage WHERE json_extract(data, '$.ownerId') = ?`)
      .get(userId) as { files: number; bytes: number };
    return { files: row.files, bytes: row.bytes };
  }

  /**
   * Deletes files nobody uses: uploads never put into a document within
   * `unattachedHours`, and files dropped from a `file()` field more than
   * `detachedHours` ago. Files put into an `id("_storage")` field, held by a
   * document when its table's schema changed, or stored before this existed
   * are not pending, so they are never collected. Pending files a document
   * of a table with `id("_storage")` fields, or of a table removed from the
   * schema, holds (as a whole value or a key) stay too. Candidates are picked
   * and checked inside the deleting transaction, so a write that uses a file
   * first keeps it.
   */
  async cleanup(now = Date.now()): Promise<number> {
    if (!this.cleanupPolicy) return 0;
    const { unattachedHours, detachedHours } = this.cleanupPolicy;
    return this.engine.writeTx((session) => {
      const rows = session.conn
        .query(`SELECT _id, _creationTime, data FROM _storage WHERE json_extract(data, '$.pending') = 1`)
        .all() as { _id: string; _creationTime: number; data: string }[];
      const due = rows.filter((row) => {
        const d = JSON.parse(row.data);
        if (d.attachedTo) return false;
        return typeof d.detachedAt === "number"
          ? d.detachedAt < now - detachedHours * 3600_000
          : row._creationTime < now - unattachedHours * 3600_000;
      });
      if (due.length === 0) return 0;

      const referenced = this.referencedIds(session, new Set(due.map((row) => row._id)));
      const table = session.systemTable("_storage");
      let deleted = 0;
      for (const row of due) {
        if (referenced.has(row._id)) continue;
        session.deleteRaw(table, row._id);
        addStoredBytes(session, -sizeOf(JSON.parse(row.data)));
        session.onCommit(() => void this.deleteBlob(row._id));
        deleted++;
      }
      return deleted;
    });
  }

  /**
   * The `candidates` a document holds anywhere, in tables with plain
   * `id("_storage")` fields and in tables removed from the schema. Other
   * tables are not read: a change to their schema has released the files
   * their documents held (see migrate).
   */
  private referencedIds(session: DbSession, candidates: Set<string>): Set<string> {
    const found = new Set<string>();
    // Ids end with their table's two-character code: a document without that
    // code before a closing quote holds no file id and is not parsed.
    const marker = `${[...candidates][0]!.slice(-2)}"`;
    const removed = session.conn.query(`SELECT name FROM _incibase_tables WHERE active = 0`).all() as { name: string }[];
    const withIds = [...this.engine.store.tables.values()].filter((t) => t.storageFields?.some((f) => !f.file));
    for (const { name } of [...removed, ...withIds]) {
      const rows = session.conn.query(`SELECT data FROM ${quoteIdent(name)} WHERE instr(data, ?) > 0`).all(marker) as { data: string }[];
      for (const { data } of rows) collectHeldIds(JSON.parse(data), candidates, found);
      if (found.size === candidates.size) break;
    }
    return found;
  }

  async get(id: string): Promise<Blob | null> {
    if (this.engine.store.tableOfId(id)?.name !== "_storage") return null;
    return this.backend.get(id);
  }

  /** Response for `GET /api/storage/:id`. Private files need a valid, unexpired signature. */
  async serve(id: string, url: URL): Promise<Response> {
    const doc = (await this.engine.readTx((s) => s.get("_storage", id))).result;
    if (!doc) return new Response("Not found", { status: 404 });
    const isPrivate = visibilityOf(doc) === "private";
    let expiresAt = Infinity;
    if (isPrivate) {
      const exp = Number(url.searchParams.get("exp"));
      if (!this.signatureMatches(`${id}.${url.searchParams.get("exp")}`, url.searchParams.get("sig")) || !Number.isFinite(exp)) {
        return new Response("This file is private; use a URL from ctx.storage.getUrl", { status: 403 });
      }
      if (exp <= Date.now()) return new Response("This link has expired", { status: 403 });
      expiresAt = exp;
    }
    if (this.backend.presign) {
      const seconds = isPrivate ? Math.max(1, Math.min(3600, Math.floor((expiresAt - Date.now()) / 1000))) : 3600;
      return Response.redirect(this.backend.presign(id, seconds), 302);
    }
    const blob = await this.backend.get(id);
    if (!blob) return new Response("Not found", { status: 404 });
    const type = typeof doc.contentType === "string" ? doc.contentType : "application/octet-stream";
    const headers: Record<string, string> = {
      "cache-control": isPrivate
        ? `private, max-age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`
        : "public, max-age=31536000, immutable",
      "content-type": type,
      // User uploads share an origin with the API and the dashboard (which keeps the admin key):
      // never let one run script (HTML, SVG) or be sniffed into something executable.
      "x-content-type-options": "nosniff",
      ...(contentTypeMatches(type, ["application/pdf"]) ? {} : { "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" }),
      ...(contentTypeMatches(type, INLINE_TYPES) ? {} : { "content-disposition": "attachment" }),
    };
    return new Response(blob, { headers });
  }

  /**
   * Who may act on a file from function code: the admin, the file's owner, or
   * code that passed `bypassOwnerCheck` after checking access itself.
   */
  private isOwner(doc: Record<string, unknown>, identity: Identity, bypass?: boolean) {
    return identity.admin || !!bypass || (!!identity.userId && doc.ownerId === identity.userId);
  }

  /** Read access: public files are open to everyone; private ones follow `isOwner`. */
  private canRead(doc: Record<string, unknown>, identity: Identity, bypass?: boolean) {
    return visibilityOf(doc) === "public" || this.isOwner(doc, identity, bypass);
  }

  private async loadOwned(session: DbSession, id: string, identity: Identity, bypass: boolean | undefined, action: string) {
    this.storageTable(session, id);
    const doc = await session.get("_storage", id);
    if (!doc) throw new IncibaseError({ code: "NOT_FOUND", message: `File "${id}" not found` });
    if (!this.isOwner(doc, identity, bypass)) {
      throw new IncibaseError({
        code: "FORBIDDEN",
        message: `Only the file's owner can ${action} it. Check access yourself and pass { bypassOwnerCheck: true } to allow others.`,
      });
    }
    return doc;
  }

  private async deleteIn(session: DbSession, id: string, identity: Identity, bypass?: boolean) {
    const doc = await this.loadOwned(session, id, identity, bypass, "delete");
    session.deleteRaw(this.storageTable(session, id), id);
    addStoredBytes(session, -sizeOf(doc));
    session.onCommit(() => void this.deleteBlob(id));
  }

  /** Unchecked; callers decide who may change visibility (see `setVisibility` in contexts). */
  setVisibilityIn(session: DbSession, id: string, visibility: Visibility) {
    const table = this.storageTable(session, id);
    const current = session.conn.query(`SELECT data FROM _storage WHERE _id = ?`).get(id) as { data: string } | null;
    if (!current) throw new IncibaseError({ code: "NOT_FOUND", message: `File "${id}" not found` });
    session.updateRaw(table, id, JSON.stringify({ ...JSON.parse(current.data), visibility: parseVisibility(visibility) }));
  }

  private async setVisibilityChecked(session: DbSession, id: string, visibility: Visibility, identity: Identity, bypass?: boolean) {
    await this.loadOwned(session, id, identity, bypass, "change the visibility of");
    this.setVisibilityIn(session, id, visibility);
  }

  private grantFor(identity: Identity, options: UploadOptions = {}): UploadGrant {
    const ownerId = this.ownerFor(identity, options);
    return {
      visibility: options.visibility,
      ownerId,
      anonymous: !ownerId && !identity.admin && !identity.system,
      maxBytes: options.maxBytes,
      contentTypes: options.contentTypes,
    };
  }

  /** The caller owns new files unless server code names another owner (or null for none). */
  private ownerFor(identity: Identity, options?: UploadOptions): string | null {
    if (options && "ownerId" in options && options.ownerId !== undefined) {
      const owner = options.ownerId;
      if (owner !== null && this.engine.store.tableOfId(owner)?.name !== "_users") {
        throw new IncibaseError({ code: "BAD_REQUEST", message: "ownerId must be a _users id or null" });
      }
      return owner;
    }
    return identity.userId;
  }

  private storageTable(session: DbSession, id: string) {
    const table = session.systemTable("_storage");
    if (this.engine.store.tableOfId(id) !== table) throw new Error(`"${id}" is not a storage id`);
    return table;
  }

  private async getUrlIn(session: DbSession, id: string, identity: Identity, options: UrlOptions = {}) {
    const doc = await session.get("_storage", id);
    if (!doc) return null;
    // A file in a document's file() field is readable by code that loaded that document.
    const attachedTo = (doc.attachedTo as { id?: string } | undefined)?.id;
    const viaDocument = !!attachedTo && session.loadedIds.has(attachedTo);
    return viaDocument || this.canRead(doc, identity, options.bypassOwnerCheck) ? this.urlFor(doc, options) : null;
  }

  reader(session: DbSession, identity: Identity) {
    return {
      getUrl: (id: string, options?: UrlOptions) => this.getUrlIn(session, id, identity, options),
      getMetadata: (id: string) => session.get("_storage", id),
      usage: async (userId: string) => this.usage(userId),
    };
  }

  writer(session: DbSession, identity: Identity) {
    return {
      ...this.reader(session, identity),
      generateUploadUrl: async (options?: UploadOptions) => this.createUploadUrl(this.grantFor(identity, options)),
      setVisibility: (id: string, visibility: Visibility, options?: OwnerOptions) =>
        this.setVisibilityChecked(session, id, visibility, identity, options?.bypassOwnerCheck),
      delete: (id: string, options?: OwnerOptions) => this.deleteIn(session, id, identity, options?.bypassOwnerCheck),
    };
  }

  actionWriter(identity: Identity) {
    const read = <T>(fn: (s: DbSession) => Promise<T>) => this.engine.readTx(fn).then((r) => r.result);
    return {
      getUrl: (id: string, options?: UrlOptions) => read((s) => this.getUrlIn(s, id, identity, options)),
      getMetadata: (id: string) => read((s) => s.get("_storage", id)),
      generateUploadUrl: async (options?: UploadOptions) => this.createUploadUrl(this.grantFor(identity, options)),
      setVisibility: (id: string, visibility: Visibility, options?: OwnerOptions) =>
        this.engine.writeTx((s) => this.setVisibilityChecked(s, id, visibility, identity, options?.bypassOwnerCheck)),
      delete: (id: string, options?: OwnerOptions) =>
        this.engine.writeTx((s) => this.deleteIn(s, id, identity, options?.bypassOwnerCheck)),
      get: async (id: string, options?: OwnerOptions) => {
        const doc = await read((s) => s.get("_storage", id));
        return doc && this.canRead(doc, identity, options?.bypassOwnerCheck) ? this.get(id) : null;
      },
      store: (blob: Blob, options?: { contentType?: string } & UploadOptions) =>
        this.store(blob, { ...this.grantFor(identity, options), contentType: options?.contentType }),
      usage: async (userId: string) => this.usage(userId),
    };
  }
}
