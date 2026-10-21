import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { S3Client } from "bun";
import type { DbSession } from "./database.ts";
import type { Engine } from "./engine.ts";

const UPLOAD_URL_TTL_MS = 60 * 60 * 1000;

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
  /** A direct download URL, when the backend can serve files itself. */
  presign?(key: string): string;
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
  presign(key: string) {
    return this.client.presign(key, { expiresIn: 3600 });
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

  createUploadUrl(): string {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + UPLOAD_URL_TTL_MS })).toString("base64url");
    return `${this.engine.options.publicUrl}/api/storage/upload?token=${payload}.${this.sign(payload)}`;
  }

  verifyUploadToken(token: string | null): boolean {
    const [payload, signature] = token?.split(".") ?? [];
    if (!payload || !signature) return false;
    const expected = Buffer.from(this.sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    try {
      return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now();
    } catch {
      return false;
    }
  }

  urlFor(id: string) {
    return `${this.engine.options.publicUrl}/api/storage/${id}`;
  }

  async store(blob: Blob, contentType?: string): Promise<string> {
    if (blob.size > this.maxUploadBytes) throw new Error(`File exceeds ${this.maxUploadBytes} bytes`);
    const bytes = await blob.arrayBuffer();
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const table = this.engine.store.tables.get("_storage")!;
    const id = this.engine.store.newId(table);
    const type = contentType || blob.type || undefined;
    await this.backend.put(id, new Blob([bytes], type ? { type } : {}), type);
    try {
      await this.engine.writeTx((session) => {
        session.insertRaw(table, JSON.stringify({ ...(type ? { contentType: type } : {}), size: bytes.byteLength, sha256 }), id);
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

  /** Response for `GET /api/storage/:id`. */
  async serve(id: string): Promise<Response> {
    const doc = (await this.engine.readTx((s) => s.get("_storage", id))).result;
    if (!doc) return new Response("Not found", { status: 404 });
    if (this.backend.presign) return Response.redirect(this.backend.presign(id), 302);
    const blob = await this.backend.get(id);
    if (!blob) return new Response("Not found", { status: 404 });
    const headers: Record<string, string> = { "cache-control": "public, max-age=31536000, immutable" };
    if (typeof doc.contentType === "string") headers["content-type"] = doc.contentType;
    return new Response(blob, { headers });
  }

  private deleteIn(session: DbSession, id: string) {
    const table = session.systemTable("_storage");
    if (this.engine.store.tableOfId(id) !== table) throw new Error(`"${id}" is not a storage id`);
    session.deleteRaw(table, id);
    session.onCommit(() => void this.backend.delete(id).catch((err) => console.error("[incibase] blob delete failed:", err)));
  }

  reader(session: DbSession) {
    return {
      getUrl: async (id: string) => ((await session.get("_storage", id)) ? this.urlFor(id) : null),
      getMetadata: (id: string) => session.get("_storage", id),
    };
  }

  writer(session: DbSession) {
    return {
      ...this.reader(session),
      generateUploadUrl: async () => this.createUploadUrl(),
      delete: async (id: string) => this.deleteIn(session, id),
    };
  }

  actionWriter() {
    const read = <T>(fn: (s: DbSession) => Promise<T>) => this.engine.readTx(fn).then((r) => r.result);
    return {
      getUrl: (id: string) => read(async (s) => ((await s.get("_storage", id)) ? this.urlFor(id) : null)),
      getMetadata: (id: string) => read((s) => s.get("_storage", id)),
      generateUploadUrl: async () => this.createUploadUrl(),
      delete: (id: string) => this.engine.writeTx((s) => this.deleteIn(s, id)),
      get: (id: string) => this.get(id),
      store: (blob: Blob, options?: { contentType?: string }) => this.store(blob, options?.contentType),
    };
  }
}
