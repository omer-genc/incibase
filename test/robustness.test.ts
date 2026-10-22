import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { internalAction } from "incibase/server";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { DataDirLockedError } from "../src/engine/store.ts";
import { EXAMPLE_DIR, tempDir } from "./helpers.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");

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

async function until(check: () => unknown, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

const schedule = (engine: Engine, path: string, delayMs = 0) =>
  engine.writeTx((s) => engine.scheduler.forSession(s).runAfter(delayMs, path));

function job(engine: Engine, id: string): Record<string, unknown> | null {
  const row = engine.store.read.query(`SELECT data FROM _scheduled WHERE _id = ?`).get(id) as { data: string } | null;
  return row ? JSON.parse(row.data) : null;
}

/** The environment for child processes, without an admin key override. */
function childEnv() {
  const { INCIBASE_ADMIN_KEY: _, ...env } = process.env;
  return env;
}

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: childEnv(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

/** Runs `source` as its own bun process; `ROOT` in it is the repository root. */
function script(source: string) {
  const file = join(dir(), "script.ts");
  writeFileSync(file, source.replaceAll("ROOT", JSON.stringify(ROOT).slice(1, -1)));
  return file;
}

describe("data dir lock", () => {
  test("a second engine on a data dir fails until the first one stops", async () => {
    const data = dir();
    const first = open({ modules: {} }, data);
    const err = (() => {
      try {
        open({ modules: {} }, data);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(DataDirLockedError);
    expect(err!.message).toContain(resolve(data));

    // The failed attempt must not have dropped the first engine's lock.
    const other = await run(["bun", CLI, "serve", "--dir", EXAMPLE_DIR, "--data", data, "--port", "0"]);
    expect(other.code).toBe(1);
    expect(other.stderr).toContain(`Data directory ${resolve(data)} is in use by another incibase process`);
    await first.writeTx((s) => s.conn.run(`INSERT INTO _incibase_meta (key, value) VALUES ('still', 'mine')`));

    await first.stop();
    const next = open({ modules: {} }, data);
    expect(next.store.getMeta("still")).toBe("mine");
  });

  test("the lock is released when the holding process dies", async () => {
    const data = dir();
    const holder = Bun.spawn(
      [
        "bun",
        script(`
          import { Engine } from "ROOT/src/engine/engine.ts";
          new Engine({ modules: {} }, { dataDir: process.argv[2], quiet: true, publicUrl: "http://x" });
          console.log("ready");
          setInterval(() => {}, 1000);
        `),
        data,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const { value } = await holder.stdout.getReader().read();
    expect(new TextDecoder().decode(value)).toContain("ready");
    expect(() => open({ modules: {} }, data)).toThrow(DataDirLockedError);
    holder.kill("SIGKILL");
    await holder.exited;
    open({ modules: {} }, data);
  });

  test("admin-key reads the key while a server holds the lock, without writing", async () => {
    const data = dir();
    const engine = open({ modules: {} }, data);
    engine.start();
    const live = await run(["bun", CLI, "admin-key", "--data", data]);
    expect(live.stderr).toBe("");
    expect(live.stdout.trim()).toBe(engine.adminKey);

    // A database with only the meta table: no system tables are created and no lock is taken.
    const bare = dir();
    const db = new Database(join(bare, "data.db"), { create: true });
    db.run(`CREATE TABLE _incibase_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.run(`INSERT INTO _incibase_meta VALUES ('admin_key', 'ik_admin_bare')`);
    db.close();
    const result = await run(["bun", CLI, "admin-key", "--data", bare]);
    expect(result.stdout.trim()).toBe("ik_admin_bare");
    const check = new Database(join(bare, "data.db"), { readonly: true });
    expect(check.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual([{ name: "_incibase_meta" }]);
    check.close();
    expect(existsSync(join(bare, "LOCK"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("file permissions", () => {
  const mode = (path: string) => statSync(path).mode & 0o777;
  const files = (data: string) =>
    ["data.db", "data.db-wal", "data.db-shm", "LOCK"].map((f) => join(data, f)).filter((f) => existsSync(f));

  test("the data dir, storage dir and database files are created owner-only", async () => {
    const parent = join(dir(), "nested");
    const data = join(parent, "data");
    const engine = open({ modules: {} }, data);
    await engine.writeTx((s) => s.conn.run(`INSERT INTO _incibase_meta (key, value) VALUES ('x', 'y')`));
    expect(mode(parent)).toBe(0o700);
    expect(mode(data)).toBe(0o700);
    expect(mode(join(data, "storage"))).toBe(0o700);
    const created = files(data);
    expect(created).toContain(join(data, "data.db-wal"));
    for (const file of created) expect([file, mode(file)]).toEqual([file, 0o600]);
  });

  test("looser modes on existing files are tightened on start", async () => {
    const data = dir();
    await open({ modules: {} }, data).stop();
    mkdirSync(join(data, "storage"), { recursive: true });
    for (const path of [data, join(data, "storage")]) chmodSync(path, 0o755);
    for (const file of files(data)) chmodSync(file, 0o644);

    open({ modules: {} }, data);
    expect(mode(data)).toBe(0o700);
    expect(mode(join(data, "storage"))).toBe(0o700);
    for (const file of files(data)) expect([file, mode(file)]).toEqual([file, 0o600]);
  });
});

describe("scheduler", () => {
  test("a slow job does not hold back a job that comes due after it", async () => {
    const events: string[] = [];
    const jobs = {
      slow: internalAction({
        handler: async () => {
          events.push("slow started");
          await Bun.sleep(1000);
          events.push("slow done");
        },
      }),
      quick: internalAction({ handler: async () => void events.push("quick") }),
    };
    const engine = open({ modules: { jobs } }, dir());
    engine.start();
    await engine.writeTx(async (s) => {
      await engine.scheduler.forSession(s).runAfter(0, "jobs:slow");
      await engine.scheduler.forSession(s).runAfter(150, "jobs:quick");
    });
    await until(() => events.includes("quick"));
    expect(events).toEqual(["slow started", "quick"]);
  });

  test("a failed status write is retried and frees its slot", async () => {
    let failNextWrite = false;
    const jobs = { work: internalAction({ handler: async () => void (failNextWrite = true) }) };
    const engine = open({ modules: { jobs } }, dir());
    const writeTx = engine.writeTx.bind(engine);
    engine.writeTx = ((fn, identity) => {
      if (!failNextWrite) return writeTx(fn, identity);
      failNextWrite = false;
      return Promise.reject(Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }));
    }) as Engine["writeTx"];
    engine.start();

    // More jobs than the scheduler has slots: a leaked slot would stall the last ones.
    for (let i = 0; i < 9; i++) {
      const id = await schedule(engine, "jobs:work");
      await until(() => job(engine, id)?.state === "success");
    }
    const failures = engine.logs.filter((l) => !l.ok && l.path.startsWith("scheduler: saving status of jobs:work"));
    expect(failures).toHaveLength(9);
    expect(failures[0]!.error).toBe("database or disk is full");
  });

  test("SQLITE_BUSY in recovery and claims is retried once the database is free", async () => {
    const ran: string[] = [];
    const jobs = { work: internalAction({ handler: async () => void ran.push("work") }) };
    const data = dir();
    const first = open({ modules: { jobs } }, data);
    const stale = await schedule(first, "jobs:work");
    const due = await schedule(first, "jobs:work");
    // As if the server had crashed while running `stale`.
    await first.writeTx((s) => s.conn.query(`UPDATE _scheduled SET data = json_set(data, '$.state', 'running') WHERE _id = ?`).run(stale));
    await first.stop();

    const engine = open({ modules: { jobs } }, data);
    engine.store.write.run("PRAGMA busy_timeout = 10");
    const other = new Database(join(data, "data.db"));
    other.run("BEGIN IMMEDIATE");
    engine.start();
    const busy = (path: string) => engine.logs.some((l) => l.path === `scheduler: ${path}` && l.error === "database is locked");
    await until(() => busy("restart recovery") && busy("tick"));
    expect(job(engine, due)!.state).toBe("pending");
    expect(job(engine, stale)!.state).toBe("running");

    other.run("COMMIT");
    other.close();
    await until(() => job(engine, due)?.state === "success" && job(engine, stale)?.state === "failed");
    expect(job(engine, stale)!.error).toBe("Interrupted by server restart");
    expect(job(engine, due)!.error).toBeUndefined();
    expect(ran).toEqual(["work"]);
  });

  test("a locked database while a job comes due does not crash the process", async () => {
    const data = dir();
    const result = await run([
      "bun",
      script(`
        import { Database } from "bun:sqlite";
        import { join } from "node:path";
        import { Engine } from "ROOT/src/engine/engine.ts";
        import { internalMutation } from "ROOT/src/server.ts";

        const dataDir = process.argv[2];
        const noop = internalMutation({ handler: async () => {} });
        const engine = new Engine({ modules: { jobs: { noop } } }, { dataDir, quiet: true, publicUrl: "http://x" });
        engine.store.write.run("PRAGMA busy_timeout = 10");
        engine.start();
        const id = await engine.writeTx((s) => engine.scheduler.forSession(s).runAfter(50, "jobs:noop"));
        const other = new Database(join(dataDir, "data.db"));
        other.run("BEGIN IMMEDIATE");
        await Bun.sleep(400);
        other.run("COMMIT");
        other.close();
        const state = () => engine.store.read.query("SELECT json_extract(data, '$.state') AS s FROM _scheduled WHERE _id = ?").get(id).s;
        for (let i = 0; i < 200 && state() !== "success"; i++) await Bun.sleep(10);
        console.log(JSON.stringify({ state: state(), failed: engine.logs.filter((l) => !l.ok).map((l) => l.path) }));
        await engine.stop();
      `),
      data,
    ]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.state).toBe("success");
    expect(out.failed).toContain("scheduler: tick");
  });
});

describe("crash handlers", () => {
  test("an action that leaves a failing ctx.runMutation unawaited does not take the server down", async () => {
    const result = await run([
      "bun",
      script(`
        import { installCrashHandlers } from "ROOT/src/cli.ts";
        import { Engine } from "ROOT/src/engine/engine.ts";
        import { startServer } from "ROOT/src/engine/http.ts";
        import { action, internalMutation, query } from "ROOT/src/server.ts";

        const fail = internalMutation({ handler: async () => { throw new Error("mutation failed on purpose"); } });
        const fire = action({ handler: async (ctx) => { ctx.runMutation("app:fail"); return "fired"; } });
        const ping = query({ handler: async () => "pong" });
        const engine = new Engine({ modules: { app: { fail, fire, ping } } }, { dataDir: process.argv[2], quiet: true, publicUrl: "http://x" });
        engine.start();
        const server = startServer(engine, { port: 0, hostname: "127.0.0.1" });
        installCrashHandlers();
        const call = async (kind, path) => {
          const res = await fetch(server.url.origin + "/api/" + kind, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, args: {} }),
          });
          return (await res.json()).value;
        };
        const fired = await call("action", "app:fire");
        await Bun.sleep(100);
        console.log(JSON.stringify({ fired, after: await call("query", "app:ping") }));
        server.stop(true);
        await engine.stop();
      `),
      join(dir(), "data"),
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ fired: "fired", after: "pong" });
    expect(result.stderr).toContain("unhandled promise rejection");
    expect(result.stderr).toContain("mutation failed on purpose");
  });
});
