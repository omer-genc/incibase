import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";
import { getFunctionPath, type FunctionType, type RegisteredFunction } from "../api.ts";
import { IncibaseError, isIncibaseError } from "../errors.ts";
import type { SchemaDefinition } from "../schema.ts";
import { ID_TABLE_RESOLVER } from "../values.ts";
import type { ActionCtx, CronJobs, HttpRouter, ServiceIdentity } from "../server.ts";
import { AuthService } from "./auth.ts";
import { DbSession, ValidationError } from "./database.ts";
import { DefinitionError } from "./exit-codes.ts";
import { argsSchemaOf } from "./jsonschema.ts";
import { color, isJson, logEvent, markLogged, SLOW_CALL_MS, wasLogged } from "./log.ts";
import { migrate, type MigrationReport } from "./migrate.ts";
import type { ReadSet } from "./readset.ts";
import { Realtime } from "./realtime.ts";
import { Scheduler, validateCrons } from "./scheduler.ts";
import type { ServiceKeys } from "./service-keys.ts";
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
  /** Let a migration delete stored fields the schema no longer has (otherwise it is refused). */
  allowFieldRemoval?: boolean;
  /** Service keys (`ik_svc_…`) accepted besides sessions and the admin key. */
  serviceKeys?: ServiceKeys | null;
}

export interface Identity {
  userId: string | null;
  admin: boolean;
  /** Scheduled jobs and crons: trusted server code without a user. */
  system?: boolean;
  /** The service key the caller used; `userId` is set when it acts as a user. Never admin. */
  service?: ServiceIdentity | null;
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

/** Module paths as the loader discovers them (`"chat/messages"`); other characters would break function paths. */
const MODULE_PATH_REGEX = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
/** Export names a function reference (`api.chat.messages.list`) can spell. */
const EXPORT_NAME_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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
    // Before the data dir is touched: an app incibase rejects leaves the database as it was.
    const { crons, http } = this.register(app);
    this.crons = crons;
    this.http = http;

    ensurePrivateDir(options.dataDir);
    this.store = new Store(join(options.dataDir, "data.db"));
    // A constructor that throws returns no engine to stop(): close the store here, or the data dir stays locked.
    try {
      this.migration = migrate(this.store, app.schema, { allowFieldRemoval: options.allowFieldRemoval });
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

  /** Registers the app's functions and checks its definitions; throws DefinitionError for what could not run. */
  private register(app: AppDefinition): { crons: CronJobs | null; http: HttpRouter | null } {
    if (app.schema !== undefined) {
      if ((app.schema as { __incibase?: string } | null)?.__incibase !== "schema") {
        throw new DefinitionError("The schema must be `export default defineSchema({...})`");
      }
      for (const [name, table] of Object.entries(app.schema.tables)) {
        if ((table as { __incibase?: string } | null)?.__incibase !== "table") {
          throw new DefinitionError(`Table "${name}" in the schema must be defineTable({...})`);
        }
      }
    }
    let crons: CronJobs | null = null;
    let http: HttpRouter | null = null;
    for (const [modulePath, ns] of Object.entries(app.modules)) {
      if (!MODULE_PATH_REGEX.test(modulePath)) {
        throw new DefinitionError(`Invalid module path "${modulePath}": use letters, digits and "_", separated by "/"`);
      }
      for (const [name, value] of Object.entries(ns)) {
        const marker = (value as { __incibase?: string } | null)?.__incibase;
        if (marker === "function") {
          if (!EXPORT_NAME_REGEX.test(name)) throw new DefinitionError(`Invalid function name "${name}" in ${modulePath}`);
          this.functions.set(functionPathOf(modulePath, name), value as RegisteredFunction);
        } else if (marker === "crons" && name === "default") crons = value as CronJobs;
        else if (marker === "httpRouter" && name === "default") http = value as HttpRouter;
      }
    }
    validateCrons(crons, this.functions);
    return { crons, http };
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

  /**
   * Records a call in the in-memory log the dashboard reads. In json mode it
   * is also printed when it failed or was slow (`INCIBASE_LOG_CALLS`: errors,
   * slow or all); `err` adds the stack of an unexpected error. `emit: false`
   * records only, for callers that log the failure themselves.
   */
  log(entry: Omit<LogEntry, "time">, { err, emit = true }: { err?: unknown; emit?: boolean } = {}) {
    const full = { time: Date.now(), ...entry };
    this.logs.push(full);
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
    if (!emit) return;
    if (isJson()) {
      const calls = process.env.INCIBASE_LOG_CALLS ?? "slow";
      const slow = entry.durationMs > SLOW_CALL_MS;
      if (entry.ok && !(calls === "all" || (calls === "slow" && slow))) return;
      const unexpected = !entry.ok && err instanceof Error && !isExpectedError(err) && !wasLogged(err);
      if (unexpected) markLogged(err);
      logEvent(entry.ok ? (slow ? "warn" : "info") : "error", {
        ev: entry.type === "cron" || entry.type === "scheduled" ? "job" : "call",
        type: entry.type,
        path: entry.path,
        ms: Math.round(entry.durationMs),
        ok: entry.ok,
        ...(slow ? { slow } : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
        ...(entry.userId ? { userId: entry.userId } : {}),
        ...(unexpected ? { stack: (err as Error).stack } : {}),
      });
    } else if (this.options.dev && !this.options.quiet) {
      const status = entry.ok ? color.green("✓") : color.red("✗");
      const suffix = entry.error ? ` ${color.red(entry.error)}` : "";
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
      this.log(
        {
          type: fn.type,
          path,
          durationMs: performance.now() - started,
          ok: false,
          error: (err as Error)?.message?.split("\n")[0] ?? String(err),
          userId: identity.userId,
        },
        { err },
      );
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Contexts

  private authFor(identity: Identity, loadUser: () => Promise<any>) {
    return {
      isAdmin: identity.admin,
      service: identity.service ? Object.freeze({ keyId: identity.service.keyId, scopes: Object.freeze([...identity.service.scopes]) }) : null,
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

/** Errors clients are told about (4xx); anything else is a bug worth its stack in the log. */
function isExpectedError(err: unknown): boolean {
  return isIncibaseError(err) || err instanceof ValidationError || err instanceof FunctionNotFoundError;
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
  if (isJson()) {
    if (!wasLogged(err)) logEvent("error", { ev: "error", err });
    markLogged(err);
  } else if (!dev) console.error("[incibase]", err);
  return { status: 500, error: { code: "INTERNAL_ERROR", message } };
}
