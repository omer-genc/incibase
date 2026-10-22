// Resource limits a host sets per process through the environment: upload
// size, total stored bytes, database size and concurrent uploads.
import type { Database } from "bun:sqlite";
import { IncibaseError } from "../errors.ts";
import { ConfigError } from "./exit-codes.ts";
import { logEvent } from "./log.ts";

/**
 * An error for a limit, with the HTTP status that says what kind it is
 * (413 too large, 503 busy, 507 out of space). Function callers get its code
 * like any IncibaseError.
 */
export class LimitError extends IncibaseError<{ code: string; message: string }> {
  constructor(
    data: { code: string; message: string },
    readonly status: number,
    /** Seconds to send as Retry-After. */
    readonly retryAfter?: number,
  ) {
    super(data);
  }
}

/** The HTTP answer to a LimitError; `error` is its payload (see toErrorPayload). */
export function limitResponse(err: LimitError, error: unknown): Response {
  const headers: Record<string, string> = err.retryAfter ? { "retry-after": String(err.retryAfter) } : {};
  return Response.json({ error }, { status: err.status, headers });
}

/** A positive whole number from `name`, or undefined when it is unset or empty. Anything else is a ConfigError. */
export function positiveIntFromEnv(name: string, what = "number"): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (!/^\s*\d+\s*$/.test(value) || !Number.isSafeInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive whole ${what}, got "${value}"`);
  }
  return n;
}

export const bytesFromEnv = (name: string) => positiveIntFromEnv(name, "number of bytes");

/** Checks every limit variable up front, so a bad value stops the start (ConfigError, exit 64) before the data dir is touched. */
export function checkLimitsEnv() {
  for (const name of ["INCIBASE_MAX_DB_BYTES", "INCIBASE_MAX_STORAGE_BYTES", "INCIBASE_MAX_UPLOAD_BYTES"]) bytesFromEnv(name);
  positiveIntFromEnv("INCIBASE_UPLOAD_CONCURRENCY");
  if (process.env.INCIBASE_S3_PREFIX !== undefined) s3PrefixFrom(undefined);
}

/** A setting given in code that must be a positive whole number when given. */
export function checkPositiveInt(value: number | undefined, what: string, unit = "number"): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new ConfigError(`${what} must be a positive whole ${unit}, got ${value}`);
  return value;
}

export const checkBytes = (value: number | undefined, what: string) => checkPositiveInt(value, what, "number of bytes");

/**
 * Caps the database at `INCIBASE_MAX_DB_BYTES` (or `maxDbBytes`) with
 * `PRAGMA max_page_count` on the write connection, the only one that writes.
 * SQLite never lowers the cap below the current size, so a database already
 * larger keeps working for reads and deletes but cannot grow. Writes past
 * the cap fail with DATABASE_FULL (see `databaseFullError`).
 */
export function limitDatabaseSize(db: Database, maxDbBytes?: number) {
  const bytes = bytesFromEnv("INCIBASE_MAX_DB_BYTES") ?? checkBytes(maxDbBytes, "maxDbBytes");
  if (bytes === undefined) return;
  const { page_size: pageSize } = db.query("PRAGMA page_size").get() as { page_size: number };
  const pages = Math.max(1, Math.floor(bytes / pageSize));
  const { max_page_count: set } = db.query(`PRAGMA max_page_count = ${pages}`).get() as { max_page_count: number };
  if (set > pages) {
    const msg = `the database (${set * pageSize} bytes) is already over INCIBASE_MAX_DB_BYTES (${bytes}); writes that need more space will fail`;
    logEvent("warn", { ev: "db_over_limit", msg, bytes: set * pageSize, limit: bytes }, [`[incibase] ${msg}`]);
  }
}

/** True for SQLite's "database or disk is full", which also rolls the whole transaction back. */
export function isDatabaseFull(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "SQLITE_FULL";
}

/** What a write that hit the database size cap (or a full disk) throws. */
export function databaseFullError(): LimitError {
  logEvent("error", { ev: "db_full", msg: "a write failed: the database is full" }, ["[incibase] a write failed: the database is full"]);
  return new LimitError(
    {
      code: "DATABASE_FULL",
      message: "The database is full (its size limit, INCIBASE_MAX_DB_BYTES, or the disk). Delete data or raise the limit.",
    },
    507,
  );
}

/** Safe S3 key prefixes: path segments of letters, digits, ".", "_" and "-", each ending in "/". */
const S3_PREFIX_REGEX = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+$/;

/**
 * The S3 key prefix from `prefix` or `INCIBASE_S3_PREFIX`, e.g.
 * `"shop/b7k2m9q4/"`: no leading slash, ending in "/", no empty, "." or ".."
 * segments. Empty means none.
 */
export function s3PrefixFrom(prefix: string | undefined): string {
  const fromEnv = prefix === undefined;
  const value = prefix ?? process.env.INCIBASE_S3_PREFIX ?? "";
  if (value === "") return "";
  if (value.length > 512 || !S3_PREFIX_REGEX.test(value)) {
    throw new ConfigError(
      `${fromEnv ? "INCIBASE_S3_PREFIX" : "storage.s3Prefix"} must be path segments of letters, digits, ".", "_" and "-" ` +
        `ending in "/", with no leading "/" (e.g. "shop/b7k2m9q4/"), got "${value}"`,
    );
  }
  return value;
}

/** The object key of a file in the bucket. */
export function s3Key(prefix: string, id: string): string {
  return prefix + id;
}
