import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
