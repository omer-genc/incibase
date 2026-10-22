import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { z } from "zod";
import { FIELD_PATH_REGEX, type IndexDefinition } from "../schema.ts";
import type { StorageField } from "./files.ts";
import { ID_REGEX } from "../values.ts";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export const SYSTEM_TABLES: Record<string, { number: number; indexes: IndexDefinition[] }> = {
  _users: { number: 1, indexes: [{ name: "by_email", fields: ["email"], unique: true }] },
  _storage: { number: 2, indexes: [{ name: "by_owner", fields: ["ownerId"], unique: false }] },
  _scheduled: { number: 3, indexes: [{ name: "by_state_runAt", fields: ["state", "runAt"], unique: false }] },
};
export const FIRST_USER_TABLE_NUMBER = 16;
const MAX_TABLE_NUMBER = 1023;

export interface TableInfo {
  name: string;
  number: number;
  system: boolean;
  validator?: z.ZodObject<any, any>;
  indexes: IndexDefinition[];
  /** Fields holding `_storage` ids (`file()` or `id("_storage")`). */
  storageFields?: StorageField[];
}

export interface Document {
  _id: string;
  _creationTime: number;
  [key: string]: unknown;
}

export interface DocumentRow {
  _id: string;
  _creationTime: number;
  data: string;
}

function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function tableNumberOfId(id: string): number | null {
  if (!ID_REGEX.test(id)) return null;
  return ALPHABET.indexOf(id[26]!) * 32 + ALPHABET.indexOf(id[27]!);
}

/**
 * `json_extract` expression for a (possibly dotted) field. The field is spliced
 * into SQL, so anything that is not a plain field path is refused here, whatever
 * the caller checked before.
 */
export function fieldExpr(field: string): string {
  if (field === "_id" || field === "_creationTime") return field;
  if (!FIELD_PATH_REGEX.test(field)) throw new Error(`Invalid field path "${field}"`);
  return `json_extract(data, '$.${field}')`;
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function rowToDoc(row: DocumentRow): Document {
  return { _id: row._id, _creationTime: row._creationTime, ...JSON.parse(row.data) };
}

// Owner-only access: other users on the host must not read the database or file blobs.
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Drops the permission bits of an existing `path` that `mode` does not allow. */
function restrictMode(path: string, mode: number) {
  if (process.platform === "win32") return;
  let current: number;
  try {
    current = statSync(path).mode & 0o777;
  } catch {
    return;
  }
  if ((current & ~mode) === 0) return;
  try {
    chmodSync(path, current & mode);
  } catch (err) {
    console.warn(`[incibase] could not restrict ${path} to mode ${mode.toString(8)}: ${(err as Error).message}`);
  }
}

/** Creates `dir` (mode 0700), or tightens it if it already exists. */
export function ensurePrivateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  restrictMode(dir, PRIVATE_DIR_MODE);
}

/**
 * Creates an empty `path` (mode 0600), or tightens it, and says whether it
 * created it. SQLite gives -wal and -shm files the mode of their database.
 */
function ensurePrivateFile(path: string): boolean {
  let created = false;
  // Only open the file when it is missing: closing another descriptor of a
  // file drops this process's SQLite (POSIX) locks on it.
  if (!existsSync(path)) {
    try {
      writeFileSync(path, "", { flag: "wx", mode: PRIVATE_FILE_MODE });
      created = true;
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
    }
  }
  restrictMode(path, PRIVATE_FILE_MODE);
  return created;
}

/**
 * Whether another connection (in any process) has the database at `path`
 * open: a connection that has used a WAL database holds a shared lock on it
 * until it closes, which an exclusive-mode transaction cannot get past.
 */
function openElsewhere(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { readwrite: true });
  try {
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    db.run("BEGIN EXCLUSIVE");
    db.run("COMMIT");
    return false;
  } catch (err) {
    if ((err as { code?: string }).code === "SQLITE_BUSY") return true;
    throw err;
  } finally {
    db.close();
  }
}

export class DataDirLockedError extends Error {
  constructor(readonly dataDir: string) {
    super(`Data directory ${dataDir} is in use by another incibase process. Stop it first, or use a different data directory.`);
    this.name = "DataDirLockedError";
  }
}

/**
 * One process serves a data dir at a time: a second one would run every cron
 * again and fail the first one's running jobs on start. The lock is an open
 * EXCLUSIVE transaction on `<dir>/LOCK`; the OS drops it when the process
 * exits or crashes, so it never goes stale. Never delete LOCK: the lock is on
 * the file, so a process that creates a new one gets a lock of its own.
 *
 * As a backstop, a process that has to create LOCK (first start, a deleted
 * LOCK, or a data dir of an incibase without the lock) first checks that no
 * other process has `database` open. If one does, it removes the LOCK it
 * created, so the next start checks again.
 */
export class DataDirLock {
  private db: Database | null;

  constructor(dir: string, database?: string) {
    const path = join(dir, "LOCK");
    const created = ensurePrivateFile(path);
    const db = new Database(path, { create: true });
    try {
      db.run("PRAGMA locking_mode = EXCLUSIVE");
      db.run("PRAGMA journal_mode = MEMORY"); // no LOCK-journal file
      db.run("BEGIN EXCLUSIVE");
    } catch (err) {
      db.close();
      const code = (err as { code?: string }).code;
      if (code === "SQLITE_BUSY") throw new DataDirLockedError(resolve(dir));
      if (code === "SQLITE_NOTADB") {
        throw new Error(
          `${resolve(path)} is not an incibase lock file (incibase keeps an empty SQLite database there). ` +
            `If another tool wrote it, move it away; then start again.`,
        );
      }
      throw err;
    }
    try {
      if (created && database && openElsewhere(database)) throw new DataDirLockedError(resolve(dir));
    } catch (err) {
      // Removed while still held, so the next start finds no LOCK and checks again.
      try {
        rmSync(path, { force: true });
      } catch {
        // best effort: Windows cannot remove an open file
      }
      db.close();
      throw err;
    }
    this.db = db;
  }

  release() {
    this.db?.close();
    this.db = null;
  }
}

/**
 * Reads one `_incibase_meta` value over a read-only connection: no lock, no
 * DDL and no writes, so it is safe while a server runs on the database.
 */
export function readMeta(path: string, key: string): string | null {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    if (!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_incibase_meta'`).get()) return null;
    const row = db.query(`SELECT value FROM _incibase_meta WHERE key = ?`).get(key) as { value: string } | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/**
 * Two SQLite connections on one WAL database: `write` runs mutations one at a
 * time, `read` runs queries against the last committed state. A Store holds
 * the lock of the database's directory until it is closed.
 */
export class Store {
  readonly write: Database;
  readonly read: Database;
  readonly tables = new Map<string, TableInfo>();
  private readonly byNumber = new Map<number, TableInfo>();
  private readonly lock: DataDirLock;
  private lastCreationTime = 0;

  constructor(readonly path: string) {
    this.lock = new DataDirLock(dirname(path), path);
    let write: Database | undefined;
    try {
      ensurePrivateFile(path);
      restrictMode(`${path}-wal`, PRIVATE_FILE_MODE);
      restrictMode(`${path}-shm`, PRIVATE_FILE_MODE);
      this.write = write = new Database(path, { create: true, strict: true });
      this.write.run("PRAGMA journal_mode = WAL");
      this.write.run("PRAGMA synchronous = NORMAL");
      this.write.run("PRAGMA busy_timeout = 5000");
      this.initSystem();
      this.read = new Database(path, { readonly: true, strict: true });
      this.read.run("PRAGMA busy_timeout = 5000");
    } catch (err) {
      write?.close();
      this.lock.release();
      throw err;
    }
  }

  close() {
    this.read.close();
    this.write.close();
    this.lock.release();
  }

  private initSystem() {
    const db = this.write;
    db.run(`CREATE TABLE IF NOT EXISTS _incibase_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS _incibase_tables (
      name TEXT PRIMARY KEY,
      number INTEGER NOT NULL UNIQUE,
      json_schema TEXT,
      indexes TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS _sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at REAL NOT NULL,
      expires_at REAL NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS _sessions__by_user ON _sessions (user_id)`);
    db.run(`CREATE TABLE IF NOT EXISTS _passwords (user_id TEXT PRIMARY KEY, hash TEXT NOT NULL)`);
    for (const [name, { number, indexes }] of Object.entries(SYSTEM_TABLES)) {
      this.createDocumentTable(name);
      for (const index of indexes) this.createIndex(name, index);
      this.register({ name, number, system: true, indexes });
    }
  }

  register(info: TableInfo) {
    this.tables.set(info.name, info);
    this.byNumber.set(info.number, info);
  }

  unregister(name: string) {
    const info = this.tables.get(name);
    if (!info) return;
    this.tables.delete(name);
    this.byNumber.delete(info.number);
  }

  createDocumentTable(name: string) {
    const t = quoteIdent(name);
    this.write.run(`CREATE TABLE IF NOT EXISTS ${t} (
      _id TEXT PRIMARY KEY,
      _creationTime REAL NOT NULL,
      data TEXT NOT NULL
    )`);
    this.write.run(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`${name}__by_creation_time`)} ON ${t} (_creationTime, _id)`);
  }

  createIndex(table: string, index: IndexDefinition) {
    const cols = index.fields.map(fieldExpr);
    if (!index.unique) cols.push("_creationTime", "_id");
    this.write.run(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${quoteIdent(`${table}__${index.name}`)} ON ${quoteIdent(table)} (${cols.join(", ")})`,
    );
  }

  dropIndex(table: string, indexName: string) {
    this.write.run(`DROP INDEX IF EXISTS ${quoteIdent(`${table}__${indexName}`)}`);
  }

  tableOfId(id: string): TableInfo | null {
    const n = tableNumberOfId(id);
    return n === null ? null : (this.byNumber.get(n) ?? null);
  }

  newId(table: TableInfo): string {
    const bytes = Bun.randomUUIDv7("buffer");
    const n = table.number;
    if (n > MAX_TABLE_NUMBER) throw new Error("Too many tables");
    return encodeBase32(bytes) + ALPHABET[n >> 5]! + ALPHABET[n & 31]!;
  }

  /** Milliseconds, strictly increasing within this process. */
  nextCreationTime(): number {
    const now = Date.now();
    this.lastCreationTime = now > this.lastCreationTime ? now : this.lastCreationTime + 0.001;
    return this.lastCreationTime;
  }

  getMeta(key: string): string | null {
    const row = this.write.query(`SELECT value FROM _incibase_meta WHERE key = ?`).get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.write.query(`INSERT INTO _incibase_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }
}
