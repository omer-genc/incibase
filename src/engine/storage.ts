import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { S3Client } from "bun";
import { IncibaseError } from "../errors.ts";
import type { DbSession } from "./database.ts";
import type { Engine, Identity } from "./engine.ts";

const UPLOAD_URL_TTL_MS = 60 * 60 * 1000;
const DEFAULT_SIGNED_URL_SECONDS = 60 * 60;

export type Visibility = "public" | "private";

interface OwnerOptions {
  /** Skip the owner check because the calling code verified access itself (e.g. an HR role). */
  bypassOwnerCheck?: boolean;
}

interface UploadOptions {
  visibility?: Visibility;
  /** Owner of the new file; defaults to the calling user. Use it to upload on someone's behalf. */
  ownerId?: string | null;
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
  /** Max upload size in bytes. Default 100 MB. */
  maxUploadBytes?: number;
}

interface Backend {
  put(key: string, data: Blob, contentType?: string): Promise<void>;
  get(key: string): Promise<Blob | null>;
  delete(key: string): Promise<void>;
  /** A direct download URL valid for `seconds`, when the backend can serve files itself. */
  presign?(key: string, seconds: number): string;
}

class LocalBackend implements Backend {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  async put(key: string, data: Blob) {
    await Bun.write(join(this.dir, key), data);
  }
  async get(key: string) {
    const file = Bun.file(join(this.dir, key));
    return (await file.exists()) ? file : null;
  }
  async delete(key: string) {
    rmSync(join(this.dir, key), { force: true });
  }
}

class S3Backend implements Backend {
  private readonly client: S3Client;
  constructor(bucket?: string) {
    this.client = new S3Client(bucket ? { bucket } : {});
  }
  async put(key: string, data: Blob, contentType?: string) {
    await this.client.write(key, data, contentType ? { type: contentType } : {});
  }
  async get(key: string) {
    const file = this.client.file(key);
    return (await file.exists()) ? file : null;
  }
  async delete(key: string) {
    await this.client.delete(key);
  }
  presign(key: string, seconds: number) {
    return this.client.presign(key, { expiresIn: seconds });
  }
}

/** Files are blobs keyed by their `_storage` document id. */
export class StorageService {
  private readonly backend: Backend;
  private readonly secret: string;
  readonly maxUploadBytes: number;

  constructor(
    private readonly engine: Engine,
    options: StorageOptions = {},
  ) {
    const backend = options.backend ?? (process.env.INCIBASE_STORAGE === "s3" ? "s3" : "local");
    this.backend =
      backend === "s3" ? new S3Backend(options.bucket) : new LocalBackend(join(engine.options.dataDir, "storage"));
    this.maxUploadBytes = options.maxUploadBytes ?? 100 * 1024 * 1024;
    let secret = engine.store.getMeta("storage_secret");
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

  /** `ownerId` is the user who asked for the URL; they will own the uploaded file. */
  createUploadUrl(options: { visibility?: Visibility; ownerId?: string | null } = {}): string {
    const visibility = parseVisibility(options.visibility);
    const payload = Buffer.from(
      JSON.stringify({ exp: Date.now() + UPLOAD_URL_TTL_MS, v: visibility, u: options.ownerId ?? null }),
    ).toString("base64url");
    return `${this.engine.options.publicUrl}/api/storage/upload?token=${payload}.${this.sign(payload)}`;
  }

  /** The upload's visibility and owner when the token is valid and unexpired, else null. */
  verifyUploadToken(token: string | null): { visibility: Visibility; ownerId: string | null } | null {
    const [payload, signature] = token?.split(".") ?? [];
    if (!payload || !this.signatureMatches(payload, signature)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      return data.exp > Date.now() ? { visibility: parseVisibility(data.v), ownerId: typeof data.u === "string" ? data.u : null } : null;
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

  async store(blob: Blob, options: { contentType?: string; visibility?: Visibility; ownerId?: string | null } = {}): Promise<string> {
    if (blob.size > this.maxUploadBytes) throw new Error(`File exceeds ${this.maxUploadBytes} bytes`);
    const visibility = parseVisibility(options.visibility);
    const bytes = await blob.arrayBuffer();
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const table = this.engine.store.tables.get("_storage")!;
    const id = this.engine.store.newId(table);
    const type = options.contentType || blob.type || undefined;
    await this.backend.put(id, new Blob([bytes], type ? { type } : {}), type);
    try {
      await this.engine.writeTx((session) => {
        session.insertRaw(
          table,
          JSON.stringify({
            ...(type ? { contentType: type } : {}),
            size: bytes.byteLength,
            sha256,
            visibility,
            ...(options.ownerId ? { ownerId: options.ownerId } : {}),
          }),
          id,
        );
      });
    } catch (err) {
      await this.backend.delete(id);
      throw err;
    }
    return id;
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
    const headers: Record<string, string> = {
      "cache-control": isPrivate
        ? `private, max-age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`
        : "public, max-age=31536000, immutable",
    };
    if (typeof doc.contentType === "string") headers["content-type"] = doc.contentType;
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
    await this.loadOwned(session, id, identity, bypass, "delete");
    session.deleteRaw(this.storageTable(session, id), id);
    session.onCommit(() => void this.backend.delete(id).catch((err) => console.error("[incibase] blob delete failed:", err)));
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
    return doc && this.canRead(doc, identity, options.bypassOwnerCheck) ? this.urlFor(doc, options) : null;
  }

  reader(session: DbSession, identity: Identity) {
    return {
      getUrl: (id: string, options?: UrlOptions) => this.getUrlIn(session, id, identity, options),
      getMetadata: (id: string) => session.get("_storage", id),
    };
  }

  writer(session: DbSession, identity: Identity) {
    return {
      ...this.reader(session, identity),
      generateUploadUrl: async (options?: UploadOptions) =>
        this.createUploadUrl({ visibility: options?.visibility, ownerId: this.ownerFor(identity, options) }),
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
      generateUploadUrl: async (options?: UploadOptions) =>
        this.createUploadUrl({ visibility: options?.visibility, ownerId: this.ownerFor(identity, options) }),
      setVisibility: (id: string, visibility: Visibility, options?: OwnerOptions) =>
        this.engine.writeTx((s) => this.setVisibilityChecked(s, id, visibility, identity, options?.bypassOwnerCheck)),
      delete: (id: string, options?: OwnerOptions) =>
        this.engine.writeTx((s) => this.deleteIn(s, id, identity, options?.bypassOwnerCheck)),
      get: async (id: string, options?: OwnerOptions) => {
        const doc = await read((s) => s.get("_storage", id));
        return doc && this.canRead(doc, identity, options?.bypassOwnerCheck) ? this.get(id) : null;
      },
      store: (blob: Blob, options?: { contentType?: string } & UploadOptions) =>
        this.store(blob, { contentType: options?.contentType, visibility: options?.visibility, ownerId: this.ownerFor(identity, options) }),
    };
  }
}
