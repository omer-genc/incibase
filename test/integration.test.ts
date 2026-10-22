// Problems that only show when M1's features run together (a review of the
// merged steps 1-8): drain and the client's retry, migrations and the
// database cap, uploads and the quota, and serve's start order.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IncibaseClient } from "incibase/client";
import { action, defineSchema, defineTable, mutation, query, z } from "incibase/server";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { ConfigError, exitCodeOf, ExitCode } from "../src/engine/exit-codes.ts";
import { startServer } from "../src/engine/http.ts";
import { loadAppFromDir } from "../src/engine/loader.ts";
import { MigrationError } from "../src/engine/migrate.ts";
import { Store } from "../src/engine/store.ts";
import { memoryStorage, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const engines: Engine[] = [];
const servers: { stop: (force?: boolean) => unknown }[] = [];

function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

function open(app: AppDefinition, dataDir = dir(), options: Partial<ConstructorParameters<typeof Engine>[1]> = {}) {
  const engine = new Engine(app, { dataDir, quiet: true, publicUrl: "http://localhost", ...options });
  engines.push(engine);
  return engine;
}

function serve(engine: Engine) {
  const server = startServer(engine, { port: 0, hostname: "127.0.0.1" });
  servers.push(server);
  engine.options.publicUrl = server.url.origin;
  return server.url.origin;
}

async function until(check: () => unknown, what: string, timeoutMs = 5000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const e of engines.splice(0)) await e.stop().catch(() => {});
});

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A drain that runs out, and the client's retry of unprocessed calls

describe("calls a drain cuts", () => {
  const started = { hang: 0 };
  const app: AppDefinition = {
    schema: defineSchema({ notes: defineTable({ body: z.string() }) }),
    modules: {
      app: {
        hang: mutation({
          args: { body: z.string() },
          handler: async (ctx: any, { body }: { body: string }) => {
            await ctx.db.insert("notes", { body });
            started.hang++;
            await new Promise(() => {});
          },
        }),
        add: mutation({ args: { body: z.string() }, handler: (ctx: any, { body }: { body: string }) => ctx.db.insert("notes", { body }) }),
        notes: query({ handler: async (ctx: any) => (await ctx.db.query("notes").collect()).map((n: { body: string }) => n.body) }),
        slowAction: action({ handler: () => new Promise(() => {}) }),
      },
    },
  };

  test("a cut mutation is a 503 marked unprocessed, which the client sends again; a cut action is not marked", async () => {
    started.hang = 0;
    const stopping = open(app);
    const stoppingUrl = serve(stopping);
    // The process that comes back after the restart: same app, its own data.
    const next = open(app);
    const nextUrl = serve(next);

    const raw = fetch(`${stoppingUrl}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ path: "app:hang", args: { body: "raw" } }),
    });
    const action = fetch(`${stoppingUrl}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "app:slowAction" }),
    });
    await until(() => started.hang === 1 && stopping.runningCalls().includes("app:slowAction"), "the calls to start");
    stopping.cutCalls();
    const res = await raw;
    expect(res.status).toBe(503);
    expect(res.headers.get("x-incibase-unprocessed")).toBe("1");
    expect(res.headers.get("retry-after")).toBe("1");
    // A browser may read it.
    expect(res.headers.get("access-control-expose-headers")).toContain("x-incibase-unprocessed");
    expect((await res.json()).error).toMatchObject({ code: "SERVER_STOPPING", data: { unprocessed: true } });
    const interrupted = await action;
    expect(interrupted.status).toBe(503);
    expect(interrupted.headers.get("x-incibase-unprocessed")).toBeNull();
    expect((await interrupted.json()).error.code).toBe("ACTION_INTERRUPTED");

    // The client: its first attempt reaches the stopping server and is cut; it sends the mutation again, to the next one.
    started.hang = 0;
    const stopping2 = open(app);
    const stopping2Url = serve(stopping2);
    const sentTo: string[] = [];
    const client = new IncibaseClient(stopping2Url, {
      tokenStorage: memoryStorage(),
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const target = sentTo.length === 0 ? url : url.replace(stopping2Url, nextUrl);
        sentTo.push(target.startsWith(nextUrl) ? "next" : "stopping");
        // The stopping server gets the hanging mutation; the next one gets the same call as a plain add.
        const body = sentTo.length === 1 ? init?.body : String(init?.body).replace("app:hang", "app:add");
        return fetch(target, { ...init, body });
      }) as typeof fetch,
    });
    const call = client.mutation("app:hang" as any, { body: "resent" });
    await until(() => started.hang === 1, "the first attempt to start");
    stopping2.cutCalls();
    expect(await call).toBeString();
    expect(sentTo).toEqual(["stopping", "next"]);
    // Nothing of the cut attempt was kept; the resent one was.
    expect((await stopping2.readTx((s) => s.query("notes").collect())).result).toEqual([]);
    expect((await next.readTx((s) => s.query("notes").collect())).result.map((n) => n.body)).toEqual(["resent"]);
  });
});

// ---------------------------------------------------------------------------
// Migrations under the database cap, and errors that are no verdict on the release

const notesSchema = (withIndex: boolean) =>
  defineSchema({ notes: withIndex ? defineTable({ body: z.string() }).index("by_body", ["body"]) : defineTable({ body: z.string() }) });

/** A data dir holding `count` notes of about 1 KB each; returns its database size in bytes. */
async function bigNotes(dataDir: string, count: number) {
  const engine = new Engine({ schema: notesSchema(false), modules: {} }, { dataDir, quiet: true, publicUrl: "http://localhost" });
  const body = "x".repeat(1000);
  await engine.writeTx(async (s) => {
    for (let i = 0; i < count; i++) await s.insert("notes", { body: `${i}${body}` });
  });
  await engine.stop();
  return dbBytes(dataDir);
}

function dbBytes(dataDir: string) {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    const { page_count } = db.query("PRAGMA page_count").get() as { page_count: number };
    const { page_size } = db.query("PRAGMA page_size").get() as { page_size: number };
    return page_count * page_size;
  } finally {
    db.close();
  }
}

function indexesOf(dataDir: string) {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    return (db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
  } finally {
    db.close();
  }
}

describe("migrations and the database cap", () => {
  test("a migration that would grow the database past INCIBASE_MAX_DB_BYTES is refused (65) and changes nothing", async () => {
    const data = dir();
    const before = await bigNotes(data, 3000);
    const cap = before + 64 * 1024;
    let err: unknown;
    try {
      open({ schema: notesSchema(true), modules: {} }, data, { maxDbBytes: cap });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MigrationError);
    expect(exitCodeOf(err)).toBe(ExitCode.MIGRATION_REFUSED);
    expect((err as Error).message).toContain(`past INCIBASE_MAX_DB_BYTES (${cap})`);
    expect(indexesOf(data)).not.toContain("notes__by_body");
    expect(dbBytes(data)).toBe(before);
    // The environment variable is the same cap.
    const prev = process.env.INCIBASE_MAX_DB_BYTES;
    process.env.INCIBASE_MAX_DB_BYTES = String(cap);
    try {
      expect(() => open({ schema: notesSchema(true), modules: {} }, data)).toThrow(MigrationError);
    } finally {
      if (prev === undefined) delete process.env.INCIBASE_MAX_DB_BYTES;
      else process.env.INCIBASE_MAX_DB_BYTES = prev;
    }
    // With room for it, the same migration commits.
    const engine = open({ schema: notesSchema(true), modules: {} }, data, { maxDbBytes: before * 10 });
    expect(engine.migration.addedIndexes).toEqual(["notes.by_body"]);
  }, 30_000);

  test("a database already over its cap still starts, and migrates when the migration does not grow it", async () => {
    const data = dir();
    const before = await bigNotes(data, 500);
    const quiet = silence();
    try {
      // Dropping nothing and adding nothing: no growth.
      const same = open({ schema: notesSchema(false), modules: {} }, data, { maxDbBytes: 4096 });
      await same.stop();
      expect(dbBytes(data)).toBe(before);
      // A new empty table needs pages: refused.
      expect(() =>
        open({ schema: defineSchema({ notes: defineTable({ body: z.string() }), more: defineTable({ n: z.number() }) }), modules: {} }, data, {
          maxDbBytes: 4096,
        }),
      ).toThrow(MigrationError);
    } finally {
      quiet.restore();
    }
  }, 30_000);

  test("only a constraint failure while building an index refuses the migration; a write error is thrown as it is", async () => {
    const data = dir();
    await bigNotes(data, 10);
    const create = spyOn(Store.prototype, "createIndex").mockImplementation(function (this: Store, table: string) {
      if (table !== "notes") return;
      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_WRITE" });
    });
    let err: unknown;
    try {
      open({ schema: notesSchema(true), modules: {} }, data);
    } catch (e) {
      err = e;
    } finally {
      create.mockRestore();
    }
    expect(err).not.toBeInstanceOf(MigrationError);
    expect((err as { code?: string }).code).toBe("SQLITE_IOERR_WRITE");
    expect(exitCodeOf(err)).toBe(ExitCode.CRASH);
    // Duplicates under a unique index are still a refused migration.
    const unique = defineSchema({ notes: defineTable({ body: z.string() }).index("by_body", ["body"], { unique: true }) });
    const engine = open({ schema: notesSchema(false), modules: {} }, dir());
    await engine.writeTx(async (s) => {
      await s.insert("notes", { body: "same" });
      await s.insert("notes", { body: "same" });
    });
    const dupData = engine.options.dataDir;
    await engine.stop();
    expect(() => open({ schema: unique, modules: {} }, dupData)).toThrow(MigrationError);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A data dir whose database cannot be used at all

describe("an unusable database", () => {
  const app = () => ({ schema: notesSchema(false), modules: {} });
  const configError = (dataDir: string, what: string) => {
    let err: unknown;
    try {
      open(app(), dataDir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(exitCodeOf(err)).toBe(ExitCode.CONFIG);
    expect((err as Error).message).toContain(what);
  };

  test("LOCK or data.db being a directory is a ConfigError (64), not a crash to restart", () => {
    const lockDir = dir();
    mkdirSync(join(lockDir, "LOCK"));
    configError(lockDir, "LOCK");
    const dbDir = dir();
    mkdirSync(join(dbDir, "data.db"));
    configError(dbDir, "data.db");
  });

  test.skipIf(process.getuid?.() === 0)("a read-only data.db is a ConfigError (64) naming the owner and mode", async () => {
    const data = dir();
    await bigNotes(data, 1);
    chmodSync(join(data, "data.db"), 0o400);
    try {
      configError(data, "owner and mode");
    } finally {
      chmodSync(join(data, "data.db"), 0o600);
    }
  });
});

// ---------------------------------------------------------------------------
// serve, from the CLI

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function childEnv(extra: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("INCIBASE_") && k !== "NO_COLOR" && k !== "FORCE_COLOR"));
  return { ...env, INCIBASE_RESTART: "1", ...extra };
}

async function cli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe", env: childEnv(env), timeout: 20_000, killSignal: "SIGKILL" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const events = stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, any>);
  return { stdout, stderr, code, events };
}

const APP_SCHEMA = `import { defineSchema, defineTable, z } from "incibase/server";
export default defineSchema({ notes: defineTable({ body: z.string() }) });
`;
const APP_MODULE = `import { internalMutation, mutation, z } from "incibase/server";
export const later = mutation({ handler: async (ctx) => ctx.scheduler.runAfter(0, "app:job" as any) });
export const job = internalMutation({ handler: async (ctx) => { await ctx.db.insert("notes", { body: "job" }); await Bun.sleep(300); } });
`;

function appDir() {
  const root = dir();
  const source = join(root, "app");
  mkdirSync(source);
  writeFileSync(join(source, "schema.ts"), APP_SCHEMA);
  writeFileSync(join(source, "app.ts"), APP_MODULE);
  return { root, source, data: join(root, "data") };
}

describe("serve --migrate-only on a data dir without a database", () => {
  test("is refused (64) and creates nothing, unless --allow-empty says it is a new app", async () => {
    const p = appDir();
    mkdirSync(p.data);
    const refused = await cli(["serve", "--migrate-only", "--dir", p.source, "--data", p.data, "--port", "0", "--log-format", "json"]);
    expect(refused.code).toBe(ExitCode.CONFIG);
    expect(refused.events.find((e) => e.ev === "fatal")!.msg).toContain("no database at");
    expect(existsSync(join(p.data, "data.db"))).toBe(false);
    const missingDir = await cli(["serve", "--migrate-only", "--dir", p.source, "--data", join(p.root, "nowhere"), "--port", "0"]);
    expect(missingDir.code).toBe(ExitCode.CONFIG);
    expect(existsSync(join(p.root, "nowhere"))).toBe(false);
    const empty = await cli(["serve", "--migrate-only", "--allow-empty", "--dir", p.source, "--data", p.data, "--port", "0", "--log-format", "json"]);
    expect(empty.code).toBe(0);
    expect(empty.events.find((e) => e.ev === "migrate_only")).toMatchObject({ changed: true, createdTables: ["notes"] });
    // On its own, --allow-empty is a mistake.
    expect((await cli(["serve", "--allow-empty", "--dir", p.source, "--data", p.data, "--port", "0"])).code).toBe(ExitCode.CONFIG);
  }, 30_000);
});

const HOSTED = { INCIBASE_ADMIN_KEY: "ik_admin_integration_test_key", INCIBASE_STORAGE_SECRET: "integration-test-storage-secret-0123456789" };

describe("serve's start order", () => {
  test("a listener that fails (75) leaves due jobs unclaimed: the scheduler starts only once serve listens", async () => {
    const p = appDir();
    // Hosted mode refuses a database that holds secrets, so this one is made without them.
    process.env.INCIBASE_STORAGE_SECRET = HOSTED.INCIBASE_STORAGE_SECRET;
    try {
      const engine = new Engine(await loadAppFromDir(p.source), { dataDir: p.data, quiet: true, publicUrl: "http://localhost", adminKey: HOSTED.INCIBASE_ADMIN_KEY });
      await engine.call("app:later", {}, { userId: null, admin: true });
      await engine.stop();
    } finally {
      delete process.env.INCIBASE_STORAGE_SECRET;
    }
    // A live server on the admin socket path: serve binds the public socket, probes the admin one, then exits 75.
    const admin = join(p.root, "admin.sock");
    const squatter = Bun.listen({ unix: admin, socket: { data() {} } });
    try {
      const result = await cli(
        ["serve", "--dir", p.source, "--data", p.data, "--socket", join(p.root, "http.sock"), "--admin-socket", admin, "--url", "https://shop.test", "--log-format", "json"],
        HOSTED,
      );
      expect(result.code).toBe(ExitCode.TEMPORARY);
    } finally {
      squatter.stop(true);
    }
    const db = new Database(join(p.data, "data.db"), { readonly: true });
    try {
      const jobs = (db.query(`SELECT data FROM _scheduled`).all() as { data: string }[]).map((r) => JSON.parse(r.data));
      expect(jobs).toMatchObject([{ name: "app:job", state: "pending" }]);
      expect(jobs[0].attempts ?? 0).toBe(0);
      expect(db.query(`SELECT COUNT(*) AS n FROM notes`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Uploads: a crash on the way, the stop, and the defaults of a plain app

const STORAGE_ADMIN = "ik_admin_integration_storage_key";

describe("uploads and crashes", () => {
  const app: AppDefinition = {
    schema: defineSchema({ notes: defineTable({ body: z.string() }) }),
    modules: {
      app: {
        /** Holds the write lock for `ms`. */
        slowAdd: mutation({
          args: { ms: z.number() },
          handler: async (ctx: any, { ms }: { ms: number }) => {
            await Bun.sleep(ms);
            await ctx.db.insert("notes", { body: "slow" });
          },
        }),
        remove: mutation({ args: { id: z.string() }, handler: (ctx: any, { id }: { id: string }) => ctx.storage.delete(id) }),
      },
    },
  };
  const start = (dataDir = dir(), options: Partial<ConstructorParameters<typeof Engine>[1]> = {}) => {
    const engine = open(app, dataDir, { adminKey: STORAGE_ADMIN, ...options });
    engine.start();
    return { engine, url: serve(engine), dataDir };
  };
  const upload = (url: string, body: BodyInit) =>
    fetch(`${url}/api/storage/upload`, { method: "POST", headers: { authorization: `Bearer ${STORAGE_ADMIN}` }, body });
  const files = (dataDir: string) => readdirSync(join(dataDir, "storage")).sort();
  const rows = (engine: Engine) => engine.store.write.query(`SELECT _id, data FROM _storage`).all() as { _id: string; data: string }[];

  test("a file is stored only once its row counts it, so a crash never leaves a stored file nothing counts", async () => {
    const { engine, url, dataDir } = start(dir(), { storage: { maxStorageBytes: 10 * 1024 * 1024 } });
    // A long mutation holds the write lock while the upload arrives.
    const slow = fetch(`${url}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "app:slowAdd", args: { ms: 400 } }),
    });
    await until(() => engine.runningCalls().includes("app:slowAdd"), "the mutation to start");
    const pending = upload(url, new Uint8Array(300_000).fill(7));
    await until(() => files(dataDir).some((f) => f.startsWith(".tmp-")), "the upload to be received");
    await Bun.sleep(100);
    // Received, waiting for the lock: only the temp file, which a start removes.
    expect(files(dataDir).filter((f) => !f.startsWith(".tmp-"))).toEqual([]);
    expect(rows(engine)).toEqual([]);
    expect((await slow).status).toBe(200);
    const { storageId } = (await (await pending).json()) as { storageId: string };
    expect(files(dataDir)).toEqual([storageId]);
    const [row] = rows(engine);
    expect(JSON.parse(row!.data)).toMatchObject({ size: 300_000, pending: true });
    expect(JSON.parse(row!.data).storing).toBeUndefined();
    expect(engine.storage.storedBytes()).toBe(300_000);
  });

  test("a row a stopped process left marked storing is removed on start, with its file and its bytes", async () => {
    const dataDir = dir();
    const first = open(app, dataDir, { adminKey: STORAGE_ADMIN });
    // The process dies after the row and the file, before the mark is cleared.
    const put = spyOn((first.storage as any).backend, "putFile").mockImplementation(async () => {
      await new Promise(() => {});
    });
    const half = first.storage.store(new Blob(["half stored"])).catch(() => {});
    await until(() => rows(first).length === 1, "the row");
    const id = rows(first)[0]!._id;
    expect(JSON.parse(rows(first)[0]!.data)).toMatchObject({ storing: true, size: 11 });
    expect(first.storage.storedBytes()).toBe(11);
    writeFileSync(join(dataDir, "storage", id), "half stored");
    put.mockRestore();
    await first.stop();
    void half;

    // A preflight on a copy (no start) leaves it: it shares the S3 bucket with the live process.
    const preflight = open(app, dataDir, { adminKey: STORAGE_ADMIN });
    expect(rows(preflight)).toHaveLength(1);
    await preflight.stop();
    expect(files(dataDir)).toEqual([id]);

    const next = open(app, dataDir, { adminKey: STORAGE_ADMIN });
    next.start();
    await until(() => rows(next).length === 0, "the recovery");
    await until(() => files(dataDir).length === 0, "the file to go");
    expect(next.storage.storedBytes()).toBe(0);
  });

  test("a failed store removes its row and its bytes", async () => {
    const { engine } = start();
    const put = spyOn((engine.storage as any).backend, "putFile").mockImplementation(async () => {
      throw new Error("bucket unreachable");
    });
    try {
      await expect(engine.storage.store(new Blob(["x"]))).rejects.toThrow("bucket unreachable");
    } finally {
      put.mockRestore();
    }
    expect(rows(engine)).toEqual([]);
    expect(engine.storage.storedBytes()).toBe(0);
  });

  test("a stop waits for the file deletes that follow a commit", async () => {
    const { engine, url, dataDir } = start();
    const { storageId } = (await (await upload(url, "to delete")).json()) as { storageId: string };
    const backend = (engine.storage as any).backend;
    const realDelete = backend.delete.bind(backend);
    const del = spyOn(backend, "delete").mockImplementation(async (id: unknown) => {
      await Bun.sleep(300);
      await realDelete(id);
    });
    try {
      await engine.call("app:remove", { id: storageId }, { userId: null, admin: true });
      await engine.stop();
      expect(files(dataDir)).toEqual([]);
    } finally {
      del.mockRestore();
    }
  });
});

describe("a plain app's limits", () => {
  test("uploads and password hashing are not limited unless a limit is set", async () => {
    const engine = open({ modules: {} });
    expect(engine.storage.uploads.limit).toBe(Infinity);
    expect(engine.auth.hashing.limit).toBe(Infinity);
    // 16 sign-ups at once all run at once.
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => engine.auth.signUp({ email: `u${i}@example.com`, password: "password123" })),
    );
    expect(results).toHaveLength(16);
    expect(engine.auth.hashing.queued).toBe(0);
  });

  test("over TCP, an upload queued for a slot longer than Bun's idle timeout is not reset", async () => {
    const engine = open({ modules: {} }, dir(), { adminKey: STORAGE_ADMIN, storage: { uploadConcurrency: 1, uploadQueueTimeoutMs: 20_000 } });
    const url = serve(engine);
    const total = 70 * 4096;
    // The first upload holds the slot for about 14 s, sending a little every 200 ms.
    let sent = 0;
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= total) return controller.close();
        if (sent > 0) await Bun.sleep(200);
        controller.enqueue(new Uint8Array(4096).fill(1));
        sent += 4096;
      },
    });
    const headers = { authorization: `Bearer ${STORAGE_ADMIN}` };
    const first = fetch(`${url}/api/storage/upload`, { method: "POST", headers, body: slow, duplex: "half" } as RequestInit);
    await until(() => engine.storage.uploads.active === 1, "the first upload to take the slot");
    // The second, from another process, is larger than the socket buffers: it waits, unread, past 10 s.
    const started = performance.now();
    const client = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const res = await fetch(${JSON.stringify(`${url}/api/storage/upload`)}, { method: "POST", headers: ${JSON.stringify(headers)}, body: new Uint8Array(8 * 1024 * 1024) })
          .then((r) => r.status, (e) => String(e.code ?? e));
        console.log(res);`,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 25_000 },
    );
    const second = (await new Response(client.stdout).text()).trim();
    expect(performance.now() - started).toBeGreaterThan(10_000);
    expect(second).toBe("200");
    expect((await first).status).toBe(200);
  }, 30_000);
});

function silence() {
  const methods = ["log", "warn", "error"] as const;
  const saved = methods.map((m) => console[m]);
  for (const m of methods) console[m] = () => {};
  return {
    restore() {
      methods.forEach((m, i) => (console[m] = saved[i]!));
    },
  };
}
