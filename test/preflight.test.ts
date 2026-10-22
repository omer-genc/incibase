// Step 7 of M1: paged migration validation, `serve --migrate-only`, the
// generation and branch a host sets, the password hashing semaphore, client
// resilience (per-server tokens, jitter, unprocessed retries) and the
// dashboard's branch label.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { defineSchema, defineTable, z } from "incibase/server";
import { fullJitter, IncibaseClient, IncibaseRequestError, normalizeBaseUrl, tokenKeyFor } from "incibase/client";
import { IncibaseError } from "incibase";
import { ProductionBanner } from "../src/dashboard/components/branch.tsx";
import { isProduction, mcpCommand, serverName } from "../src/dashboard/lib/branch.ts";
import { adminTools } from "../src/engine/admin.ts";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { ConfigError, exitCodeOf, ExitCode } from "../src/engine/exit-codes.ts";
import { startServer } from "../src/engine/http.ts";
import { ConcurrencyGate, LimitError } from "../src/engine/limits.ts";
import { migrate, MigrationError, PAGE_BYTES, PAGE_SIZE } from "../src/engine/migrate.ts";
import { Store } from "../src/engine/store.ts";
import { memoryStorage, tempDir } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const dirs: string[] = [];
function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

const engines: Engine[] = [];
function open(app: AppDefinition, dataDir: string, options: Partial<ConstructorParameters<typeof Engine>[1]> = {}) {
  const engine = new Engine(app, { dataDir, quiet: true, publicUrl: "http://localhost", ...options });
  engines.push(engine);
  return engine;
}

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop().catch(() => {});
});

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Sets environment variables for the length of `fn`. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

// ---------------------------------------------------------------------------
// Paged revalidation

const notesV1 = () => defineSchema({ notes: defineTable({ body: z.string(), n: z.number() }) });
const notesV2 = () => defineSchema({ notes: defineTable({ body: z.string(), n: z.number(), tag: z.string().default("new") }) });

/** A data dir whose `notes` table holds `count` documents (written under notesV1), with bodies of `body(n)`. */
async function notesDb(count: number, body = (n: number) => `note ${n}`) {
  const data = dir();
  const engine = open({ schema: notesV1(), modules: {} }, data);
  await engine.writeTx(async (s) => {
    for (let n = 0; n < count; n++) await s.insert("notes", { body: body(n), n });
  });
  await engine.stop();
  return join(data, "data.db");
}

/** Every `notes` document in `_id` order, as stored. */
function notesOf(path: string): { _id: string; data: string }[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(`SELECT _id, data FROM notes ORDER BY _id`).all() as { _id: string; data: string }[];
  } finally {
    db.close();
  }
}

/** Changes one stored document behind the schema's back, as an old release could have left it. */
function rawUpdate(path: string, id: string, data: Record<string, unknown>) {
  const db = new Database(path);
  try {
    db.query(`UPDATE notes SET data = ? WHERE _id = ?`).run(JSON.stringify(data), id);
  } finally {
    db.close();
  }
}

/**
 * Runs `migrate` on the database at `path` and records the size of every
 * page the re-validation read (rows returned by `all`, or taken from
 * `iterate`), and any read of a whole table.
 */
function migrateRecording(path: string, schema: ReturnType<typeof defineSchema>, options: Parameters<typeof migrate>[2] = {}) {
  const store = new Store(path);
  const pages: number[] = [];
  const wholeTableReads: string[] = [];
  type Statement = ReturnType<typeof store.write.query>;
  const record = (sql: string, statement: Statement) => {
    if (!/FROM "notes"/.test(sql) || !/^SELECT/.test(sql.trim())) return statement;
    if (!/LIMIT/.test(sql)) wholeTableReads.push(sql);
    const all = statement.all.bind(statement);
    (statement as { all: unknown }).all = (...args: unknown[]) => {
      const rows = (all as (...a: unknown[]) => unknown[])(...args);
      pages.push(rows.length);
      return rows;
    };
    const iterate = statement.iterate.bind(statement) as (...a: unknown[]) => Iterable<unknown>;
    (statement as { iterate: unknown }).iterate = function* (...args: unknown[]) {
      let taken = 0;
      try {
        for (const row of iterate(...args)) {
          taken++;
          yield row;
        }
      } finally {
        pages.push(taken);
      }
    };
    return statement;
  };
  const query = store.write.query.bind(store.write);
  const prepare = store.write.prepare.bind(store.write);
  const spies = [
    spyOn(store.write, "query").mockImplementation(((sql: string) => record(sql, query(sql))) as typeof store.write.query),
    spyOn(store.write, "prepare").mockImplementation(((sql: string) => record(sql, prepare(sql) as Statement)) as typeof store.write.prepare),
  ];
  let result: { report?: ReturnType<typeof migrate>; err?: unknown };
  try {
    result = { report: migrate(store, schema, options) };
  } catch (err) {
    result = { err };
  } finally {
    for (const spy of spies) spy.mockRestore();
    store.close();
  }
  return { result, pages, wholeTableReads };
}

describe("paged revalidation", () => {
  test(`re-validates ${4 * PAGE_SIZE + 1234} documents in pages of at most ${PAGE_SIZE}, never the whole table at once`, async () => {
    const count = 4 * PAGE_SIZE + 1234;
    const path = await notesDb(count);
    const { result, pages, wholeTableReads } = migrateRecording(path, notesV2());
    expect(result.err).toBeUndefined();
    expect(result.report!.rewrittenDocuments).toBe(count);
    expect(wholeTableReads).toEqual([]);
    // Bounded memory: no read returned more than a page, and all of them together covered the table.
    expect(Math.max(...pages)).toBe(PAGE_SIZE);
    expect(pages).toEqual([PAGE_SIZE, PAGE_SIZE, PAGE_SIZE, PAGE_SIZE, 1234]);
    const notes = notesOf(path);
    expect(notes.length).toBe(count);
    expect(notes.every((d) => JSON.parse(d.data).tag === "new")).toBe(true);
    // Each document once: keyset pages neither skip nor repeat a rewritten document.
    expect(new Set(notes.map((d) => JSON.parse(d.data).n)).size).toBe(count);
  }, 60_000);

  test("small pages give the same report and data as one page", async () => {
    const a = await notesDb(1000);
    const b = join(dir(), "data.db");
    const db = new Database(a, { readonly: true });
    db.run(`VACUUM INTO '${b}'`);
    db.close();
    // A document of each kind: one that loses a field, and the rest that gain a default.
    const id = notesOf(a)[617]!._id;
    for (const path of [a, b]) rawUpdate(path, id, { body: "x", n: 617, old: true });
    const one = migrateRecording(a, notesV2(), { pageSize: 5000, allowFieldRemoval: true });
    const many = migrateRecording(b, notesV2(), { pageSize: 7, allowFieldRemoval: true });
    expect(one.pages).toEqual([1000]);
    expect(many.pages.length).toBe(Math.ceil(1000 / 7));
    expect(many.result.report).toEqual(one.result.report!);
    expect(one.result.report!.removedFields).toEqual([{ table: "notes", field: "old", documents: 1 }]);
    expect(notesOf(b)).toEqual(notesOf(a));
  });

  test("a field removal found on a later page refuses the migration and leaves earlier pages unwritten", async () => {
    const count = 3 * PAGE_SIZE + 10;
    const path = await notesDb(count);
    const before = notesOf(path);
    const late = before[3 * PAGE_SIZE + 5]!;
    rawUpdate(path, late._id, { ...JSON.parse(late.data), legacy: "kept" });
    const stored = notesOf(path);
    const { result, pages } = migrateRecording(path, notesV2());
    expect(pages.length).toBe(4);
    const err = result.err as MigrationError;
    expect(err).toBeInstanceOf(MigrationError);
    expect(exitCodeOf(err)).toBe(ExitCode.MIGRATION_REFUSED);
    expect(err.removedFields).toEqual([{ table: "notes", field: "legacy", documents: 1 }]);
    expect(err.message).toContain("notes.legacy: 1 document(s)");
    // One transaction: the defaults written to the first pages were rolled back too.
    expect(notesOf(path)).toEqual(stored);
  }, 60_000);

  test("documents that no longer validate are counted across pages, and only the first ones are kept", async () => {
    const path = await notesDb(1500);
    const strict = defineSchema({ notes: defineTable({ body: z.string().max(3), n: z.number() }) });
    const { result } = migrateRecording(path, strict, { pageSize: 100 });
    const err = result.err as MigrationError;
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.problemCount).toBe(1500);
    expect(err.problems.length).toBe(1000);
    expect(err.message).toContain("Schema does not match 1500 existing document(s)");
    expect(err.message).toContain("...and 1480 more");
  });

  test(`a page also ends once it holds ${PAGE_BYTES} bytes, so large documents make smaller pages`, async () => {
    const big = "x".repeat(50_000);
    const path = await notesDb(400, () => big);
    const length = notesOf(path)[0]!.data.length;
    const perPage = Math.ceil(PAGE_BYTES / length);
    const { result, pages } = migrateRecording(path, notesV2());
    expect(result.report!.rewrittenDocuments).toBe(400);
    expect(pages).toEqual([perPage, perPage, 400 - 2 * perPage]);
    expect(notesOf(path).every((d) => JSON.parse(d.data).tag === "new")).toBe(true);
  });

  test("byte-bounded pages give the same report and data as one page; a document over the budget ends its page", async () => {
    // Bodies of 10..1009 characters, one of them over the whole budget.
    const body = (n: number) => "y".repeat(n === 300 ? 20_000 : 10 + (n % 1000));
    const a = await notesDb(1000, body);
    const b = join(dir(), "data.db");
    const db = new Database(a, { readonly: true });
    db.run(`VACUUM INTO '${b}'`);
    db.close();
    const id = notesOf(a)[617]!._id;
    for (const path of [a, b]) rawUpdate(path, id, { body: "x", n: 617, old: true });
    const stored = notesOf(b).map((d) => d.data.length);
    const one = migrateRecording(a, notesV2(), { allowFieldRemoval: true });
    const many = migrateRecording(b, notesV2(), { pageBytes: 10_000, allowFieldRemoval: true });
    expect(one.pages).toEqual([1000]);
    expect(many.pages.reduce((x, y) => x + y, 0)).toBe(1000);
    expect(many.pages.length).toBeGreaterThan(50);
    expect(many.result.report).toEqual(one.result.report!);
    expect(notesOf(b)).toEqual(notesOf(a));
    // Every page but the last ends at the first document that brings it to the budget.
    const pageEnds: number[] = [];
    let at = 0;
    for (const size of many.pages.slice(0, -1)) {
      const page = stored.slice(at, at + size);
      const sum = page.reduce((x, y) => x + y, 0);
      expect(sum).toBeGreaterThanOrEqual(10_000);
      expect(sum - page.at(-1)!).toBeLessThan(10_000);
      at += size;
      pageEnds.push(at - 1);
    }
    expect(stored.slice(at).reduce((x, y) => x + y, 0)).toBeLessThan(10_000);
    const bigAt = notesOf(b).findIndex((d) => JSON.parse(d.data).n === 300);
    expect(stored[bigAt]).toBeGreaterThan(10_000);
    expect(pageEnds).toContain(bigAt);
  });

  test("peak memory stays under the 192 MiB a host gives a branch, for small documents and large ones", async () => {
    // 40k documents of 2 KB and 1500 of 50 KB (about 155 MB of JSON); loading
    // them at once, or 5000 large ones per page, would need several times that.
    const data = dir();
    const engine = open({ schema: notesV1(), modules: {} }, data);
    await engine.stop();
    const path = join(data, "data.db");
    const db = new Database(path);
    try {
      const insert = db.query(`INSERT INTO notes (_id, _creationTime, data) VALUES (?, ?, ?)`);
      const small = "s".repeat(2000);
      const large = "L".repeat(50_000);
      db.transaction(() => {
        for (let n = 0; n < 41_500; n++) {
          const body = n >= 20_000 && n < 21_500 ? large : small;
          insert.run(`m${String(n).padStart(8, "0")}`, n, JSON.stringify({ body, n }));
        }
      })();
    } finally {
      db.close();
    }
    const script = join(dir(), "migrate-child.ts");
    writeFileSync(
      script,
      `import { Store } from ${JSON.stringify(join(import.meta.dir, "..", "src", "engine", "store.ts"))};
import { migrate } from ${JSON.stringify(join(import.meta.dir, "..", "src", "engine", "migrate.ts"))};
import { defineSchema, defineTable, z } from "incibase/server";
const store = new Store(${JSON.stringify(path)});
const report = migrate(store, defineSchema({ notes: defineTable({ body: z.string(), n: z.number(), tag: z.string().default("new") }) }));
store.close();
// On Linux ru_maxrss survives exec, so it would report the test runner's own peak; VmHWM starts fresh.
const hwm = (() => { try { return Number(require("node:fs").readFileSync("/proc/self/status", "utf8").match(/VmHWM:\\s+(\\d+)/)?.[1]); } catch { return NaN; } })();
console.log(JSON.stringify({ rewritten: report.rewrittenDocuments, maxRssKiB: Number.isFinite(hwm) ? hwm : process.resourceUsage().maxRSS }));
`,
    );
    const proc = Bun.spawn([process.execPath, script], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const { rewritten, maxRssKiB } = JSON.parse(stdout.trim()) as { rewritten: number; maxRssKiB: number };
    expect(rewritten).toBe(41_500);
    expect(maxRssKiB / 1024).toBeLessThan(192);
    const migrated = new Database(path, { readonly: true });
    try {
      expect(migrated.query(`SELECT count(*) AS n FROM notes WHERE json_extract(data, '$.tag') = 'new'`).get()).toEqual({ n: 41_500 });
    } finally {
      migrated.close();
    }
  }, 120_000);

  test("an unchanged schema reads nothing", async () => {
    const path = await notesDb(10);
    const { result, pages } = migrateRecording(path, notesV1());
    expect(result.report!.rewrittenDocuments).toBe(0);
    expect(pages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// serve --migrate-only

const SCHEMA = (tables: string) => `import { defineSchema, defineTable, z } from "incibase/server";\nexport default defineSchema({ ${tables} });\n`;

const HOSTED_ENV = { INCIBASE_ADMIN_KEY: "ik_admin_preflight_test_key", INCIBASE_STORAGE_SECRET: "preflight-test-storage-secret-0123456789" };

/** An app dir with `schema`, and a data dir that already holds one customer (and, `hosted`, no secrets). */
async function project(schema: string, { hosted = false } = {}) {
  const root = dir();
  const data = join(root, "data");
  await withEnv(hosted ? HOSTED_ENV : {}, async () => {
    const first = open({ schema: defineSchema({ customers: defineTable({ name: z.string() }) }), modules: {} }, data);
    await first.writeTx((s) => s.insert("customers", { name: "Acme" }));
    await first.stop();
  });
  const source = join(root, "app");
  mkdirSync(source);
  writeFileSync(join(source, "schema.ts"), schema);
  return { root, data, source };
}

async function cli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, INCIBASE_RESTART: "1", ...env },
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const events = stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, any>);
  return { stdout, stderr, code, events };
}

function customersOf(data: string) {
  const db = new Database(join(data, "data.db"), { readonly: true });
  try {
    return {
      tables: (db.query(`SELECT name FROM _incibase_tables WHERE active = 1 ORDER BY name`).all() as { name: string }[]).map((r) => r.name),
      customers: (db.query(`SELECT data FROM customers`).all() as { data: string }[]).map((r) => JSON.parse(r.data)),
    };
  } finally {
    db.close();
  }
}

describe("serve --migrate-only", () => {
  const MIGRATED = SCHEMA(`customers: defineTable({ name: z.string(), plan: z.string().default("free") }), orders: defineTable({ total: z.number() })`);

  test("migrates, logs the report and exits 0 without listening", async () => {
    const { root, data, source } = await project(MIGRATED);
    const socket = join(root, "http.sock");
    const result = await cli(
      ["serve", "--migrate-only", "--dir", source, "--data", data, "--socket", socket, "--url", "https://shop.example", "--log-format", "json"],
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const evs = result.events.map((e) => e.ev);
    expect(evs).not.toContain("ready");
    expect(existsSync(socket)).toBe(false);
    const committed = result.events.find((e) => e.ev === "migration_committed")!;
    expect(committed).toMatchObject({ createdTables: ["orders"], rewrittenDocuments: 1, removedFields: [] });
    const done = result.events.find((e) => e.ev === "migrate_only")!;
    expect(done).toMatchObject({ changed: true, createdTables: ["orders"], rewrittenDocuments: 1 });
    expect(customersOf(data)).toEqual({ tables: ["customers", "orders"], customers: [{ name: "Acme", plan: "free" }] });
    // The data dir lock was released: a second run finds nothing to do.
    const again = await cli(["serve", "--migrate-only", "--dir", source, "--data", data, "--port", "0", "--log-format", "json"]);
    expect(again.code).toBe(0);
    expect(again.events.find((e) => e.ev === "migration_committed")).toBeUndefined();
    expect(again.events.find((e) => e.ev === "migrate_only")).toMatchObject({ changed: false });
  }, 30_000);

  test("prints the report in text mode", async () => {
    const { data, source } = await project(MIGRATED);
    const result = await cli(["serve", "--migrate-only", "--dir", source, "--data", data, "--port", "0"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("+ table orders");
    expect(result.stdout).toContain("~ 1 document(s) updated to the new schema");
    expect(result.stdout).toContain("not serving (--migrate-only)");
    expect(result.stdout).not.toContain("Admin key");
  }, 30_000);

  test("exits 65 on a refused migration and changes nothing", async () => {
    const { data, source } = await project(SCHEMA(`customers: defineTable({ title: z.string().default("x") })`));
    const before = customersOf(data);
    const result = await cli(["serve", "--migrate-only", "--dir", source, "--data", data, "--port", "0", "--log-format", "json"]);
    expect(result.code).toBe(ExitCode.MIGRATION_REFUSED);
    expect(result.events.find((e) => e.ev === "fatal")).toMatchObject({ exitCode: 65 });
    expect(result.events.find((e) => e.ev === "migration_committed")).toBeUndefined();
    expect(customersOf(data)).toEqual(before);
  }, 30_000);

  test("runs serve's hosted-mode checks: --admin-socket without the secrets in the environment is exit 64", async () => {
    const { root, data, source } = await project(MIGRATED, { hosted: true });
    const flags = ["serve", "--migrate-only", "--dir", source, "--data", data, "--socket", join(root, "h.sock"), "--admin-socket", join(root, "a.sock")];
    const refused = await cli([...flags, "--url", "https://shop.example"], { INCIBASE_ADMIN_KEY: "", INCIBASE_STORAGE_SECRET: "" });
    expect(refused.code).toBe(ExitCode.CONFIG);
    const ok = await cli([...flags, "--url", "https://shop.example"], HOSTED_ENV);
    expect(ok.code).toBe(0);
    expect(existsSync(join(root, "h.sock")) || existsSync(join(root, "a.sock"))).toBe(false);
  }, 30_000);

  test("is for serve only", async () => {
    const result = await cli(["codegen", "--migrate-only", "--dir", dir()]);
    expect(result.code).toBe(ExitCode.CONFIG);
    expect(result.stderr).toContain("--migrate-only is for serve");
  });
});

// ---------------------------------------------------------------------------
// Generation and branch

describe("generation and branch", () => {
  async function server(surface: "combined" | "admin" = "combined") {
    const engine = open({ schema: defineSchema({}), modules: {} }, dir());
    const srv = startServer(engine, { port: 0, hostname: "127.0.0.1", surface });
    const url = srv.url.origin;
    const auth = { authorization: `Bearer ${engine.adminKey}`, "content-type": "application/json" };
    return {
      health: async () => (await fetch(`${url}/api/health`)).json() as Promise<Record<string, unknown>>,
      overview: async () =>
        ((await (await fetch(`${url}/api/admin/admin_overview`, { method: "POST", headers: auth, body: "{}" })).json()) as { value: any }).value,
      mcpOverview: async () => {
        const res = await fetch(`${url}/mcp`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "admin_overview", arguments: {} } }),
        });
        return ((await res.json()) as { result: { structuredContent: any } }).result.structuredContent;
      },
      stop: () => srv.stop(true),
    };
  }

  test("health returns the generation a host started this process with, or null", async () => {
    const s = await server();
    try {
      await withEnv({ INCIBASE_GENERATION: undefined }, async () => {
        const h = await s.health();
        expect(h).toMatchObject({ ok: true, generation: null });
        expect(typeof h.startedAt).toBe("number");
      });
      await withEnv({ INCIBASE_GENERATION: "42.k3j9" }, async () => expect((await s.health()).generation).toBe("42.k3j9"));
    } finally {
      s.stop();
    }
  });

  test("admin_overview returns the branch (nulls for a single app) and the listener surface", async () => {
    const s = await server();
    try {
      await withEnv({ INCIBASE_BRANCH_LABEL: undefined, INCIBASE_BRANCH_KIND: undefined }, async () => {
        const o = await s.overview();
        expect(o.branch).toEqual({ label: null, kind: null });
        expect(o.surface).toBe("combined");
      });
      await withEnv({ INCIBASE_BRANCH_LABEL: "shop/prod", INCIBASE_BRANCH_KIND: "prod" }, async () => {
        expect((await s.overview()).branch).toEqual({ label: "shop/prod", kind: "prod" });
        expect((await s.mcpOverview()).branch).toEqual({ label: "shop/prod", kind: "prod" });
      });
    } finally {
      s.stop();
    }
    const admin = await server("admin");
    try {
      expect((await admin.overview()).surface).toBe("admin");
      expect((await admin.mcpOverview()).surface).toBe("admin");
    } finally {
      admin.stop();
    }
  });

  test("adminTools without a surface reports the combined one", async () => {
    const engine = open({ schema: defineSchema({}), modules: {} }, dir());
    expect(((await adminTools(engine).admin_overview!.run({})) as { surface: string }).surface).toBe("combined");
  });
});

// ---------------------------------------------------------------------------
// Auth semaphore

/** Holds every password hash and check until released, counting how many run at once. */
function gatePasswords() {
  const realHash = Bun.password.hash.bind(Bun.password);
  const realVerify = Bun.password.verify.bind(Bun.password);
  let running = 0;
  let max = 0;
  let calls = 0;
  const waiting: (() => void)[] = [];
  let open = false;
  const hold = async <T>(fn: () => Promise<T>) => {
    calls++;
    running++;
    max = Math.max(max, running);
    try {
      if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
      return await fn();
    } finally {
      running--;
    }
  };
  // Cheap hashes keep the test fast; the gate is what is under test.
  const hash = spyOn(Bun.password, "hash").mockImplementation(((pw: string) =>
    hold(() => realHash(pw, { algorithm: "bcrypt", cost: 4 }))) as typeof Bun.password.hash);
  const verify = spyOn(Bun.password, "verify").mockImplementation(((pw: string, h: string) => hold(() => realVerify(pw, h))) as typeof Bun.password.verify);
  return {
    get running() {
      return running;
    },
    get max() {
      return max;
    },
    get calls() {
      return calls;
    },
    release() {
      open = true;
      for (const w of waiting.splice(0)) w();
    },
    restore() {
      this.release();
      hash.mockRestore();
      verify.mockRestore();
    },
  };
}

async function until(check: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

function busyCode(err: unknown) {
  return err instanceof LimitError ? { code: (err.data as { code: string }).code, status: err.status } : err;
}

describe("auth semaphore", () => {
  test("at most auth.concurrency password hashes run at once; the rest wait their turn", async () => {
    const engine = open({ modules: {} }, dir(), { auth: { concurrency: 2 } });
    const pw = gatePasswords();
    try {
      const signUps = Array.from({ length: 6 }, (_, i) => engine.auth.signUp({ email: `u${i}@example.com`, password: "password123" }));
      await until(() => pw.running === 2);
      await Bun.sleep(30);
      expect(pw.running).toBe(2);
      expect(engine.auth.hashing.queued).toBe(4);
      pw.release();
      const results = await Promise.all(signUps);
      expect(results.map((r) => r.user.email).sort()).toEqual(Array.from({ length: 6 }, (_, i) => `u${i}@example.com`).sort());
      expect(pw.max).toBe(2);
      expect(engine.auth.hashing.active).toBe(0);
    } finally {
      pw.restore();
    }
  });

  test("sign-in, sign-up, password change and admin_create_user get AUTH_BUSY (503) once their wait runs out", async () => {
    const engine = open({ modules: {} }, dir(), { auth: { concurrency: 1, queueTimeoutMs: 40 } });
    const { user, token } = await engine.auth.signUp({ email: "a@example.com", password: "password123" });
    expect(token).toBeTruthy();
    const pw = gatePasswords();
    try {
      const holder = engine.auth.signIn({ email: "a@example.com", password: "password123" });
      await until(() => pw.running === 1);
      const started = performance.now();
      const results = await Promise.all([
        engine.auth.signIn({ email: "a@example.com", password: "password123" }).catch(busyCode),
        engine.auth.signIn({ email: "nobody@example.com", password: "password123" }).catch(busyCode),
        engine.auth.signUp({ email: "b@example.com", password: "password123" }).catch(busyCode),
        engine.auth.changePassword(user._id, { currentPassword: "password123", newPassword: "password456" }).catch(busyCode),
        adminTools(engine).admin_create_user!.run({ email: "c@example.com", password: "password123" }).catch(busyCode),
      ]);
      expect(performance.now() - started).toBeGreaterThanOrEqual(35);
      for (const r of results) expect(r).toEqual({ code: "AUTH_BUSY", status: 503 });
      // Only the holder hashed: the refused ones never started.
      expect(pw.calls).toBe(1);
      pw.release();
      expect((await holder).user.email).toBe("a@example.com");
      // Nothing was written for them either.
      const emails = engine.store.write.query(`SELECT json_extract(data, '$.email') AS email FROM _users`).all() as { email: string }[];
      expect(emails.map((u) => u.email)).toEqual(["a@example.com"]);
    } finally {
      pw.restore();
    }
  });

  test("a full queue refuses at once", async () => {
    const engine = open({ modules: {} }, dir(), { auth: { concurrency: 1, maxQueued: 1, queueTimeoutMs: 5000 } });
    const pw = gatePasswords();
    try {
      const first = engine.auth.signUp({ email: "a@example.com", password: "password123" });
      await until(() => pw.running === 1);
      const second = engine.auth.signUp({ email: "b@example.com", password: "password123" });
      await until(() => engine.auth.hashing.queued === 1);
      const started = performance.now();
      expect(await engine.auth.signUp({ email: "c@example.com", password: "password123" }).catch(busyCode)).toEqual({ code: "AUTH_BUSY", status: 503 });
      expect(performance.now() - started).toBeLessThan(1000);
      pw.release();
      await Promise.all([first, second]);
    } finally {
      pw.restore();
    }
  });

  test("over HTTP it is a 503 AUTH_BUSY with Retry-After, which the client does not retry", async () => {
    const engine = open({ modules: {} }, dir(), { auth: { concurrency: 1, queueTimeoutMs: 30 } });
    const srv = startServer(engine, { port: 0, hostname: "127.0.0.1" });
    const pw = gatePasswords();
    try {
      const holder = engine.auth.signUp({ email: "a@example.com", password: "password123" });
      await until(() => pw.running === 1);
      const res = await fetch(`${srv.url.origin}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "b@example.com", password: "password123" }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_BUSY");
      let fetches = 0;
      const client = new IncibaseClient(srv.url.origin, {
        tokenStorage: memoryStorage(),
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
          fetches++;
          return fetch(input, init);
        }) as typeof fetch,
      });
      const err = await client.auth.signUp({ email: "c@example.com", password: "password123" }).catch((e) => e);
      expect(err).toBeInstanceOf(IncibaseError);
      expect((err as IncibaseError<{ code: string }>).data.code).toBe("AUTH_BUSY");
      expect(fetches).toBe(1);
      pw.release();
      await holder;
    } finally {
      pw.restore();
      srv.stop(true);
    }
  });

  test("INCIBASE_AUTH_CONCURRENCY sets the limit (by default none, as in 0.2.0); an invalid value is a ConfigError (exit 64) before the data dir is touched", async () => {
    expect(open({ modules: {} }, dir()).auth.hashing.limit).toBe(Infinity);
    expect(open({ modules: {} }, dir(), { auth: { concurrency: 2 } }).auth.hashing.limit).toBe(2);
    await withEnv({ INCIBASE_AUTH_CONCURRENCY: "3" }, () => expect(open({ modules: {} }, dir(), { auth: { concurrency: 2 } }).auth.hashing.limit).toBe(3));
    for (const bad of ["0", "-1", "two", "1.5"]) {
      const data = join(dir(), "never");
      await withEnv({ INCIBASE_AUTH_CONCURRENCY: bad }, () => {
        let err: unknown;
        try {
          open({ modules: {} }, data);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(ConfigError);
        expect(exitCodeOf(err)).toBe(ExitCode.CONFIG);
        expect((err as Error).message).toContain("INCIBASE_AUTH_CONCURRENCY");
      });
      expect(existsSync(data)).toBe(false);
    }
    expect(() => open({ modules: {} }, dir(), { auth: { concurrency: 0 } })).toThrow(ConfigError);
  });

  test("the gate hands a freed slot to the next waiter in order", async () => {
    const gate = new ConcurrencyGate(1, 1000, { busy: () => new Error("busy") });
    const order: number[] = [];
    const release = await gate.acquire();
    const waiters = [1, 2, 3].map((n) => gate.run(async () => void order.push(n)));
    expect(gate.queued).toBe(3);
    release();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
    expect(gate.active).toBe(0);
  });
});

describe("auth checks while waiting for a slot", () => {
  const sessionsOf = (engine: Engine, userId: string) =>
    (engine.store.write.query(`SELECT count(*) AS n FROM _sessions WHERE user_id = ?`).get(userId) as { n: number }).n;
  const codeOf = (err: unknown) => (err instanceof IncibaseError ? (err.data as { code: string }).code : err);

  test("a sign-in with the old password queued behind a password change fails and leaves no session", async () => {
    const engine = open({ modules: {} }, dir(), { auth: { concurrency: 1 } });
    const { user } = await engine.auth.signUp({ email: "victim@example.com", password: "oldpassword1" });
    const pw = gatePasswords();
    try {
      const change = engine.auth.changePassword(user._id, { currentPassword: "oldpassword1", newPassword: "newpassword1" });
      await until(() => pw.running === 1);
      const attacker = engine.auth.signIn({ email: "victim@example.com", password: "oldpassword1" }).catch((e) => e);
      await until(() => engine.auth.hashing.queued === 1);
      pw.release();
      const changed = await change;
      expect(codeOf(await attacker)).toBe("INVALID_CREDENTIALS");
      // Only the session the change handed out is left, and it works.
      expect(sessionsOf(engine, user._id)).toBe(1);
      expect(engine.auth.identify(changed.token).userId).toBe(user._id);
      expect((await engine.auth.signIn({ email: "victim@example.com", password: "newpassword1" })).user._id).toBe(user._id);
    } finally {
      pw.restore();
    }
  });

  test("a sign-in queued while the user is deleted fails and leaves no session", async () => {
    const engine = open({ modules: {} }, dir(), { auth: { concurrency: 1 } });
    const { user } = await engine.auth.signUp({ email: "victim@example.com", password: "password123" });
    const pw = gatePasswords();
    try {
      const burst = engine.auth.signIn({ email: "other@example.com", password: "password123" }).catch(() => {});
      await until(() => pw.running === 1);
      const queued = engine.auth.signIn({ email: "victim@example.com", password: "password123" }).catch((e) => e);
      await until(() => engine.auth.hashing.queued === 1);
      await adminTools(engine).admin_delete_user!.run({ id: user._id });
      pw.release();
      await burst;
      expect(codeOf(await queued)).toBe("INVALID_CREDENTIALS");
      expect(sessionsOf(engine, user._id)).toBe(0);
    } finally {
      pw.restore();
    }
  });

  test("a change, deletion or disable that commits during the password check wins over the sign-in", async () => {
    const engine = open({ modules: {} }, dir(), { auth: { concurrency: 1 } });
    const users = await Promise.all(
      ["changed", "deleted", "disabled"].map((name) => engine.auth.signUp({ email: `${name}@example.com`, password: "password123" })),
    );
    const [changed, deleted, disabled] = users.map((r) => r.user._id) as [string, string, string];
    const midway: [name: string, userId: string, act: () => Promise<unknown>][] = [
      [
        "changed",
        changed,
        () => engine.writeTx((s) => void s.conn.query(`UPDATE _passwords SET hash = ? WHERE user_id = ?`).run("$replaced", changed)),
      ],
      ["deleted", deleted, () => engine.auth.deleteUser(deleted)],
      ["disabled", disabled, () => engine.auth.setDisabled(disabled, true)],
    ];
    for (const [name, userId, act] of midway) {
      const pw = gatePasswords();
      try {
        const signIn = engine.auth.signIn({ email: `${name}@example.com`, password: "password123" }).catch((e) => e);
        // The hash is read and being checked: the write commits before the check ends.
        await until(() => pw.running === 1);
        await act();
        const before = sessionsOf(engine, userId);
        pw.release();
        expect(codeOf(await signIn)).toBe("INVALID_CREDENTIALS");
        expect(sessionsOf(engine, userId)).toBe(before);
      } finally {
        pw.restore();
      }
    }
    // The sign-up's own session is left only where nothing revoked it.
    expect([changed, deleted, disabled].map((id) => sessionsOf(engine, id))).toEqual([1, 0, 0]);
  });

  test("of two password changes from the same current password, only the first succeeds", async () => {
    for (const concurrency of [1, 2]) {
      const engine = open({ modules: {} }, dir(), { auth: { concurrency } });
      const { user } = await engine.auth.signUp({ email: "a@example.com", password: "password123" });
      const pw = gatePasswords();
      try {
        const changes = ["first-pass1", "second-pass2"].map((newPassword) =>
          engine.auth.changePassword(user._id, { currentPassword: "password123", newPassword }).then(
            (r) => ({ ok: true, newPassword, token: r.token }),
            (e) => ({ ok: false, newPassword, code: codeOf(e) }),
          ),
        );
        await until(() => pw.running + engine.auth.hashing.queued === 2);
        pw.release();
        const results = await Promise.all(changes);
        const won = results.filter((r) => r.ok);
        expect(won.length).toBe(1);
        expect(results.find((r) => !r.ok)).toMatchObject({ code: "INVALID_CREDENTIALS" });
        expect(sessionsOf(engine, user._id)).toBe(1);
        const winner = won[0] as { newPassword: string; token: string };
        expect(engine.auth.identify(winner.token).userId).toBe(user._id);
        expect((await engine.auth.signIn({ email: "a@example.com", password: winner.newPassword })).user._id).toBe(user._id);
        const loser = results.find((r) => !r.ok)!.newPassword;
        expect(codeOf(await engine.auth.signIn({ email: "a@example.com", password: loser }).catch((e) => e))).toBe("INVALID_CREDENTIALS");
      } finally {
        pw.restore();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Client

/** A Map-backed localStorage on globalThis for the length of `fn`. */
async function withLocalStorage<T>(fn: (store: Map<string, string>) => T | Promise<T>): Promise<T> {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  try {
    return await fn(store);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

/** `location` on globalThis pointing at `href` for the length of `fn`. */
async function withLocation<T>(href: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href } });
  try {
    return await fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else delete (globalThis as { location?: unknown }).location;
  }
}

const UNPROCESSED = () =>
  new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "The server is restarting" } }), {
    status: 503,
    headers: { "content-type": "application/json", "x-incibase-unprocessed": "1", "retry-after": "1" },
  });
const OK = (value: unknown) => Response.json({ value });

/** A fetch that answers from `answers` in turn (the last one repeats), recording each request. */
function scriptedFetch(answers: (() => Response | Promise<Response>)[]) {
  const requests: { url: string; body: unknown; at: number }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: init?.body, at: performance.now() });
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)]!;
    return answer();
  }) as typeof fetch;
  return { impl, requests };
}

// Function paths stand in for generated references.
const send = "messages:send" as any;

describe("client tokens", () => {
  test("each server's token has its own key, from the normalized base URL", async () => {
    expect(normalizeBaseUrl("https://Shop.Example.com/")).toBe("https://shop.example.com");
    expect(normalizeBaseUrl("https://shop.example.com:443//")).toBe("https://shop.example.com");
    expect(normalizeBaseUrl("http://localhost:3210/api/")).toBe("http://localhost:3210/api");
    expect(tokenKeyFor("http://127.0.0.1:3210/")).toBe("incibase:token:http://127.0.0.1:3210");
    await withLocalStorage((store) => {
      const prod = new IncibaseClient("https://prod.example.com/");
      const dev = new IncibaseClient("http://localhost:3210");
      prod.setToken("ik_prod");
      dev.setToken("ik_dev");
      expect(prod.getToken()).toBe("ik_prod");
      expect(dev.getToken()).toBe("ik_dev");
      expect(new IncibaseClient("https://PROD.example.com").getToken()).toBe("ik_prod");
      expect(store.get("incibase:token:https://prod.example.com")).toBe("ik_prod");
      expect(store.get("incibase:token:http://localhost:3210")).toBe("ik_dev");
      dev.setToken(null);
      expect(dev.getToken()).toBeNull();
      expect(prod.getToken()).toBe("ik_prod");
    });
  });

  test("the legacy key is read once, by the first client without a token of its own, and then removed", async () => {
    await withLocalStorage((store) => {
      store.set("incibase:token", "ik_legacy");
      const first = new IncibaseClient("http://localhost:3210");
      expect(first.getToken()).toBe("ik_legacy");
      expect(store.get("incibase:token:http://localhost:3210")).toBe("ik_legacy");
      expect(store.has("incibase:token")).toBe(false);
      // Another server's client does not inherit it.
      expect(new IncibaseClient("https://prod.example.com").getToken()).toBeNull();
      expect(first.getToken()).toBe("ik_legacy");
    });
    await withLocalStorage((store) => {
      // A client that already has its own token leaves the legacy one alone; signing in elsewhere replaces it.
      store.set("incibase:token", "ik_legacy");
      store.set("incibase:token:https://a.example.com", "ik_a");
      expect(new IncibaseClient("https://a.example.com").getToken()).toBe("ik_a");
      expect(store.get("incibase:token")).toBe("ik_legacy");
      new IncibaseClient("https://b.example.com").setToken("ik_b");
      expect(store.has("incibase:token")).toBe(false);
      expect(new IncibaseClient("https://c.example.com").getToken()).toBeNull();
    });
  });

  test("a same-origin base URL keys the token by the page's origin, not its route", async () => {
    const keys = await Promise.all(
      ["https://app.example.com/settings/profile?tab=1", "https://app.example.com/orders/42#x", "https://app.example.com/"].map((href) =>
        withLocation(href, () => [tokenKeyFor(""), tokenKeyFor("/"), tokenKeyFor("/incibase/"), tokenKeyFor("incibase")]),
      ),
    );
    for (const k of keys) {
      expect(k).toEqual([
        "incibase:token:https://app.example.com",
        "incibase:token:https://app.example.com",
        "incibase:token:https://app.example.com/incibase",
        "incibase:token:https://app.example.com/incibase",
      ]);
    }
    await withLocalStorage(async (store) => {
      store.set("incibase:token", "ik_legacy");
      await withLocation("https://app.example.com/settings/profile", () => {
        const client = new IncibaseClient("/");
        expect(client.getToken()).toBe("ik_legacy");
        client.setToken("ik_signed_in");
      });
      // Reloading on another route finds the same session.
      await withLocation("https://app.example.com/orders/42", () => {
        expect(new IncibaseClient("/").getToken()).toBe("ik_signed_in");
        expect(new IncibaseClient("").getToken()).toBe("ik_signed_in");
      });
      expect([...store.keys()]).toEqual(["incibase:token:https://app.example.com"]);
    });
  });

  test("sends the request with the token of its own server", async () => {
    await withLocalStorage(async () => {
      const seen: (string | null)[] = [];
      const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return OK(1);
      }) as typeof fetch;
      new IncibaseClient("https://prod.example.com").setToken("ik_prod");
      await new IncibaseClient("http://localhost:3210", { fetch: fetchImpl }).mutation(send, { body: "x" });
      await new IncibaseClient("https://prod.example.com", { fetch: fetchImpl }).mutation(send, { body: "x" });
      expect(seen).toEqual([null, "Bearer ik_prod"]);
    });
  });
});

describe("client jitter and reconnects", () => {
  test("full jitter picks from [0, cap)", () => {
    expect(fullJitter(1000, () => 0)).toBe(0);
    expect(fullJitter(1000, () => 0.999999)).toBe(999);
    for (let i = 0; i < 1000; i++) {
      const d = fullJitter(250);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(250);
    }
  });

  /** A WebSocket the test opens and closes by hand. */
  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: unknown[] = [];
    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close() {}
  }

  /** Runs `fn` with setTimeout recording delays instead of scheduling, and Math.random returning `r`. */
  function recordingTimers<T>(r: number, fn: (delays: { ms: number; run: () => void }[]) => T): T {
    const delays: { ms: number; run: () => void }[] = [];
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
      delays.push({ ms, run });
      return 0;
    }) as unknown as typeof setTimeout);
    const random = spyOn(Math, "random").mockReturnValue(r);
    try {
      return fn(delays);
    } finally {
      timeout.mockRestore();
      random.mockRestore();
    }
  }

  test("reconnects back off with full jitter under a doubling cap; 1012 reconnects within a second and restarts the backoff", () => {
    FakeWebSocket.instances = [];
    const client = new IncibaseClient("http://localhost:3210", {
      tokenStorage: memoryStorage(),
      WebSocket: FakeWebSocket as unknown as typeof WebSocket,
      keepAliveMs: 0,
    });
    recordingTimers(0.5, (delays) => {
      client.subscribe("messages:list" as any, {}, () => {});
      const ws = () => FakeWebSocket.instances.at(-1)!;
      const dropAndReconnect = (code: number) => {
        ws().onclose!({ code });
        delays.at(-1)!.run();
      };
      dropAndReconnect(1006);
      dropAndReconnect(1006);
      dropAndReconnect(1006);
      expect(delays.map((d) => d.ms)).toEqual([125, 250, 500]);
      // The server restarts: back soon, whatever the backoff had grown to.
      dropAndReconnect(1012);
      expect(delays.at(-1)!.ms).toBe(500);
      // It is not back yet: the backoff starts over.
      dropAndReconnect(1006);
      expect(delays.at(-1)!.ms).toBe(125);
      // An open connection resets it too, and resubscribes.
      ws().onopen!();
      expect(ws().sent).toEqual([{ type: "sub", id: "1", path: "messages:list", args: {} }]);
      dropAndReconnect(1006);
      expect(delays.at(-1)!.ms).toBe(125);
      expect(FakeWebSocket.instances.length).toBe(7);
    });
    recordingTimers(0.999, (delays) => {
      for (let i = 0; i < 10; i++) {
        FakeWebSocket.instances.at(-1)!.onclose!({ code: 1006 });
        delays.at(-1)!.run();
      }
      // Never past the 10 s cap, and below it by the jitter.
      expect(Math.max(...delays.map((d) => d.ms))).toBe(9990);
      FakeWebSocket.instances.at(-1)!.onclose!({ code: 1012 });
      expect(delays.at(-1)!.ms).toBe(999);
    });
    client.close();
  });
});

describe("client retries of unprocessed requests", () => {
  test("a mutation answered 503-unprocessed a few times is retried with jitter until it goes through", async () => {
    const { impl, requests } = scriptedFetch([UNPROCESSED, UNPROCESSED, UNPROCESSED, () => OK("done")]);
    const client = new IncibaseClient("https://shop.example.com", { tokenStorage: memoryStorage(), token: "ik_t", fetch: impl });
    expect(await client.mutation(send, { body: "hi" })).toBe("done");
    expect(requests.length).toBe(4);
    // The same request each time: it never reached the server, so sending it again cannot run it twice.
    expect(new Set(requests.map((r) => `${r.url} ${r.body}`)).size).toBe(1);
    expect(requests[0]!.body).toBe(JSON.stringify({ path: "messages:send", args: { body: "hi" } }));
  });

  test("gives up once the retry budget is spent and reports the 503", async () => {
    const { impl, requests } = scriptedFetch([UNPROCESSED]);
    const client = new IncibaseClient("https://shop.example.com", { tokenStorage: memoryStorage(), fetch: impl, unprocessedRetryMs: 400 });
    const started = performance.now();
    const err = await client.mutation(send, { body: "hi" }).catch((e) => e);
    const elapsed = performance.now() - started;
    expect(err).toBeInstanceOf(IncibaseRequestError);
    expect(err).toMatchObject({ status: 503, code: "UNAVAILABLE" });
    expect(elapsed).toBeGreaterThanOrEqual(390);
    expect(elapsed).toBeLessThan(400 + 2000);
    expect(requests.length).toBeGreaterThan(2);
    // Each wait stays below the largest backoff cap (2 s).
    const gaps = requests.slice(1).map((r, i) => r.at - requests[i]!.at);
    expect(Math.max(...gaps)).toBeLessThan(2000 + 50);
  });

  test("the default budget is about 15 s, and 0 turns retries off", async () => {
    const random = spyOn(Math, "random").mockReturnValue(0);
    try {
      // With no jitter wait the retries spin until the budget: count them against a fake clock.
      let now = 0;
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      try {
        const { impl, requests } = scriptedFetch([
          () => {
            now += 1000;
            return UNPROCESSED();
          },
        ]);
        await new IncibaseClient("https://shop.example.com", { tokenStorage: memoryStorage(), fetch: impl }).query("messages:list" as any).catch(() => {});
        expect(requests.length).toBe(15);
      } finally {
        clock.mockRestore();
      }
    } finally {
      random.mockRestore();
    }
    const { impl, requests } = scriptedFetch([UNPROCESSED]);
    const err = await new IncibaseClient("https://shop.example.com", { tokenStorage: memoryStorage(), fetch: impl, unprocessedRetryMs: 0 })
      .query("messages:list" as any)
      .catch((e) => e);
    expect(err).toMatchObject({ status: 503 });
    expect(requests.length).toBe(1);
  });

  test("other errors are never retried: a plain 503, a 500, a 502, a 503 marked otherwise, or a network error", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => Response.json({ error: { code: "UNAVAILABLE", message: "busy" } }, { status: 503 }),
      () => Response.json({ error: { code: "INTERNAL_ERROR", message: "boom" } }, { status: 500 }),
      () => new Response("bad gateway", { status: 502, headers: { "x-incibase-unprocessed": "1" } }),
      () => Response.json({ error: { code: "UNAVAILABLE", message: "x" } }, { status: 503, headers: { "x-incibase-unprocessed": "0" } }),
      () => Promise.reject(new TypeError("fetch failed")),
    ];
    for (const answer of answers) {
      const { impl, requests } = scriptedFetch([answer, () => OK("second")]);
      const client = new IncibaseClient("https://shop.example.com", { tokenStorage: memoryStorage(), fetch: impl });
      const err = await client.mutation(send, { body: "hi" }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(requests.length).toBe(1);
    }
  });

  test("uploads are retried the same way", async () => {
    const { impl, requests } = scriptedFetch([UNPROCESSED, () => Response.json({ storageId: "s1" })]);
    const client = new IncibaseClient("https://shop.example.com", { tokenStorage: memoryStorage(), fetch: impl });
    const blob = new Blob(["hello"], { type: "text/plain" });
    expect(await client.storage.upload("https://shop.example.com/api/storage/upload?token=t", blob)).toBe("s1" as any);
    expect(requests.length).toBe(2);
    expect(requests.every((r) => r.body === blob)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dashboard

describe("dashboard branch label", () => {
  test("names the server by its branch label, else by the host it was opened on", () => {
    expect(serverName({ label: "shop/prod", kind: "prod" }, "127.0.0.1:7101")).toBe("shop/prod");
    expect(serverName({ label: null, kind: null }, "localhost:3210")).toBe("localhost:3210");
    expect(serverName(null, "localhost:3210")).toBe("localhost:3210");
    expect(serverName(undefined, "localhost:3210")).toBe("localhost:3210");
  });

  test("shows the red production banner only on prod branches", () => {
    expect(isProduction({ label: "shop/prod", kind: "prod" })).toBe(true);
    expect(isProduction({ label: "shop/dev", kind: "dev" })).toBe(false);
    expect(isProduction({ label: null, kind: null })).toBe(false);
    expect(isProduction(null)).toBe(false);
    const prod = renderToStaticMarkup(createElement(ProductionBanner, { branch: { label: "shop/prod", kind: "prod" } }));
    expect(prod).toContain("data-production-banner");
    expect(prod).toContain("bg-destructive");
    expect(prod).toContain("shop/prod");
    for (const branch of [{ label: "shop/dev", kind: "dev" }, { label: null, kind: null }, null]) {
      expect(renderToStaticMarkup(createElement(ProductionBanner, { branch }))).toBe("");
    }
  });

  test("builds the MCP command from the origin the dashboard was opened on", () => {
    expect(mcpCommand("http://127.0.0.1:7101", "ik_admin_x")).toBe(
      `claude mcp add --transport http incibase http://127.0.0.1:7101/mcp --header "Authorization: Bearer ik_admin_x"`,
    );
    expect(mcpCommand("http://localhost:3210", null)).toContain(`Bearer <admin key>`);
  });
});
