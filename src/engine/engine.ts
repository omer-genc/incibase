import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { getFunctionPath, type FunctionType, type RegisteredFunction } from "../api.ts";
import { IncibaseError, isIncibaseError } from "../errors.ts";
import type { SchemaDefinition } from "../schema.ts";
import { ID_TABLE_RESOLVER } from "../values.ts";
import type { ActionCtx, CronJobs, HttpRouter } from "../server.ts";
import { AuthService } from "./auth.ts";
import { DbSession, ValidationError } from "./database.ts";
import { argsSchemaOf } from "./jsonschema.ts";
import { migrate, type MigrationReport } from "./migrate.ts";
import type { ReadSet } from "./readset.ts";
import { Realtime } from "./realtime.ts";
import { Scheduler } from "./scheduler.ts";
import { StorageService, type StorageOptions } from "./storage.ts";
import { ensurePrivateDir, Store } from "./store.ts";

export interface AppDefinition {
  schema?: SchemaDefinition;
  /** Module path (e.g. `"chat/messages"`) → module namespace. */
  modules: Record<string, Record<string, unknown>>;
}

export interface EngineOptions {
  dataDir: string;
  dev?: boolean;
  /** Base URL clients reach this server at; used for storage URLs. */
  publicUrl: string;
  adminKey?: string;
  storage?: StorageOptions;
  quiet?: boolean;
}

export interface Identity {
  userId: string | null;
  admin: boolean;
  /** Scheduled jobs and crons: trusted server code without a user. */
  system?: boolean;
}

export const ANONYMOUS: Identity = { userId: null, admin: false };

export interface CallOptions {
  /** Internal functions are callable from server code, the scheduler and admins only. */
  allowInternal?: boolean;
  expectType?: FunctionType;
}

export class FunctionNotFoundError extends Error {
  constructor(path: string, message = `Function "${path}" not found`) {
    super(message);
    this.name = "FunctionNotFoundError";
  }
}

export interface LogEntry {
  time: number;
  type: FunctionType | "http" | "cron" | "scheduled";
  path: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  userId?: string | null;
}

export interface WriteTxOptions {
  /**
   * How long to wait for another process's write lock, instead of the
   * connection's busy_timeout. bun:sqlite waits synchronously, blocking the
   * event loop, so background work that retries on its own waits briefly.
   */
  busyTimeoutMs?: number;
}

/** `BEGIN IMMEDIATE`, waiting at most `busyTimeoutMs` (when given) for the write lock. */
function begin(db: Database, busyTimeoutMs?: number) {
  if (busyTimeoutMs === undefined) return db.run("BEGIN IMMEDIATE");
  const { timeout } = db.query("PRAGMA busy_timeout").get() as { timeout: number };
  db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  try {
    db.run("BEGIN IMMEDIATE");
  } finally {
    db.run(`PRAGMA busy_timeout = ${timeout}`);
  }
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** Splits the module path and the export name: `"chat/messages:list"`. */
export function functionPathOf(modulePath: string, exportName: string) {
  return `${modulePath}:${exportName}`;
}

export class Engine {
  readonly store: Store;
  readonly functions = new Map<string, RegisteredFunction>();
  readonly crons: CronJobs | null;
  readonly http: HttpRouter | null;
  readonly auth: AuthService;
  readonly storage: StorageService;
  readonly scheduler: Scheduler;
  readonly realtime: Realtime;
  readonly adminKey: string;
  readonly migration: MigrationReport;
  readonly logs: LogEntry[] = [];
  /** When this engine started; changes on every (dev) restart. */
  readonly startedAt = Date.now();

  private readonly readLock = new Mutex();
  private readonly writeLock = new Mutex();

  constructor(
    readonly app: AppDefinition,
    readonly options: EngineOptions,
  ) {
    ensurePrivateDir(options.dataDir);
    this.store = new Store(join(options.dataDir, "data.db"));
    // A constructor that throws returns no engine to stop(): close the store here, or the data dir stays locked.
    try {
      this.migration = migrate(this.store, app.schema);

      let crons: CronJobs | null = null;
      let http: HttpRouter | null = null;
      for (const [modulePath, ns] of Object.entries(app.modules)) {
        for (const [name, value] of Object.entries(ns)) {
          const marker = (value as { __incibase?: string } | null)?.__incibase;
          if (marker === "function") this.functions.set(functionPathOf(modulePath, name), value as RegisteredFunction);
          else if (marker === "crons" && name === "default") crons = value as CronJobs;
          else if (marker === "httpRouter" && name === "default") http = value as HttpRouter;
        }
      }
      this.crons = crons;
      this.http = http;

      this.adminKey = options.adminKey ?? process.env.INCIBASE_ADMIN_KEY ?? this.loadOrCreateAdminKey();
      this.auth = new AuthService(this);
      this.storage = new StorageService(this, options.storage);
      this.scheduler = new Scheduler(this);
      this.realtime = new Realtime(this);
    } catch (err) {
      this.store.close();
      throw err;
    }
    (globalThis as Record<symbol, unknown>)[ID_TABLE_RESOLVER] = (id: string) => this.store.tableOfId(id)?.name ?? null;
  }

  start() {
    this.scheduler.start();
  }

  async stop() {
    this.scheduler.stop();
    this.realtime.stop();
    await this.writeLock.run(() => {});
    await this.readLock.run(() => {});
    this.store.close();
  }

  private loadOrCreateAdminKey(): string {
    const existing = this.store.getMeta("admin_key");
    if (existing) return existing;
    const key = `ik_admin_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
    this.store.setMeta("admin_key", key);
    return key;
  }

  log(entry: Omit<LogEntry, "time">) {
    const full = { time: Date.now(), ...entry };
    this.logs.push(full);
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
    if (this.options.dev && !this.options.quiet) {
      const status = entry.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      const suffix = entry.error ? ` \x1b[31m${entry.error}\x1b[0m` : "";
      console.log(`${status} [${entry.type}] ${entry.path} ${entry.durationMs.toFixed(1)}ms${suffix}`);
    }
  }

  // -------------------------------------------------------------------------
  // Transactions

  /** Serialized write transaction on the write connection. Notifies subscribers after commit. */
  /** `identity` is who writes, for file ownership checks; omitted means trusted engine code. */
  writeTx<T>(fn: (session: DbSession) => Promise<T> | T, identity?: Identity, options: WriteTxOptions = {}): Promise<T> {
    return this.writeLock.run(async () => {
      const db = this.store.write;
      const session = new DbSession(this.store, db, true, identity);
      begin(db, options.busyTimeoutMs);
      let result: T;
      try {
        result = await fn(session);
        db.run("COMMIT");
      } catch (err) {
        if (db.inTransaction) db.run("ROLLBACK");
        throw err;
      }
      session.runCommitHooks();
      if (session.changes.length) this.realtime.invalidate(session.changes);
      return result;
    });
  }

  /** Snapshot read transaction on the read connection. */
  readTx<T>(fn: (session: DbSession) => Promise<T> | T): Promise<{ result: T; session: DbSession }> {
    return this.readLock.run(async () => {
      const db = this.store.read;
      const session = new DbSession(this.store, db, false);
      db.run("BEGIN");
      try {
        return { result: await fn(session), session };
      } finally {
        if (db.inTransaction) db.run("COMMIT");
      }
    });
  }

  // -------------------------------------------------------------------------
  // Function calls

  resolve(path: string, options: CallOptions): RegisteredFunction {
    const fn = this.functions.get(path);
    if (!fn || (fn.visibility === "internal" && !options.allowInternal)) throw new FunctionNotFoundError(path);
    if (options.expectType && fn.type !== options.expectType) {
      throw new FunctionNotFoundError(path, `"${path}" is a ${fn.type}, not a ${options.expectType}`);
    }
    return fn;
  }

  parseArgs(fn: RegisteredFunction, args: unknown): unknown {
    const result = argsSchemaOf(fn).safeParse(args ?? {});
    if (!result.success) {
      throw new ValidationError(`Invalid arguments:\n${z.prettifyError(result.error)}`, result.error.issues);
    }
    return result.data;
  }

  private finish(fn: RegisteredFunction, value: unknown): unknown {
    if (fn.returns) {
      const result = fn.returns.safeParse(value);
      if (!result.success) throw new Error(`Return value does not match \`returns\`:\n${z.prettifyError(result.error)}`);
      value = result.data;
    }
    return value === undefined ? null : value;
  }

  async call(path: string, args: unknown, identity: Identity, options: CallOptions = {}): Promise<unknown> {
    return (await this.callTracked(path, args, identity, options)).value;
  }

  /** Like `call`, but also returns what a query read (for subscriptions). */
  async callTracked(
    path: string,
    args: unknown,
    identity: Identity,
    options: CallOptions = {},
  ): Promise<{ value: unknown; reads: ReadSet[] }> {
    const fn = this.resolve(path, options);
    const started = performance.now();
    try {
      const parsed = this.parseArgs(fn, args);
      let value: unknown;
      let reads: ReadSet[] = [];
      if (fn.type === "query") {
        const { result, session } = await this.readTx(async (session) =>
          this.finish(fn, await fn.handler(this.queryCtx(session, identity), parsed)),
        );
        value = result;
        reads = session.reads;
      } else if (fn.type === "mutation") {
        value = await this.writeTx(
          async (session) => this.finish(fn, await fn.handler(this.mutationCtx(session, identity), parsed)),
          identity,
        );
      } else {
        value = this.finish(fn, await fn.handler(this.actionCtx(identity), parsed));
      }
      this.log({ type: fn.type, path, durationMs: performance.now() - started, ok: true, userId: identity.userId });
      return { value, reads };
    } catch (err) {
      this.log({
        type: fn.type,
        path,
        durationMs: performance.now() - started,
        ok: false,
        error: (err as Error)?.message?.split("\n")[0] ?? String(err),
        userId: identity.userId,
      });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Contexts

  private authFor(identity: Identity, loadUser: () => Promise<any>) {
    return {
      isAdmin: identity.admin,
      getUserId: async () => identity.userId,
      getUser: async () => (identity.userId ? await loadUser() : null),
      requireUser: async () => {
        const user = identity.userId ? await loadUser() : null;
        if (!user) throw new IncibaseError({ code: "UNAUTHENTICATED", message: "Sign in required" });
        return user;
      },
    };
  }

  queryCtx(session: DbSession, identity: Identity) {
    return {
      db: session.reader(),
      auth: this.authFor(identity, () => session.get(identity.userId!)),
      storage: this.storage.reader(session, identity),
    };
  }

  mutationCtx(session: DbSession, identity: Identity) {
    return {
      db: session.writer(),
      auth: this.authFor(identity, () => session.get(identity.userId!)),
      storage: this.storage.writer(session, identity),
      scheduler: this.scheduler.forSession(session),
    };
  }

  actionCtx(identity: Identity): ActionCtx {
    const run = (type: FunctionType) => (ref: any, args?: unknown) =>
      this.call(getFunctionPath(ref), args ?? {}, identity, { allowInternal: true, expectType: type });
    return {
      runQuery: run("query"),
      runMutation: run("mutation"),
      runAction: run("action"),
      auth: this.authFor(identity, async () => (await this.readTx((s) => s.get(identity.userId!))).result),
      storage: this.storage.actionWriter(identity),
      scheduler: this.scheduler.standalone(),
    } as unknown as ActionCtx;
  }
}

/** Shape of errors sent to clients. */
export interface ErrorPayload {
  code: string;
  message: string;
  data?: unknown;
  /** Set when a function threw an IncibaseError; clients rethrow it as one. */
  application?: boolean;
}

export function toErrorPayload(err: unknown, dev: boolean): { status: number; error: ErrorPayload } {
  if (isIncibaseError(err)) {
    const data = err.data as { code?: unknown; message?: unknown } | string;
    const code = typeof data === "object" && data && typeof data.code === "string" ? data.code : "APPLICATION_ERROR";
    const status = code === "UNAUTHENTICATED" ? 401 : code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : 400;
    const message = typeof data === "string" ? data : typeof data?.message === "string" ? data.message : err.message;
    return { status, error: { code, message, data: err.data, application: true } };
  }
  if (err instanceof ValidationError) {
    return { status: 400, error: { code: "VALIDATION_ERROR", message: err.message, data: err.issues } };
  }
  if (err instanceof FunctionNotFoundError) {
    return { status: 404, error: { code: "FUNCTION_NOT_FOUND", message: err.message } };
  }
  const message = dev ? ((err as Error)?.stack ?? String(err)) : "Internal server error";
  if (!dev) console.error("[incibase]", err);
  return { status: 500, error: { code: "INTERNAL_ERROR", message } };
}
