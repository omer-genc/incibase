// Privilege-separated snapshots on a real Linux machine, as root (design
// section 3.2 D.3.1): root must never read a branch's database through
// SQLite or by a name the branch controls. The snapshot is produced by
// `incibase-snapshot@<id>`, which runs `incibase _snapshot` as the BRANCH in
// the branch's sandbox; root then takes the finished staging file in by fd
// (O_RDONLY|O_NOFOLLOW|O_NONBLOCK, fstat regular/owner/nlink/size, SQLite
// header), copies it by fd into a root-only temp and renames it into place.
//
// This suite is the attack side of that contract, run as the branch uid:
//   1. ingestFile (the one place root touches a branch file by name) refuses
//      every hostile file a branch can leave — a symlink to /etc/shadow, the
//      control registry or another branch's database, a FIFO, a file owned
//      by someone else, a second hard link, a huge sparse file, a non-SQLite
//      file — and leaks none of a unique secret marker. With a by-name open
//      (the old vulnerability) the symlink cases would leak; this is the
//      regression guard, and it does not need the VM.
//   2. The snapshot unit runs as the branch, so a data.db / -wal / -shm
//      swapped for a symlink to the registry or another branch gains
//      nothing: the unit cannot read what the branch cannot.
//   3. A branch process races root in a tight loop (flipping data.db and the
//      staging output through every variant above) while root snapshots in a
//      loop: zero leaks, bounded time (no hang), and real snapshots still
//      produced.
//   4. A real snapshot and `rollback --restore` still work end to end.
//
// Skipped unless INCIBASE_TEST_HOST=1 on Linux as root; needs
// INCIBASE_TEST_BINARY (a standalone incibase for this machine, for the
// branch's _snapshot). Host root /var/lib/incibase-snp, uid base 84000; it
// removes everything it made.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chownSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VERSION } from "../src/engine/version.ts";
import { openHost, type OpsContext } from "../src/host/context.ts";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { Registry, type BranchRow } from "../src/host/registry.ts";
import { restoreDatabase, snapshotDatabase, SnapshotError } from "../src/host/snapshot.ts";
import { IngestError, LinuxSystem } from "../src/host/system.ts";

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
      const row = db.query("SELECT v FROM t LIMIT 1").get() as { v: string } | null;
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
    // The race is lossless of safety: no snapshot ever held a secret, and no snapshot was a foreign database.
    // A branch that clobbers its own staging file forever only denies itself a snapshot (ok may be 0); it never
    // makes root read more. With a by-name ingest the staging-symlink variant would leak here. Real snapshots
    // under no contention are the next test's.
    expect({ leaked, foreign }).toEqual({ leaked: 0, foreign: 0 });
    expect(refused).toBeGreaterThan(0);
    expect(ok + refused).toBeGreaterThan(0);
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
