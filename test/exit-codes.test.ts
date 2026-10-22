import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cronJobs, defineSchema, defineTable, httpAction, httpRouter, internalAction, z } from "incibase/server";
import { buildApp } from "../src/engine/build.ts";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { listenError } from "../src/engine/http.ts";
import { ConfigError, DefinitionError, EXIT_CODE, exitCodeOf, ExitCode } from "../src/engine/exit-codes.ts";
import { MigrationError } from "../src/engine/migrate.ts";
import { DataDirLockedError, readMeta, SYSTEM_SCHEMA_VERSION, SystemSchemaTooNewError } from "../src/engine/store.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const dirs: string[] = [];
const engines: Engine[] = [];

function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

function open(app: AppDefinition, dataDir: string) {
  const engine = new Engine(app, { dataDir, quiet: true, publicUrl: "http://localhost" });
  engines.push(engine);
  return engine;
}

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected an error");
}

/** An app dir with `files`, and a data dir that already holds one customer. */
async function project(files: Record<string, string>) {
  const root = dir();
  const data = join(root, "data");
  const first = open({ schema: defineSchema({ customers: defineTable({ name: z.string() }) }), modules: {} }, data);
  await first.writeTx((s) => s.insert("customers", { name: "Acme" }));
  await first.stop();
  const source = join(root, "app");
  mkdirSync(source);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  return { root, data, source };
}

const SCHEMA = (tables: string) =>
  `import { defineSchema, defineTable, z } from "incibase/server";\nexport default defineSchema({ ${tables} });\n`;
const CUSTOMERS = `customers: defineTable({ name: z.string() })`;
const JOBS = `import { internalAction } from "incibase/server";\nexport const work = internalAction({ handler: async () => {} });\n`;

async function serve(source: string, data: string, ...flags: string[]) {
  const proc = Bun.spawn(
    [process.execPath, CLI, "serve", "--dir", source, "--data", data, "--port", "0", "--host", "127.0.0.1", ...flags],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, INCIBASE_RESTART: "1" }, timeout: 15_000, killSignal: "SIGKILL" },
  );
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

/** What a failed start must leave as it was. */
function snapshot(data: string) {
  const db = new Database(join(data, "data.db"), { readonly: true });
  try {
    return {
      tables: db.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all(),
      registry: db.query(`SELECT * FROM _incibase_tables ORDER BY name`).all(),
      customers: db.query(`SELECT _id, data FROM customers`).all(),
    };
  } finally {
    db.close();
  }
}

describe("exitCodeOf", () => {
  test("maps each kind of start failure to its code", () => {
    expect(exitCodeOf(new DefinitionError("x"))).toBe(ExitCode.DEFINITION);
    expect(exitCodeOf(new ConfigError("x"))).toBe(ExitCode.CONFIG);
    expect(exitCodeOf(new SystemSchemaTooNewError("data.db", 99))).toBe(ExitCode.CONFIG);
    expect(exitCodeOf(new MigrationError([]))).toBe(ExitCode.MIGRATION_REFUSED);
    expect(exitCodeOf(new DataDirLockedError("data"))).toBe(ExitCode.TEMPORARY);
    expect(exitCodeOf(Object.assign(new Error("Failed to start server"), { code: "EADDRINUSE" }))).toBe(ExitCode.TEMPORARY);
    expect([ExitCode.OK, ExitCode.CRASH, ExitCode.CONFIG, ExitCode.MIGRATION_REFUSED, ExitCode.TEMPORARY, ExitCode.DEFINITION]).toEqual([
      0, 1, 64, 65, 75, 78,
    ]);
  });

  test("anything else is a crash, whatever properties it carries", () => {
    expect(exitCodeOf(new Error("boom"))).toBe(ExitCode.CRASH);
    expect(exitCodeOf("thrown string")).toBe(ExitCode.CRASH);
    expect(exitCodeOf(null)).toBe(ExitCode.CRASH);
    expect(exitCodeOf(undefined)).toBe(ExitCode.CRASH);
    expect(exitCodeOf(Object.assign(new Error("a child process failed"), { exitCode: 78, code: 65 }))).toBe(ExitCode.CRASH);
    expect(exitCodeOf({ [EXIT_CODE]: 3 })).toBe(ExitCode.CRASH);
    // The brand works across copies of the framework (e.g. inside a built app).
    expect(exitCodeOf({ [Symbol.for("incibase.exitCode")]: 78 })).toBe(ExitCode.DEFINITION);
  });
});

describe("listenError", () => {
  test("finds the real cause behind Bun's EADDRINUSE", async () => {
    const bunError = (port: number) => Object.assign(new Error(`Failed to start server. Is port ${port} in use?`), { code: "EADDRINUSE", errno: 0 });
    // A port that really is in use stays retryable: the same error back.
    const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("taken") });
    try {
      const inUse = bunError(taken.port!);
      expect(await listenError(inUse, "127.0.0.1", taken.port!)).toBe(inUse);
    } finally {
      taken.stop(true);
    }
    const unresolvable = await listenError(bunError(0), "no.such.host.invalid", 0);
    expect(unresolvable).toBeInstanceOf(ConfigError);
    expect((unresolvable as Error).message).toBe("Cannot listen on no.such.host.invalid:0: the hostname does not resolve");
    expect(exitCodeOf(await listenError(bunError(0), "192.0.2.1", 0))).toBe(ExitCode.CONFIG);
    // A real code from the OS (or a later Bun) is used as is.
    const denied = await listenError(Object.assign(new Error("denied"), { code: "EACCES" }), "0.0.0.0", 80);
    expect((denied as Error).message).toBe("Cannot listen on 0.0.0.0:80: permission denied (ports below 1024 need privileges)");
    const other = new Error("something else");
    expect(await listenError(other, "127.0.0.1", 0)).toBe(other);
  });
});

describe("definitions are checked before the data dir is touched", () => {
  const jobs = { work: internalAction({ handler: async () => {} }) };

  test("an unknown cron target", () => {
    const crons = cronJobs();
    crons.interval("beat", { minutes: 1 }, "jobs:missing" as never, {} as never);
    const data = join(dir(), "data");
    const err = errorOf(() => open({ modules: { jobs, crons: { default: crons } } }, data));
    expect(err).toBeInstanceOf(DefinitionError);
    expect((err as Error).message).toBe(`Cron "beat" points to unknown function "jobs:missing"`);
    expect(existsSync(data)).toBe(false);
  });

  test("a cron schedule that does not parse or never fires", () => {
    for (const [expression, tz, message] of [
      ["* * * * * *", undefined, "seconds are not supported"],
      ["0 9 * * *", "Not/AZone", "unknown time zone"],
      ["0 0 31 4 *", undefined, `Cron "beat" never fires: 0 0 31 4 *`],
    ] as const) {
      const crons = cronJobs();
      crons.cron("beat", expression, "jobs:work" as never, undefined, tz ? { tz } : undefined);
      const data = join(dir(), "data");
      const err = errorOf(() => open({ modules: { jobs, crons: { default: crons } } }, data));
      expect(err).toBeInstanceOf(DefinitionError);
      expect((err as Error).message).toContain(message);
      expect(existsSync(data)).toBe(false);
    }
    // A leap day does fire.
    const crons = cronJobs();
    crons.cron("leap", "0 0 29 2 *", "jobs:work" as never);
    open({ modules: { jobs, crons: { default: crons } } }, join(dir(), "data"));
  });

  test("a schema export that is not defineSchema, or a table that is not defineTable", () => {
    const data = join(dir(), "data");
    const notSchema = { tables: {} } as unknown as AppDefinition["schema"];
    expect(errorOf(() => open({ schema: notSchema, modules: {} }, data))).toBeInstanceOf(DefinitionError);
    const notTable = defineSchema({ orders: { name: z.string() } as never });
    const err = errorOf(() => open({ schema: notTable, modules: {} }, data));
    expect(err).toBeInstanceOf(DefinitionError);
    expect((err as Error).message).toBe(`Table "orders" in the schema must be defineTable({...})`);
    expect(existsSync(data)).toBe(false);
  });

  test("module and function names a function path cannot carry", () => {
    const data = join(dir(), "data");
    expect((errorOf(() => open({ modules: { "chat-room": jobs } }, data)) as Error).message).toContain(`Invalid module path "chat-room"`);
    expect((errorOf(() => open({ modules: { "chat//x": jobs } }, data)) as Error).message).toContain(`Invalid module path`);
    expect((errorOf(() => open({ modules: { jobs: { "a:b": jobs.work } } }, data)) as Error).message).toBe(
      `Invalid function name "a:b" in jobs`,
    );
    expect(existsSync(data)).toBe(false);
    open({ modules: { "chat/rooms_2": { $list: jobs.work, _internal: jobs.work } } }, data);
  });

  test("definition helpers throw DefinitionError", () => {
    const route = { method: "GET", path: "/hook", handler: httpAction(async () => new Response("ok")) } as const;
    const http = httpRouter().route(route);
    expect(errorOf(() => http.route(route))).toBeInstanceOf(DefinitionError);
    expect((errorOf(() => http.route(route)) as Error).message).toBe("Duplicate route GET /hook");
    const prefix = { method: "GET", pathPrefix: "/files/", handler: route.handler } as const;
    http.route(prefix).route({ ...route, method: "POST" }).route({ ...route, path: "/hook/" });
    expect((errorOf(() => http.route(prefix)) as Error).message).toBe("Duplicate route GET /files/*");
    expect(errorOf(() => http.route({ ...route, path: "/api/x" }))).toBeInstanceOf(DefinitionError);

    const crons = cronJobs();
    crons.interval("a", { seconds: 1 }, "jobs:work" as never, {} as never);
    // The imported function itself instead of a reference to it.
    const notRef = errorOf(() => crons.interval("c", { seconds: 1 }, jobs.work as never, {} as never));
    expect(notRef).toBeInstanceOf(DefinitionError);
    expect((notRef as Error).message).toBe(`Cron "c": the target must be a function reference such as internal.jobs.work`);
    expect(errorOf(() => crons.cron("d", "0 9 * * *", {} as never))).toBeInstanceOf(DefinitionError);
    expect(errorOf(() => crons.interval("a", { seconds: 1 }, "jobs:work" as never, {} as never))).toBeInstanceOf(DefinitionError);
    expect(errorOf(() => crons.interval("b", { seconds: 0 }, "jobs:work" as never, {} as never))).toBeInstanceOf(DefinitionError);
    expect(errorOf(() => defineSchema({ "bad-name": defineTable({}) }))).toBeInstanceOf(DefinitionError);
    expect(errorOf(() => defineTable({ "bad-field": z.string() }))).toBeInstanceOf(DefinitionError);
    expect(errorOf(() => defineTable({ a: z.string() }).index("by_a", ["a"]).index("by_a", ["a"]))).toBeInstanceOf(DefinitionError);
    expect(errorOf(() => internalAction({ handler: async () => {}, mcp: true }))).toBeInstanceOf(DefinitionError);
  });
});

describe("system schema version", () => {
  test("is written on init, and a newer one is refused before any change", async () => {
    const data = dir();
    await open({ modules: {} }, data).stop();
    expect(readMeta(join(data, "data.db"), "system_schema_version")).toBe(String(SYSTEM_SCHEMA_VERSION));

    // A database a newer incibase created: only its meta table, with a higher version.
    const newer = dir();
    const db = new Database(join(newer, "data.db"), { create: true });
    db.run(`CREATE TABLE _incibase_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO _incibase_meta VALUES ('system_schema_version', ?)`, [String(SYSTEM_SCHEMA_VERSION + 1)]);
    db.close();
    const err = errorOf(() => open({ modules: {} }, newer));
    expect(err).toBeInstanceOf(SystemSchemaTooNewError);
    expect((err as Error).message).toContain(`has system schema version ${SYSTEM_SCHEMA_VERSION + 1}`);
    const check = new Database(join(newer, "data.db"), { readonly: true });
    expect(check.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual([{ name: "_incibase_meta" }]);
    check.close();
    // The refused start released the lock: the error, not a lock, refuses the next one too.
    expect(errorOf(() => open({ modules: {} }, newer))).toBeInstanceOf(SystemSchemaTooNewError);
  });

  test("a database from before the version gets it", async () => {
    const data = dir();
    const engine = open({ modules: {} }, data);
    engine.store.write.run(`DELETE FROM _incibase_meta WHERE key = 'system_schema_version'`);
    await engine.stop();
    await open({ modules: {} }, data).stop();
    expect(readMeta(join(data, "data.db"), "system_schema_version")).toBe(String(SYSTEM_SCHEMA_VERSION));
  });
});

describe("incibase serve exit codes", () => {
  test("a schema export that is not defineSchema exits 78 and creates nothing", async () => {
    const { data, source } = await project({ "schema.ts": `export default { orders: {} };\n` });
    const before = snapshot(data);
    const result = await serve(source, data);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain("must `export default defineSchema({...})`");
    expect(snapshot(data)).toEqual(before);

    // A fresh data dir is not even created.
    const fresh = join(dir(), "fresh");
    expect((await serve(source, fresh)).code).toBe(78);
    expect(existsSync(fresh)).toBe(false);
  }, 20_000);

  test("a table that is not defineTable exits 78 and creates no table", async () => {
    const { data, source } = await project({ "schema.ts": SCHEMA(`${CUSTOMERS}, orders: { total: z.number() } as any`) });
    const before = snapshot(data);
    const result = await serve(source, data);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain(`Table "orders" in the schema must be defineTable({...})`);
    expect(snapshot(data)).toEqual(before);
  }, 20_000);

  test("an invalid definition in a module (here a bad field name) exits 78", async () => {
    const { data, source } = await project({ "schema.ts": SCHEMA(`${CUSTOMERS}, orders: defineTable({ "total-sum": z.number() })`) });
    const before = snapshot(data);
    const result = await serve(source, data);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain(`Invalid field name "total-sum"`);
    expect(snapshot(data)).toEqual(before);
  }, 20_000);

  test("an unknown cron target exits 78 with nothing committed", async () => {
    const { data, source } = await project({
      // The new table would be created by the migration, which must not run.
      "schema.ts": SCHEMA(`${CUSTOMERS}, orders: defineTable({ total: z.number() })`),
      "jobs.ts": JOBS,
      "crons.ts":
        `import { cronJobs } from "incibase/server";\nconst crons = cronJobs();\n` +
        `crons.interval("beat", { minutes: 1 }, "jobs:missing");\nexport default crons;\n`,
    });
    const before = snapshot(data);
    const result = await serve(source, data);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain(`Cron "beat" points to unknown function "jobs:missing"`);
    expect(snapshot(data)).toEqual(before);
  }, 20_000);

  test("a cron target that is the imported function, not a reference, exits 78", async () => {
    const { data, source } = await project({
      "schema.ts": SCHEMA(CUSTOMERS),
      "jobs.ts": JOBS,
      "crons.ts":
        `import { cronJobs } from "incibase/server";\nimport { work } from "./jobs";\nconst crons = cronJobs();\n` +
        `crons.interval("beat", { minutes: 1 }, work as any);\nexport default crons;\n`,
    });
    const before = snapshot(data);
    const result = await serve(source, data);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain(`Cron "beat": the target must be a function reference such as internal.jobs.work`);
    expect(snapshot(data)).toEqual(before);
  }, 20_000);

  test("a malformed cron spec exits 78", async () => {
    const { data, source } = await project({
      "schema.ts": SCHEMA(CUSTOMERS),
      "jobs.ts": JOBS,
      "crons.ts":
        `import { cronJobs } from "incibase/server";\nconst crons = cronJobs();\n` +
        `crons.cron("beat", "every day", "jobs:work");\nexport default crons;\n`,
    });
    const result = await serve(source, data);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain(`Cron "beat": Invalid cron expression`);
  }, 20_000);

  test("a refused migration exits 65 and leaves the data intact", async () => {
    const { data, source } = await project({ "schema.ts": SCHEMA(`customers: defineTable({ name: z.number() })`) });
    const before = snapshot(data);
    const result = await serve(source, data);
    expect(result.code).toBe(65);
    expect(result.stderr).toContain("Schema does not match 1 existing document(s)");
    expect(snapshot(data)).toEqual(before);
  }, 20_000);

  test("a unique index the existing data breaks exits 65 and leaves the data intact", async () => {
    const { data, source } = await project({ "schema.ts": SCHEMA(CUSTOMERS) });
    const engine = open({ schema: defineSchema({ customers: defineTable({ name: z.string() }) }), modules: {} }, data);
    await engine.writeTx((s) => s.insert("customers", { name: "Acme" }));
    await engine.stop();
    writeFileSync(join(source, "schema.ts"), SCHEMA(`customers: defineTable({ name: z.string() }).index("by_name", ["name"], { unique: true })`));
    const before = snapshot(data);
    const result = await serve(source, data);
    expect(result.code).toBe(65);
    expect(result.stderr).toContain("Cannot create index customers.by_name");
    expect(snapshot(data)).toEqual(before);
  }, 20_000);

  test("a second process on the same data dir exits 75", async () => {
    const { data, source } = await project({ "schema.ts": SCHEMA(CUSTOMERS) });
    open({ schema: defineSchema({ customers: defineTable({ name: z.string() }) }), modules: {} }, data);
    const result = await serve(source, data);
    expect(result.code).toBe(75);
    expect(result.stderr).toContain("is in use by another incibase process");
  }, 20_000);

  test("an address in use exits 75 and releases the data dir", async () => {
    const { data, source } = await project({ "schema.ts": SCHEMA(CUSTOMERS) });
    const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("taken") });
    try {
      const result = await serve(source, data, "--port", String(taken.port));
      expect(result.code).toBe(75);
      expect(result.stderr).toContain(`Is port ${taken.port} in use?`);
    } finally {
      taken.stop(true);
    }
    open({ schema: defineSchema({ customers: defineTable({ name: z.string() }) }), modules: {} }, data);
  }, 20_000);

  test("a host that does not resolve, or an address not on this machine, exits 64 (Bun reports both as in use)", async () => {
    const { data, source } = await project({ "schema.ts": SCHEMA(CUSTOMERS) });
    const unresolvable = await serve(source, data, "--host", "no.such.host.invalid");
    expect(unresolvable.code).toBe(64);
    expect(unresolvable.stderr).toContain("Cannot listen on no.such.host.invalid:0: the hostname does not resolve");
    // TEST-NET-1: reserved for documentation, never assigned to a machine.
    const foreign = await serve(source, data, "--host", "192.0.2.1");
    expect(foreign.code).toBe(64);
    expect(foreign.stderr).toContain("Cannot listen on 192.0.2.1:0: the address is not on this machine");
    // Both released the data dir.
    open({ schema: defineSchema({ customers: defineTable({ name: z.string() }) }), modules: {} }, data);
  }, 20_000);

  test("a module that throws on import exits 1 (the app's own error)", async () => {
    const { data, source } = await project({
      "schema.ts": SCHEMA(`${CUSTOMERS}, orders: defineTable({ total: z.number() })`),
      "jobs.ts": `throw new Error("STRIPE_KEY is not set");\n`,
    });
    const before = snapshot(data);
    const result = await serve(source, data);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("STRIPE_KEY is not set");
    expect(snapshot(data)).toEqual(before);
  }, 20_000);

  test("a database with a newer system schema exits 64", async () => {
    const { data, source } = await project({ "schema.ts": SCHEMA(CUSTOMERS) });
    const db = new Database(join(data, "data.db"));
    db.run(`UPDATE _incibase_meta SET value = ? WHERE key = 'system_schema_version'`, [String(SYSTEM_SCHEMA_VERSION + 1)]);
    db.close();
    const before = snapshot(data);
    const result = await serve(source, data);
    expect(result.code).toBe(64);
    expect(result.stderr).toContain(`has system schema version ${SYSTEM_SCHEMA_VERSION + 1}`);
    expect(snapshot(data)).toEqual(before);
  }, 20_000);

  test("bad flags and environment exit 64", async () => {
    const { data, source } = await project({ "schema.ts": SCHEMA(CUSTOMERS) });
    const unknownFlag = await serve(source, data, "--prot", "3000");
    expect(unknownFlag.code).toBe(64);
    expect(unknownFlag.stderr).toContain("--prot");
    const badPort = await serve(source, data, "--port", "http");
    expect(badPort.code).toBe(64);
    expect(badPort.stderr).toContain(`Invalid port "http"`);

    const proc = Bun.spawn([process.execPath, CLI, "serve", "--dir", source, "--data", data, "--port", "0", "--host", "127.0.0.1"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, INCIBASE_MAX_JSON_BYTES: "lots" },
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    expect(await proc.exited).toBe(64);
    expect(await new Response(proc.stderr).text()).toContain("INCIBASE_MAX_JSON_BYTES must be a positive whole number");
  }, 20_000);

  test("an app dir, data dir, database or lock file that cannot be used exits 64", async () => {
    const { root, data, source } = await project({ "schema.ts": SCHEMA(CUSTOMERS) });
    const missing = await serve(join(root, "nope"), join(root, "data2"));
    expect(missing.code).toBe(64);
    expect(missing.stderr).toContain(`No app directory ${join(root, "nope")}`);
    expect(existsSync(join(root, "data2"))).toBe(false);
    expect((await serve(join(source, "schema.ts"), join(root, "data2"))).code).toBe(64);

    const file = join(root, "a-file");
    writeFileSync(file, "");
    for (const dataDir of [join(file, "data"), file]) {
      const result = await serve(source, dataDir);
      expect(result.code).toBe(64);
      expect(result.stderr).toContain("as a data directory");
    }

    const corrupt = join(root, "corrupt");
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, "data.db"), "not a database, just text that is long enough to be read as a header".repeat(20));
    const notDb = await serve(source, corrupt);
    expect(notDb.code).toBe(64);
    expect(notDb.stderr).toContain(`${join(corrupt, "data.db")} is not an SQLite database`);

    writeFileSync(join(data, "LOCK"), "written by some other tool".repeat(40));
    const badLock = await serve(source, data);
    expect(badLock.code).toBe(64);
    expect(badLock.stderr).toContain("is not an incibase lock file");
  }, 30_000);

  test("an unknown command exits 64", async () => {
    const proc = Bun.spawn([process.execPath, CLI, "serv", "--dir", "x"], { stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL" });
    expect(await proc.exited).toBe(64);
    expect(await new Response(proc.stderr).text()).toContain(`Unknown command "serv"`);
  }, 20_000);
});

describe("incibase dev", () => {
  test("names why the server stopped and waits for the next change", async () => {
    const { data, source } = await project({
      "schema.ts": SCHEMA(CUSTOMERS),
      "jobs.ts": JOBS,
      "crons.ts":
        `import { cronJobs } from "incibase/server";\nconst crons = cronJobs();\n` +
        `crons.interval("beat", { minutes: 1 }, "jobs:missing");\nexport default crons;\n`,
    });
    const dev = Bun.spawn([process.execPath, CLI, "dev", "--dir", source, "--data", data, "--port", "0", "--host", "127.0.0.1"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, INCIBASE_RESTART: "1" },
      timeout: 25_000,
      killSignal: "SIGKILL",
    });
    const output = { text: "" };
    for (const stream of [dev.stdout, dev.stderr]) {
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) output.text += decoder.decode(chunk, { stream: true });
      })();
    }
    const until = async (text: string) => {
      for (const end = Date.now() + 15_000; !output.text.includes(text); await Bun.sleep(50)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${text} in:\n${output.text}`);
      }
    };
    try {
      await until("Server stopped (invalid app definition); waiting for changes...");
      expect(dev.exitCode).toBeNull();
      writeFileSync(
        join(source, "crons.ts"),
        `import { cronJobs } from "incibase/server";\nconst crons = cronJobs();\n` +
          `crons.interval("beat", { minutes: 1 }, "jobs:work");\nexport default crons;\n`,
      );
      await until("ready");
    } finally {
      dev.kill("SIGTERM");
      await dev.exited;
    }
  }, 30_000);
});

describe("built app exit codes", () => {
  test("a module of a built app that throws on import exits with its code", async () => {
    const root = dir();
    const source = join(root, "app");
    mkdirSync(source);
    writeFileSync(join(source, "schema.ts"), SCHEMA(CUSTOMERS));
    writeFileSync(
      join(source, "jobs.ts"),
      `import { cronJobs, internalAction } from "incibase/server";\n` +
        `if (process.env.APP_FAIL === "definition") { const c = cronJobs(); c.interval("a", { seconds: 1 }, "x:y"); c.interval("a", { seconds: 1 }, "x:y"); }\n` +
        `if (process.env.APP_FAIL === "crash") throw new Error("crashed on import");\n` +
        `export const work = internalAction({ handler: async () => {} });\n`,
    );
    const outfile = join(root, "app-bin");
    await buildApp({ dir: source, outfile, minify: false });
    const run = async (fail: string) => {
      const data = join(root, `data-${fail}`);
      const proc = Bun.spawn([outfile, "serve", "--data", data, "--port", "0", "--host", "127.0.0.1"], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, APP_FAIL: fail, INCIBASE_RESTART: "1" },
        timeout: 15_000,
        killSignal: "SIGKILL",
      });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { stderr, code, created: existsSync(data) };
    };
    const definition = await run("definition");
    expect(definition.code).toBe(78);
    expect(definition.stderr).toContain(`Duplicate cron job "a"`);
    expect(definition.created).toBe(false);
    const crash = await run("crash");
    expect(crash.code).toBe(1);
    expect(crash.stderr).toContain("crashed on import");
    expect(crash.created).toBe(false);
    const notOffered = Bun.spawn([outfile, "codegen"], { stdout: "pipe", stderr: "pipe", timeout: 15_000, killSignal: "SIGKILL" });
    expect(await notOffered.exited).toBe(64);
    expect(await new Response(notOffered.stderr).text()).toContain(`"codegen" is not available in a built app`);
  }, 60_000);
});
