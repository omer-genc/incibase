// Privilege-separated snapshots on a real Linux machine, as root (design
// section 3.2 D.3.1): root must never read a branch's database through
// SQLite or by a name the branch controls. The snapshot is produced by
// `incibase-snapshot@<id>`, which runs `incibase _snapshot` as the BRANCH in
// the branch's sandbox; root then takes the finished staging file in by fd
// (O_RDONLY|O_NOFOLLOW|O_NONBLOCK, fstat regular/owner/nlink/size, SQLite
// header), copies it by fd (sparse-preserving) into a root-only temp and
// renames it into place.
//
// The tests, in the order they run, all against a branch uid with real units:
//   1. ingestFile refuses every hostile staging file a branch can plant (a
//      symlink to /etc/shadow, the control registry or another branch's
//      database, a FIFO, a second hard link, a file over the cap, a
//      non-SQLite file), never touching what a symlink points at.
//   2. The by-fd copy keeps holes: a 200 MiB sparse staging file under the
//      cap becomes a copy with almost nothing allocated, and a database with
//      long runs of zeros goes through ingestFile, copyFile and a whole
//      snapshotDatabase byte for byte (sha256), its zeros left as holes.
//   3. Inflating data.db (a 2 GiB sparse file) lifts the branch's
//      INCIBASE_MAX_DB_BYTES cap to twice the limit and no further: a dense
//      file the branch swaps in just before root's ingest (injected there, so
//      no race) is refused, and a real database over a lowered limit is
//      still snapshotted.
//   4. The snapshot unit runs as the branch: a data.db, -wal or -shm swapped
//      for a symlink to the registry is refused or yields the branch's own data.
//   5. A branch process races root (flipping data.db and the staging output
//      through every shape above) while root snapshots in a loop: no snapshot
//      ever holds a secret or a foreign database, and none hangs. Nothing is
//      asserted about how the race goes; the racer clobbers the staging file
//      so often that a run may take no snapshot at all, so this guards
//      against hangs, not against the root-side read (test 7 does).
//   6. A real snapshot and `rollback --restore` still work end to end.
//   7. The regression guard for the removed root-side read, deterministic:
//      the branch's move (unlink data.db, plant `data.db (deleted)` -> the
//      registry, put its own database back) is injected before each of root's
//      HostSystem calls in turn (withMoveBefore), with no race. The old
//      algorithm (oldSnapshotByName, kept in this file with the same calls
//      between its pin and SQLite's open as commit 2f794ad) leaks the
//      registry's marker at every one of them; snapshotDatabase gives the
//      branch's own data at every one and leaks nothing, and at none of its
//      calls does root hold anything open in the branch's data/ (the old
//      algorithm holds its pin across all of them). Put the old algorithm
//      back into snapshotDatabase and this test fails.
//   8. The unit runs the newer of this host's runtime and the branch's pin: a
//      branch pinned to a stub without _snapshot snapshots with this host's.
//   9. A unit SIGKILLed while the job lives on leaves its staging dir empty:
//      once deterministically (a 99.0.0 wrapper runtime, picked as the newer
//      for a branch pinned to it, leaves a partial snapshot.db.tmp and its
//      -journal and waits to be killed), and once during a real VACUUM INTO
//      of a large database, where whichever way the timing goes the staging
//      dir must end up empty.
//
// Skipped unless INCIBASE_TEST_HOST=1 on Linux as root; needs
// INCIBASE_TEST_BINARY (a standalone incibase for this machine, for the
// branch's _snapshot). Host root INCIBASE_TEST_HOST_ROOT (/var/lib/incibase-snp)
// and uid base INCIBASE_TEST_UID_BASE (84000); it removes everything it made.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, constants as fsConstants, chownSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sha256Hex } from "../src/engine/manifest.ts";
import { VERSION } from "../src/engine/version.ts";
import { openHost, type OpsContext } from "../src/host/context.ts";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { Registry, type BranchRow } from "../src/host/registry.ts";
import { databaseBytes, DB_FILES, restoreDatabase, snapshotDatabase, SnapshotError } from "../src/host/snapshot.ts";
import { IngestError, LinuxSystem, type HostSystem } from "../src/host/system.ts";

const enabled = process.env.INCIBASE_TEST_HOST === "1" && process.platform === "linux" && process.getuid?.() === 0;
const ROOT = process.env.INCIBASE_TEST_HOST_ROOT ?? "/var/lib/incibase-snp";
const UID_BASE = Number(process.env.INCIBASE_TEST_UID_BASE ?? 84000);
const BINARY = process.env.INCIBASE_TEST_BINARY ?? "";
const MARKER = `incibase-secret-${process.pid}-${Date.now().toString(36)}`;
const MARKER2 = `${MARKER}-other-branch`;
const LABEL = basename(ROOT).slice(0, 24);
const LAYOUT = { unitPrefix: LABEL, groups: { proxy: `${LABEL}-proxy`, admin: `${LABEL}-admin` }, runtimeRoot: `/usr/local/lib/${LABEL}` };
const SROOT = "/etc/shadow";
const SLOW = 120_000;

const sys = new LinuxSystem();
let ctx: OpsContext;
let prod: BranchRow;
let other: BranchRow;
/** The branch's live connections, kept open so uncheckpointed WAL rows exist throughout. */
const live: Database[] = [];
/** A script run as the branch uid; kept so cleanup can reach any it left running. */
const RACER = `/tmp/${LABEL}-racer.ts`;

function cleanup() {
  for (const db of live.splice(0)) try { db.close(); } catch {}
  const prefix = LAYOUT.unitPrefix;
  for (const line of Bun.spawnSync(["systemctl", "list-units", "--all", "--plain", "--no-legend", `${prefix}-*`]).stdout.toString().split("\n")) {
    const unit = line.trim().split(/\s+/)[0];
    if (unit?.startsWith(`${prefix}-`)) {
      Bun.spawnSync(["systemctl", "stop", unit]);
      Bun.spawnSync(["systemctl", "reset-failed", unit]);
    }
  }
  Bun.spawnSync(["systemctl", "stop", `${prefix}.slice`]);
  for (const dir of [LAYOUT.runtimeRoot === DEFAULT_ROOT ? "" : "/etc/systemd/system"].filter(Boolean)) {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) if (name.startsWith(`${prefix}-`) || name === `${prefix}.slice`) rmSync(join(dir, name), { recursive: true, force: true });
  }
  Bun.spawnSync(["systemctl", "daemon-reload"]);
  if (existsSync(join(ROOT, "control", "registry.db"))) {
    const registry = Registry.open(new HostLayout({ root: ROOT, ...LAYOUT }));
    for (const b of registry.listBranches()) {
      for (const pid of sys.processesOf(b.os_uid)) try { process.kill(pid, "SIGKILL"); } catch {}
      if (sys.getpwnam(`ib-${b.id}`)?.uid === b.os_uid) sys.userdel(`ib-${b.id}`);
      if (sys.getgrnam(`ib-${b.id}`)?.gid === b.os_uid) sys.groupdel(`ib-${b.id}`);
    }
    registry.close();
  }
  for (const g of [LAYOUT.groups.proxy, LAYOUT.groups.admin]) if (sys.getgrnam(g)) sys.groupdel(g);
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(LAYOUT.runtimeRoot, { recursive: true, force: true });
  rmSync(RACER, { force: true });
}

/** A real WAL database for `branch` holding `rows` copies of `value`, owned by the branch; the connection stays open. */
function seed(branch: BranchRow, value: string, rows = 40): string {
  const data = ctx.layout.branch(branch.id).data;
  const path = join(data, "data.db");
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA wal_autocheckpoint = 0");
  db.run("CREATE TABLE IF NOT EXISTS t (v TEXT)");
  for (let i = 0; i < rows; i++) db.run("INSERT INTO t VALUES (?)", [value]);
  live.push(db);
  for (const name of ["data.db", "data.db-wal", "data.db-shm"]) {
    const p = join(data, name);
    if (existsSync(p)) chownSync(p, branch.os_uid, branch.os_uid);
  }
  return path;
}

const asBranch = (uid: number, argv: string[], opts: { timeout?: number } = {}) =>
  Bun.spawnSync(["setpriv", `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--", ...argv], { stdout: "pipe", stderr: "pipe", timeout: opts.timeout });

/**
 * Runs `run` with ctx.sys wrapped so that `move` (something the branch does)
 * runs just before each of root's HostSystem calls that `when` picks (its
 * method name and its 1-based place among the calls `run` makes). Root's
 * calls are synchronous, so the move lands exactly between two of them: a
 * window the branch could only hope to hit by racing, hit every time.
 * Returns how many calls `run` made and how often `move` ran.
 */
async function withMoveBefore(when: (method: string, call: number) => boolean, move: () => void, run: () => Promise<unknown>): Promise<{ calls: number; moves: number }> {
  const real = ctx.sys;
  let calls = 0;
  let moves = 0;
  const hooked = new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (when(String(prop), ++calls)) {
          moves++;
          move();
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  (ctx as { sys: HostSystem }).sys = hooked;
  try {
    await run();
  } finally {
    (ctx as { sys: HostSystem }).sys = real;
  }
  return { calls, moves };
}

/**
 * The removed root-side algorithm (commit 2f794ad), kept here only as the
 * regression guard's positive control: root pins data.db with O_NOFOLLOW,
 * checks from the fd that it is the branch's regular file, then makes the
 * HostSystem calls 2f794ad made before opening it (the database's size, the
 * free space, the temp and the database's entries, through ctx.sys, so
 * withMoveBefore can put the branch's move between any two of them), and
 * hands SQLite `/proc/self/fd/N` to VACUUM INTO `out`. SQLite's unix VFS
 * readlinks that path and reopens the database BY the name it reads, which
 * this returns.
 */
async function oldSnapshotByName(branch: BranchRow, out: string): Promise<string> {
  const data = ctx.layout.branch(branch.id).data;
  rmSync(out, { force: true });
  const fd = openSync(join(data, "data.db"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== branch.os_uid) throw new Error("not the branch's own database");
    databaseBytes(ctx, data);
    ctx.sys.freeBytes(dirname(out));
    if (ctx.sys.lstat(out)) ctx.sys.remove(out);
    for (const name of DB_FILES) ctx.sys.lstat(join(data, name));
    const opened = readlinkSync(`/proc/self/fd/${fd}`);
    const db = new Database(`/proc/self/fd/${fd}`, { readonly: true });
    try {
      db.run("PRAGMA trusted_schema = OFF");
      db.run(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    return opened;
  } finally {
    closeSync(fd);
  }
}

const sha256Of = (path: string) => sha256Hex(readFileSync(path));
/** Bytes the file system allocated for `path` (st_blocks are 512-byte units). */
const allocated = (path: string) => statSync(path).blocks * 512;

/** Closes the branch's live connections and empties its data dir, so a test starts from a clean database. */
function wipeData(branch: BranchRow) {
  for (const db of live.splice(0)) try { db.close(); } catch {}
  const data = ctx.layout.branch(branch.id).data;
  for (const name of readdirSync(data)) rmSync(join(data, name), { force: true, recursive: true });
}

/** Runs `js` (CommonJS, `fs` and `path` in scope) as the branch uid; it must exit 0. */
function asBranchJs(uid: number, js: string) {
  const r = asBranch(uid, [process.execPath, "-e", `const fs=require("fs"),path=require("path");${js}`]);
  if (r.exitCode !== 0) throw new Error(`as the branch: ${r.stderr.toString()}`);
}

/** A database with long runs of zeros, written as the branch at `path`: 64 KiB pages whose zeroblob overflow is all zeros after each 4-byte next-page number. */
function zeroRunDatabase(uid: number, path: string, journalMode: "DELETE" | "WAL") {
  const q = JSON.stringify;
  asBranchJs(
    uid,
    `const {Database}=require("bun:sqlite");const db=new Database(${q(path)},{create:true});db.run("PRAGMA page_size = 65536");db.run("PRAGMA journal_mode = ${journalMode}");` +
      `db.run("CREATE TABLE t (v BLOB)");for(let i=0;i<4;i++)db.run("INSERT INTO t VALUES (zeroblob(4194304))");db.run("INSERT INTO t VALUES ('branchdata')");` +
      `${journalMode === "WAL" ? 'db.run("PRAGMA wal_checkpoint(TRUNCATE)");' : ""}db.close();`,
  );
}

/** Whether a snapshot file leaks any secret the branch must not reach. */
function leaks(path: string): boolean {
  const bytes = readFileSync(path);
  if (bytes.includes(MARKER) || bytes.includes(MARKER2)) return true;
  // The control registry's admin keys, and a line of /etc/shadow.
  if (bytes.includes("ik_admin_")) return true;
  const shadow = readFileSync(SROOT, "utf8").split("\n").find((l) => l.startsWith("root:"))?.split(":")[1] ?? "";
  return shadow.length > 8 && bytes.includes(shadow);
}

/** A successful snapshot must be the branch's own database: table t with branchdata, never the registry's env/branches. */
function isBranchOwn(path: string): boolean {
  try {
    const db = new Database(path, { readonly: true });
    try {
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
      if (tables.includes("env") || tables.includes("branches")) return false;
      const row = db.query("SELECT v FROM t WHERE v = 'branchdata' LIMIT 1").get() as { v: string } | null;
      return row?.v === "branchdata";
    } finally {
      db.close();
    }
  } catch {
    return false; // a torn copy that will not open is not a leak, but not a real snapshot either
  }
}

describe.skipIf(!enabled)("privilege-separated snapshots defeat a branch racing root", () => {
  beforeAll(async () => {
    if (ROOT === DEFAULT_ROOT) throw new Error(`Refusing to test on ${DEFAULT_ROOT}`);
    if (!BINARY || !existsSync(BINARY)) throw new Error("INCIBASE_TEST_BINARY must point at a standalone incibase");
    if (existsSync(ROOT)) cleanup();
    ctx = openHost({ root: ROOT, layout: LAYOUT });
    ctx.actor = "root:test";
    await ops.initHost(ctx, { domain: "incibase.example.net", timezone: "UTC", uidBase: UID_BASE, sliceMemoryMax: 2 * 1024 ** 3, checkTimer: false });
    await ops.installRuntime(ctx, { binary: BINARY, version: VERSION, sha256: new Bun.CryptoHasher("sha256").update(readFileSync(BINARY)).digest("hex") });
    await ops.createProject(ctx, { slug: "shop", branches: ["prod"] });
    await ops.createBranch(ctx, { project: "shop", name: "victim", kind: "dev" });
    prod = ctx.registry.findBranch("shop", "prod")!;
    other = ctx.registry.findBranch("shop", "victim")!;
    // The control registry holds every branch's INCIBASE_ADMIN_KEY and now a unique marker; checkpoint it into the main file.
    await ctx.registry.withLock(() => ctx.registry.setEnv(prod.id, "SECRET_MARKER", MARKER, false));
    ctx.registry.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(ctx.layout.registry).includes(MARKER)).toBe(true);
    seed(other, MARKER2); // another branch's database, full of the other marker
    seed(prod, "branchdata"); // the victim-of-the-attacker's own data, no marker
    // The deploy flow makes backups/<id> before it snapshots; here the tests call snapshotDatabase directly.
    for (const b of [prod, other]) if (!sys.lstat(ctx.layout.branch(b.id).backups)) sys.mkdir(ctx.layout.branch(b.id).backups, 0o700);
    writeFileSync(RACER, RACER_SOURCE, { mode: 0o755 });
  }, SLOW);

  afterAll(() => {
    ctx?.registry.close();
    if (enabled) cleanup();
  });

  const stagingFile = () => ctx.layout.branch(prod.id).snapshotFile;
  const dataDb = () => join(ctx.layout.branch(prod.id).data, "data.db");

  test("ingestFile refuses every hostile branch file and leaks no secret", async () => {
    const staging = stagingFile();
    const dest = join(ROOT, "take-in.db");
    const maxBytes = 64 * 1024 * 1024;
    const owner = { uid: 0, gid: 0, mode: 0o600 };
    const take = () => sys.ingestFile(staging, dest, { uid: prod.os_uid, maxBytes, owner, check: () => null });
    const plantAsBranch = (make: string) => {
      rmSync(staging, { force: true });
      const r = asBranch(prod.os_uid, [process.execPath, "-e", `const fs=require("fs");${make}`]);
      expect(r.exitCode ?? r.signalCode).toBe(0);
    };
    const q = JSON.stringify;

    for (const [name, target] of [
      ["the control registry", ctx.layout.registry],
      ["/etc/shadow", SROOT],
      ["another branch's database", join(ctx.layout.branch(other.id).data, "data.db")],
    ] as const) {
      plantAsBranch(`fs.symlinkSync(${q(target)}, ${q(staging)})`);
      rmSync(dest, { force: true });
      expect(() => take()).toThrow(IngestError);
      expect(existsSync(dest)).toBe(false);
      // Root unlinked only the symlink it was handed, never what it pointed at.
      expect(readFileSync(target).length).toBeGreaterThan(0);
    }

    // A FIFO: O_NONBLOCK means root never blocks on it, fstat says not a regular file.
    plantAsBranch(`require("child_process").execFileSync("mkfifo", [${q(staging)}])`);
    const started = performance.now();
    expect(() => take()).toThrow(/is a FIFO; refusing to read it/);
    expect(performance.now() - started).toBeLessThan(5000);

    // A second hard link (protected_hardlinks permitting the branch to make it at all).
    plantAsBranch(`fs.writeFileSync(${q(staging)}, "x".repeat(100)); fs.linkSync(${q(staging)}, ${q(staging + ".hardlink")})`);
    if (statSync(staging).nlink > 1) expect(() => take()).toThrow(/has 2 links/);
    asBranch(prod.os_uid, [process.execPath, "-e", `require("fs").rmSync(${q(staging + ".hardlink")},{force:true})`]);

    // A huge sparse file: refused from its size before a byte is copied.
    plantAsBranch(`const fd=fs.openSync(${q(staging)},"w");fs.ftruncateSync(fd,2**40);fs.closeSync(fd)`);
    const started2 = performance.now();
    expect(() => take()).toThrow(/more than the \d+ allowed/);
    expect(performance.now() - started2).toBeLessThan(5000);

    // A regular file owned by the branch but not an SQLite database of its size: the header check refuses it.
    plantAsBranch(`fs.writeFileSync(${q(staging)}, Buffer.alloc(8192, 0x41))`);
    expect(() => sys.ingestFile(staging, dest, { uid: prod.os_uid, maxBytes, owner, check: (head) => (Buffer.from(head).subarray(0, 16).toString("latin1") === "SQLite format 3\\0" ? null : "not an SQLite database") })).toThrow(
      /not an SQLite database/,
    );
    expect(existsSync(dest)).toBe(false);
    rmSync(staging, { force: true });
    rmSync(dest, { force: true });
  }, SLOW);

  test("the by-fd copy keeps holes: a sparse staging file costs no disk, a database of zeros comes back byte for byte", async () => {
    const staging = stagingFile();
    const owner = { uid: 0, gid: 0, mode: 0o600 };
    const q = JSON.stringify;
    const MiB = 1024 * 1024;
    // As the branch: a 200 MiB staging file that is all holes, under a 1 GiB cap. Root reads its 200 MiB of
    // zeros and writes none of them: the copy is as sparse as the branch's file.
    rmSync(staging, { force: true });
    asBranchJs(prod.os_uid, `const fd=fs.openSync(${q(staging)},"w");fs.ftruncateSync(fd,200*1024*1024);fs.closeSync(fd)`);
    expect(statSync(staging).size).toBe(200 * MiB);
    expect(statSync(staging).blocks).toBe(0); // this file system keeps holes
    const dest = join(ROOT, "sparse-take-in.db");
    rmSync(dest, { force: true });
    const freeBefore = sys.freeBytes(ROOT);
    expect(sys.ingestFile(staging, dest, { uid: prod.os_uid, maxBytes: 1024 * MiB, owner, check: () => null })).toBe(200 * MiB);
    expect(statSync(dest).size).toBe(200 * MiB);
    expect(allocated(dest)).toBeLessThan(MiB);
    expect(sys.freeBytes(ROOT)).toBeGreaterThan(freeBefore - 50 * MiB); // slack for other activity on the box
    rmSync(dest, { force: true });
    rmSync(staging, { force: true });

    // A real database with long runs of zeros, left by the branch as its staging file: ingestFile, then
    // copyFile (the preflight copy and restore), give back the same bytes, and its zeros stay holes.
    zeroRunDatabase(prod.os_uid, staging, "DELETE");
    const staged = sha256Of(staging);
    const size = statSync(staging).size;
    expect(size).toBeGreaterThan(16 * MiB);
    sys.ingestFile(staging, dest, { uid: prod.os_uid, maxBytes: 1024 * MiB, owner, check: () => null });
    expect(sha256Of(dest)).toBe(staged);
    expect(allocated(dest) * 4).toBeLessThan(size);
    const copy = join(ROOT, "sparse-copy.db");
    sys.copyFile(dest, copy, owner);
    expect(sha256Of(copy)).toBe(staged);
    expect(allocated(copy) * 4).toBeLessThan(size);
    for (const p of [dest, copy, staging]) rmSync(p, { force: true });

    // The whole flow on such a database as the branch's live one (WAL): the unit copies it, root keeps the holes.
    wipeData(prod);
    zeroRunDatabase(prod.os_uid, dataDb(), "WAL");
    const snapshot = join(ctx.layout.branch(prod.id).backups, "pre-zeros.db");
    await snapshotDatabase(ctx, prod, snapshot, owner);
    expect(allocated(snapshot) * 4).toBeLessThan(statSync(snapshot).size);
    expect(isBranchOwn(snapshot)).toBe(true);
    const check = new Database(snapshot, { readonly: true });
    expect(check.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect((check.query("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(5);
    check.close();
    rmSync(snapshot, { force: true });
    wipeData(prod);
    seed(prod, "branchdata");
  }, SLOW);

  test("inflating data.db lifts the INCIBASE_MAX_DB_BYTES cap to at most twice the limit; a database over a lowered limit still snapshots", async () => {
    const MiB = 1024 * 1024;
    const q = JSON.stringify;
    const owner = { uid: 0, gid: 0, mode: 0o600 };
    const limited = (maxDbBytes: number) => ({ ...prod, limits_json: JSON.stringify({ ...JSON.parse(prod.limits_json), maxDbBytes }) });
    const dest = join(ctx.layout.branch(prod.id).backups, "pre-cap.db");
    const temps = () => readdirSync(ctx.layout.backups).filter((n) => n.startsWith(".snap-"));
    wipeData(prod);
    seed(prod, "branchdata");
    for (const db of live.splice(0)) db.close();
    // As the branch: data.db made to look 2 GiB (a sparse file costs it nothing), and a dense 64 MiB file with
    // a valid header left as the staging file just before root takes it in, as a branch winning the race
    // between the unit's exit and the ingest would. The move is injected there, so nothing is left to timing.
    asBranchJs(prod.os_uid, `fs.truncateSync(${q(dataDb())}, 2 * 1024 ** 3)`);
    expect(statSync(dataDb()).size).toBe(2 * 1024 * MiB);
    const swapDense = () =>
      asBranchJs(
        prod.os_uid,
        `const size=64*1024*1024,h=Buffer.alloc(100);h.write("SQLite format 3\\0",0,"latin1");h.writeUInt16BE(4096,16);h.writeUInt32BE(1,24);h.writeUInt32BE(size/4096,28);h.writeUInt32BE(1,92);` +
          `fs.rmSync(${q(stagingFile())},{force:true});fs.writeFileSync(${q(stagingFile())},Buffer.concat([h,Buffer.alloc(size-100,0x41)]))`,
      );
    const beforeIngest = (method: string) => method === "ingestFile";
    let swapped = 0;
    await expect(
      withMoveBefore(beforeIngest, () => (swapDense(), swapped++), () => snapshotDatabase(ctx, limited(8 * MiB), dest, owner)),
    ).rejects.toThrow(/is 67108864 bytes, more than the 16777216 allowed; refusing to copy it \(its INCIBASE_MAX_DB_BYTES is 8388608;/);
    expect(swapped).toBe(1);
    expect(existsSync(dest)).toBe(false);
    expect(temps()).toEqual([]);
    expect(readdirSync(ctx.layout.branch(prod.id).snapshot)).toEqual([]);
    // The same database, honestly snapshotted: the unit's own copy is small and goes through.
    await snapshotDatabase(ctx, limited(8 * MiB), dest, owner);
    expect(isBranchOwn(dest)).toBe(true);
    rmSync(dest, { force: true });

    // A database really over a limit lowered under it (12 MiB of rows, an 8 MiB limit): its own size is allowed.
    wipeData(prod);
    asBranchJs(
      prod.os_uid,
      `const {Database}=require("bun:sqlite");const db=new Database(${q(dataDb())},{create:true});db.run("CREATE TABLE t (v BLOB)");db.run("INSERT INTO t VALUES ('branchdata')");` +
        `for(let i=0;i<12;i++)db.run("INSERT INTO t VALUES (randomblob(1048576))");db.close();`,
    );
    await snapshotDatabase(ctx, limited(8 * MiB), dest, owner);
    expect(statSync(dest).size).toBeGreaterThan(12 * MiB);
    expect(isBranchOwn(dest)).toBe(true);
    rmSync(dest, { force: true });
    // More than twice over its limit (4 MiB): refused, naming the limit.
    await expect(snapshotDatabase(ctx, limited(4 * MiB), dest, owner)).rejects.toThrow(/more than the 8388608 allowed; refusing to copy it \(its INCIBASE_MAX_DB_BYTES is 4194304;/);
    expect(existsSync(dest)).toBe(false);
    expect(temps()).toEqual([]);
    wipeData(prod);
    seed(prod, "branchdata");
  }, SLOW);

  test("the snapshot unit runs as the branch: a redirected data.db, -wal or -shm gains nothing", async () => {
    const data = ctx.layout.branch(prod.id).data;
    const dest = join(ctx.layout.branch(prod.id).backups, "pre-probe.db");
    const q = JSON.stringify;
    const plant = (make: string) => {
      const r = asBranch(prod.os_uid, [process.execPath, "-e", `const fs=require("fs");${make}`]);
      expect(r.exitCode ?? r.signalCode).toBe(0);
    };
    // data.db -> the control registry: the unit, as the branch, cannot read the registry.
    plant(`fs.renameSync(${q(join(data, "data.db"))}, ${q(join(data, "data.db.real"))});fs.symlinkSync(${q(ctx.layout.registry)}, ${q(join(data, "data.db"))})`);
    await expect(snapshotDatabase(ctx, prod, dest, { uid: 0, gid: 0, mode: 0o600 })).rejects.toThrow(SnapshotError);
    expect(existsSync(dest)).toBe(false);
    plant(`fs.rmSync(${q(join(data, "data.db"))});fs.renameSync(${q(join(data, "data.db.real"))}, ${q(join(data, "data.db"))})`);

    // -wal and -shm -> the registry's: the unit copies the branch's own data.db; the registry is never reachable.
    plant(`for (const [n,t] of [["data.db-wal",${q(ctx.layout.registry + "-wal")}],["data.db-shm",${q(ctx.layout.registry + "-shm")}]]) { fs.rmSync(require("path").join(${q(data)},n),{force:true}); fs.symlinkSync(t, require("path").join(${q(data)},n)); }`);
    try {
      await snapshotDatabase(ctx, prod, dest, { uid: 0, gid: 0, mode: 0o600 });
      // If it produced a file it must be the branch's own, with no secret.
      expect(leaks(dest)).toBe(false);
      expect(isBranchOwn(dest)).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotError); // a refusal is also fine
    }
    rmSync(dest, { force: true });
    // Put the branch's own files back for the race and the positive control.
    plant(`for (const n of ["data.db-wal","data.db-shm"]) { const p=require("path").join(${q(data)},n); if (fs.lstatSync(p,{throwIfNoEntry:false})?.isSymbolicLink()) fs.rmSync(p); }`);
    live.find(Boolean)?.run("INSERT INTO t VALUES ('branchdata')");
  }, SLOW);

  test("a branch racing root never leaks a secret, and root never hangs", async () => {
    const child = Bun.spawn(["setpriv", `--reuid=${prod.os_uid}`, `--regid=${prod.os_uid}`, "--clear-groups", "--", process.execPath, RACER, dataDb(), stagingFile(), ctx.layout.registry, join(ctx.layout.branch(other.id).data, "data.db"), SROOT, "9"], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(300);
    const dest = join(ROOT, "race-snap.db");
    let ok = 0;
    let refused = 0;
    let leaked = 0;
    let foreign = 0;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      rmSync(dest, { force: true });
      const started = performance.now();
      try {
        await snapshotDatabase(ctx, prod, dest, { uid: 0, gid: 0, mode: 0o600 });
      } catch (err) {
        if (err instanceof SnapshotError) {
          refused++;
          continue;
        }
        throw err;
      } finally {
        // No single snapshot may hang: the unit has RuntimeMaxSec and the ingest is non-blocking.
        expect(performance.now() - started).toBeLessThan(60_000);
      }
      ok++;
      if (leaks(dest)) leaked++;
      else if (!isBranchOwn(dest)) foreign++;
    }
    child.kill("SIGKILL");
    await child.exited;
    rmSync(dest, { force: true });
    // Only what holds however the race goes: no snapshot ever held a secret or was a foreign database (and,
    // above, none hung). How many were taken or refused is the race's business: a branch that clobbers its own
    // staging file forever only denies itself a snapshot. Real snapshots under no contention are the next test's.
    console.log(`[race] ${ok} ok, ${refused} refused, ${leaked} leaked, ${foreign} foreign`);
    expect({ leaked, foreign }).toEqual({ leaked: 0, foreign: 0 });
  }, SLOW);

  test("a real snapshot is produced and rollback --restore brings it back", async () => {
    // The attacker left data/ in some chaotic state (a dangling symlink, a half-renamed file); start the
    // branch's own database again from clean, as serve would, so this is a straight functional check.
    const data = ctx.layout.branch(prod.id).data;
    for (const db of live.splice(0)) try { db.close(); } catch {}
    for (const name of readdirSync(data)) rmSync(join(data, name), { force: true, recursive: true });
    seed(prod, "branchdata");
    const snapshot = ctx.layout.snapshot(prod.id, "pre-1");
    await snapshotDatabase(ctx, prod, snapshot, { uid: 0, gid: 0, mode: 0o600 });
    expect(statSync(snapshot)).toMatchObject({ uid: 0 });
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
    expect(leaks(snapshot)).toBe(false);
    expect(isBranchOwn(snapshot)).toBe(true);
    const copy = new Database(snapshot, { readonly: true });
    const rows = (copy.query("SELECT count(*) AS n FROM t").get() as { n: number }).n;
    copy.close();
    expect(rows).toBeGreaterThanOrEqual(40);

    // Stop the branch's connections so a restore can swap the file, then restore and check the rows.
    for (const db of live.splice(0)) db.close();
    const kept = restoreDatabase(ctx, prod, snapshot, Date.now());
    expect(kept).not.toBeNull();
    const restored = join(data, "data.db");
    expect(statSync(restored)).toMatchObject({ uid: prod.os_uid });
    expect(readdirSync(data)).toEqual(["data.db"]);
    const after = new Database(restored, { readonly: true });
    expect((after.query("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(rows);
    after.close();
  }, SLOW);

  test("the removed root-side read leaks the registry through `data.db (deleted)` wherever the branch moves; snapshotDatabase never does", async () => {
    const data = ctx.layout.branch(prod.id).data;
    const planted = `${dataDb()} (deleted)`;
    const keep = join(data, "keep.db");
    const q = JSON.stringify;
    const owner = { uid: 0, gid: 0, mode: 0o600 };
    wipeData(prod);
    seed(prod, "branchdata");
    for (const db of live.splice(0)) db.close(); // a checkpointed, closed database: data.db is all there is
    asBranchJs(prod.os_uid, `fs.copyFileSync(${q(dataDb())}, ${q(keep)})`);
    // The secret is in the registry's main file.
    ctx.registry.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(ctx.layout.registry).includes(MARKER)).toBe(true);
    // The branch's move: unlink data.db (an fd root pinned on it now reads back as "<path> (deleted)"), plant that
    // very name as a symlink to the registry, and put its own database back as data.db.
    const move = () =>
      asBranchJs(prod.os_uid, `fs.unlinkSync(${q(dataDb())});fs.symlinkSync(${q(ctx.layout.registry)}, ${q(planted)});fs.copyFileSync(${q(keep)}, ${q(dataDb())})`);
    const restore = () => {
      for (const name of readdirSync(data)) if (name.startsWith("data.db")) rmSync(join(data, name), { force: true }); // the plant, and what SQLite made next to it
      asBranchJs(prod.os_uid, `fs.copyFileSync(${q(keep)}, ${q(dataDb())})`);
    };
    /** What root (this process) holds open in the branch's data dir right now, by /proc/self/fd. */
    const heldInData = (into: Set<string>) => {
      for (const fd of readdirSync("/proc/self/fd")) {
        let target: string;
        try {
          target = readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          continue; // the fd readdir itself used, closed since
        }
        if (target.startsWith(`${data}/`)) into.add(target);
      }
      return false;
    };
    /**
     * Runs `take` twice with no move: a warm-up (so a drop-in written once is not counted), then to count root's
     * HostSystem calls, noting what root holds open in data/ at each. Then once with the branch's move before
     * each of those calls in turn, judging each. Nothing here is a race: the move runs between two of root's
     * calls, at a place fixed in advance.
     */
    const sweep = async (take: () => Promise<unknown>, judge: (at: number) => void): Promise<{ calls: number; held: string[] }> => {
      await withMoveBefore(() => false, move, take);
      restore();
      const held = new Set<string>();
      const { calls } = await withMoveBefore(() => heldInData(held), move, take);
      restore();
      expect(calls).toBeGreaterThan(0);
      for (let at = 1; at <= calls; at++) {
        expect(await withMoveBefore((_, call) => call === at, move, take)).toEqual({ calls, moves: 1 });
        judge(at);
        restore();
      }
      return { calls, held: [...held] };
    };

    // The old algorithm: every one of its HostSystem calls falls between its pin and SQLite's open, and the move
    // before any of them makes it read the registry. It leaks the marker at every place.
    const out = join(ROOT, "old-by-name.db");
    let opened = "";
    const leakedAt: number[] = [];
    const { calls: oldCalls, held: oldHeld } = await sweep(
      async () => (opened = await oldSnapshotByName(prod, out)),
      (at) => {
        expect(opened).toBe(planted);
        if (leaks(out)) leakedAt.push(at);
      },
    );
    rmSync(out, { force: true });
    console.log(`[old by-name read] leaked the registry with the move before ${leakedAt.length} of its ${oldCalls} HostSystem calls; held open in data/: ${oldHeld.join(", ")}`);
    expect(oldCalls).toBeGreaterThanOrEqual(5);
    expect(leakedAt.length).toBe(oldCalls);
    expect(oldHeld).toEqual([dataDb()]); // its pin, across every one of those calls

    // snapshotDatabase, the same move before each of its HostSystem calls: always the branch's own data, no secret.
    const dest = join(ctx.layout.branch(prod.id).backups, "pre-deleted.db");
    const outcomes: string[] = [];
    const { calls: newCalls, held: newHeld } = await sweep(
      async () => {
        rmSync(dest, { force: true });
        await snapshotDatabase(ctx, prod, dest, owner);
      },
      (at) => outcomes.push(leaks(dest) ? `leaked at ${at}` : isBranchOwn(dest) ? "own" : `foreign at ${at}`),
    );
    console.log(`[deleted] snapshotDatabase with the move before each of its ${newCalls} HostSystem calls: ${outcomes.filter((o) => o === "own").length} own`);
    expect(outcomes).toEqual(Array(newCalls).fill("own"));
    expect(newHeld).toEqual([]); // root never holds anything open in the branch's data dir
    rmSync(dest, { force: true });
    rmSync(keep, { force: true });
    wipeData(prod);
    seed(prod, "branchdata");
  }, SLOW);

  test("the snapshot unit runs the newer of this host's runtime and the branch's pin (one without _snapshot never)", async () => {
    // A stub runtime that answers --version but exits 78 on any command, like one that has no _snapshot. A branch
    // pinned to it snapshots with this host's runtime, the newer of the two.
    const stub = join(ROOT, "stub-runtime");
    writeFileSync(stub, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.0.1; exit 0; fi\necho "unknown command $1" >&2\nexit 78\n`, { mode: 0o755 });
    const sha = new Bun.CryptoHasher("sha256").update(readFileSync(stub)).digest("hex");
    await ops.installRuntime(ctx, { binary: stub, version: "0.0.1", sha256: sha });
    expect(Bun.spawnSync([ctx.layout.runtimeBinary("0.0.1"), "_snapshot", "--data", "/x", "--out", "/y"]).exitCode).toBe(78);

    await ops.createBranch(ctx, { project: "shop", name: "legacy", kind: "dev", runtimeVersion: "0.0.1" });
    const legacy = ctx.registry.findBranch("shop", "legacy")!;
    expect(legacy.runtime_version).toBe("0.0.1");
    if (!sys.lstat(ctx.layout.branch(legacy.id).backups)) sys.mkdir(ctx.layout.branch(legacy.id).backups, 0o700);
    seed(legacy, "branchdata");
    const snapshot = ctx.layout.snapshot(legacy.id, "pre-1");
    await snapshotDatabase(ctx, legacy, snapshot, { uid: 0, gid: 0, mode: 0o600 });
    const dropIn = readFileSync(ctx.layout.dropIn(ctx.layout.units.snapshot(legacy.id)), "utf8");
    expect(dropIn).toContain(`ExecStart=${ctx.layout.runtimeBinary(VERSION)} _snapshot `);
    expect(dropIn).not.toContain("/0.0.1/");
    expect(statSync(snapshot)).toMatchObject({ uid: 0 });
    expect(isBranchOwn(snapshot)).toBe(true);
    for (const db of live.splice(0)) try { db.close(); } catch {}
  }, SLOW);

  test("a snapshot unit SIGKILLed while the job lives on leaves its staging dir empty", async () => {
    const owner = { uid: 0, gid: 0, mode: 0o600 };
    const killUnit = (unit: string) => Bun.spawnSync(["systemctl", "kill", "--signal=SIGKILL", unit]).exitCode;
    // Deterministic: a 99.0.0 runtime whose _snapshot leaves what a VACUUM INTO killed halfway leaves (a partial
    // snapshot.db.tmp, here the first MiB of the branch's database, and its -journal), says so in `ready`, and
    // waits. A branch pinned to 99.0.0 gets it as the newer runtime; the job is this test, and it lives on.
    const wrapper = join(ROOT, "wrapper-runtime");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo 99.0.0; exit 0; fi',
        '[ "$1" = "_snapshot" ] && [ "$2" = "--data" ] && [ "$4" = "--out" ] || exit 64',
        'head -c 1048576 "$3/data.db" > "$5.tmp"',
        ': > "$5.tmp-journal"',
        ': > "$(dirname "$5")/ready"',
        "exec sleep 600",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await ops.installRuntime(ctx, { binary: wrapper, version: "99.0.0", sha256: new Bun.CryptoHasher("sha256").update(readFileSync(wrapper)).digest("hex") });
    await ops.createBranch(ctx, { project: "shop", name: "next", kind: "dev", runtimeVersion: "99.0.0" });
    const next = ctx.registry.findBranch("shop", "next")!;
    if (!sys.lstat(ctx.layout.branch(next.id).backups)) sys.mkdir(ctx.layout.branch(next.id).backups, 0o700);
    seed(next, "branchdata");
    const staging = ctx.layout.branch(next.id).snapshot;
    const unit = ctx.layout.units.snapshot(next.id);
    let seen: string[] = [];
    const killer = (async () => {
      for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(20)) {
        if (!existsSync(join(staging, "ready"))) continue;
        seen = readdirSync(staging).sort();
        expect(killUnit(unit)).toBe(0);
        return;
      }
      killUnit(unit); // let snapshotDatabase return before this test fails
      throw new Error("the wrapper never got ready");
    })();
    const snapshot = ctx.layout.snapshot(next.id, "pre-1");
    await expect(snapshotDatabase(ctx, next, snapshot, owner)).rejects.toThrow(/was killed by signal 9/);
    await killer;
    expect(readFileSync(ctx.layout.dropIn(unit), "utf8")).toContain(`ExecStart=${ctx.layout.runtimeBinary("99.0.0")} _snapshot `);
    expect(seen).toEqual(["ready", "snapshot.db.tmp", "snapshot.db.tmp-journal"]);
    expect(readdirSync(staging)).toEqual([]);
    expect(existsSync(snapshot)).toBe(false);
    expect(readdirSync(ctx.layout.backups).filter((n) => n.startsWith(".snap-"))).toEqual([]);

    // A real VACUUM INTO of a large database (this host's runtime), SIGKILLed once its snapshot.db.tmp holds
    // 8 MiB. Whether the kill lands mid-VACUUM or the copy wins, the staging dir ends up empty.
    wipeData(prod);
    const big = new Database(dataDb(), { create: true });
    big.run("PRAGMA journal_mode = WAL");
    big.run("CREATE TABLE t (v BLOB)");
    big.run("INSERT INTO t VALUES ('branchdata')");
    big.run("INSERT INTO t SELECT randomblob(4000) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 40000) SELECT x FROM c)");
    big.run("PRAGMA wal_checkpoint(TRUNCATE)");
    big.close();
    for (const name of readdirSync(ctx.layout.branch(prod.id).data)) chownSync(join(ctx.layout.branch(prod.id).data, name), prod.os_uid, prod.os_uid);
    const prodUnit = ctx.layout.units.snapshot(prod.id);
    let killedAt: number | null = null;
    let stop = false;
    const realKiller = (async () => {
      while (!stop) {
        const tmp = sys.lstat(`${stagingFile()}.tmp`);
        if (tmp && tmp.size >= 8 * 1024 * 1024) {
          killedAt = tmp.size;
          killUnit(prodUnit); // a unit that already finished has nothing left to kill; that is fine too
          return;
        }
        await Bun.sleep(1);
      }
    })();
    const dest = ctx.layout.snapshot(prod.id, "pre-77");
    const outcome = await snapshotDatabase(ctx, prod, dest, owner).then(
      () => "the copy finished first",
      (err: Error) => {
        expect(err).toBeInstanceOf(SnapshotError);
        return err.message.split("\n")[0]!;
      },
    );
    stop = true;
    await realKiller;
    console.log(`[killed unit] SIGKILL with snapshot.db.tmp at ${killedAt ?? "-"} bytes: ${outcome}`);
    expect(readdirSync(ctx.layout.branch(prod.id).snapshot)).toEqual([]);
    expect(readdirSync(ctx.layout.backups).filter((n) => n.startsWith(".snap-"))).toEqual([]);
    rmSync(dest, { force: true });
    wipeData(prod);
    seed(prod, "branchdata");
  }, SLOW);
});

// Run as the branch uid: flips data.db between its own database and a symlink to the registry or another branch,
// and flips the staging output between a real-ish file and a symlink to /etc/shadow, the registry or another branch,
// a FIFO and a huge sparse file. Every swap is something the branch is allowed to do; none may help root read more.
const RACER_SOURCE = `import { renameSync, symlinkSync, rmSync, writeFileSync, openSync, ftruncateSync, closeSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [dataDb, staging, registry, otherDb, shadow, secs] = process.argv.slice(2);
const end = Date.now() + Number(secs) * 1000;
const real = dataDb + ".real";
const targets = [registry, otherDb, shadow];
let n = 0;
while (Date.now() < end) {
  n++;
  // Flip data.db to a symlink and back.
  try { renameSync(dataDb, real); rmSync(dataDb, { force: true }); symlinkSync(targets[n % targets.length], dataDb); renameSync(real, dataDb); } catch {}
  // Flip the staging output through every hostile shape.
  try {
    rmSync(staging, { recursive: true, force: true });
    const pick = n % 5;
    if (pick === 0) symlinkSync(targets[n % targets.length], staging);
    else if (pick === 1) execFileSync("mkfifo", [staging]);
    else if (pick === 2) { const fd = openSync(staging, "w"); ftruncateSync(fd, 2 ** 40); closeSync(fd); }
    else if (pick === 3) writeFileSync(staging, "not a database".repeat(10));
    else mkdirSync(staging);
  } catch {}
}
`;
