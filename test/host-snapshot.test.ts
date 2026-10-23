// Snapshot and restore orchestration (design section 3.2 D.3.1) on a fake
// host with real SQLite databases. Root never opens the branch's database:
// the snapshot unit (`incibase-snapshot@<id>`, here FakeDriver running the
// real `_snapshot` copy in-process) writes the branch's staging file, and
// root takes it in by fd into a root-only temp and renames it into place.
// These tests check which runtime the unit runs (the newer of the host's and
// the branch's pin) and how a failed unit is reported; hand root every kind
// of staging file a branch could leave instead (symlink, FIFO, foreign
// owner, hard link, a file larger than the cap, garbage) and check it is
// refused without a copy, a hang or a stray temp; check that the by-fd copy
// keeps holes (a sparse staging file costs root no disk) and gives back the
// same bytes; that inflating data.db lifts the INCIBASE_MAX_DB_BYTES cap to
// at most twice the limit while a database really over a lowered limit
// still snapshots; that a unit that fails or is killed leaves its staging dir
// empty; that the preflight copy and a restore are made in backups/ and
// renamed in; and that a restore never opens the entries it moves aside. The
// race against a real branch uid runs in test/host-snapshot-linux.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../src/engine/manifest.ts";
import { VERSION } from "../src/engine/version.ts";
import { SnapshotCommandError, SNAPSHOT_EXIT, takeSnapshot } from "../src/host/snapshot-command.ts";
import * as ops from "../src/host/ops.ts";
import type { FakeRun } from "../src/host/fake-driver.ts";
import type { BranchRow } from "../src/host/registry.ts";
import { hostRuntime } from "../src/host/render.ts";
import { cleanupSnapshot, placeCopy, restoreDatabase, snapshotDatabase, SnapshotError, sqliteHeaderProblem } from "../src/host/snapshot.ts";
import { ingestByFd } from "../src/host/system.ts";
import { closeOpsHosts, fakeOpsHost, seedDatabase, type OpsTestHost } from "./host-helpers.ts";

afterEach(closeOpsHosts);

const ROOT_FILE = { uid: 0, gid: 0, mode: 0o600 };

async function prodBranch(): Promise<{ host: OpsTestHost; branch: BranchRow }> {
  const host = await fakeOpsHost();
  await ops.createProject(host, { slug: "shop", branches: ["prod"] });
  const branch = host.registry.findBranch("shop", "prod")!;
  host.sys.mkdir(host.layout.branch(branch.id).backups, 0o700);
  return { host, branch };
}

const count = (path: string) => (new Database(path, { readonly: true }).query("SELECT count(*) AS n FROM docs").get() as { n: number }).n;
/** Temps root left in backups/ (there should never be any). */
const strayTemps = (host: OpsTestHost) => readdirSync(host.layout.backups).filter((n) => n.startsWith(".snap-") || n.endsWith(".tmp"));

/** Installs runtime `version` on the fake host: a root 0755 script that only says its version. */
async function withRuntime(host: OpsTestHost, version: string) {
  const binary = join(host.dir, `incibase-${version}`);
  writeFileSync(binary, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  await ops.installRuntime(host, { binary, version, sha256: sha256Hex(readFileSync(binary)) });
}

/** A dev branch of shop pinned to `version` (installed first), with its backups/ made. */
async function pinnedBranch(host: OpsTestHost, name: string, version: string): Promise<BranchRow> {
  await withRuntime(host, version);
  await ops.createBranch(host, { project: "shop", name, kind: "dev", runtimeVersion: version });
  const branch = host.registry.findBranch("shop", name)!;
  host.sys.mkdir(host.layout.branch(branch.id).backups, 0o700);
  return branch;
}

/** An SQLite header for `size` bytes of 4096-byte pages, as VACUUM INTO writes one; the rest of the file is up to the caller. */
function sqliteHeader(size: number): Buffer {
  const head = Buffer.alloc(100);
  head.write("SQLite format 3\0", 0, "latin1");
  head.writeUInt16BE(4096, 16);
  head.writeUInt32BE(1, 24); // change counter ...
  head.writeUInt32BE(size / 4096, 28); // ... the page count ...
  head.writeUInt32BE(1, 92); // ... valid for it
  return head;
}

/** Bytes the file system allocated for `path` (st_blocks are 512-byte units). */
const allocated = (path: string) => statSync(path).blocks * 512;
const sha256Of = (path: string) => sha256Hex(readFileSync(path));

/** Makes the fake snapshot unit leave `make(path)` as its staging file instead of a real copy, and exit 0. */
function stagingIs(host: OpsTestHost, make: (path: string, branch: BranchRow) => void) {
  host.driver.snapshot = (run) => {
    const branch = host.registry.getBranch(run.id!)!;
    const path = host.layout.branch(branch.id).snapshotFile;
    rmSync(path, { recursive: true, force: true });
    make(path, branch);
    return 0;
  };
}

describe("snapshotDatabase: the snapshot unit copies as the branch, root takes the file in by fd", () => {
  test("copies the branch's own database, uncheckpointed WAL rows included", async () => {
    const { host } = await prodBranch();
    // Pinned to a runtime newer than this host's own: the unit runs the pin's _snapshot (the newer of the two).
    const branch = await pinnedBranch(host, "next", "99.0.0");
    const path = seedDatabase(host, branch, 4);
    // The branch keeps a connection open with rows only in its WAL.
    const live = new Database(path);
    live.run("PRAGMA wal_autocheckpoint = 0");
    live.run("INSERT INTO docs (body) VALUES ('in the wal')");
    const dest = host.layout.snapshot(branch.id, "pre-1");
    const calls = host.driver.calls.length;
    const runs: FakeRun[] = [];
    host.driver.snapshot = (run) => (runs.push(run), host.driver.copySnapshot(run));
    await snapshotDatabase(host, branch, dest, ROOT_FILE);
    live.close();
    expect(host.sys.lstat(dest)).toMatchObject({ type: "file", uid: 0, gid: 0, mode: 0o600 });
    expect(count(dest)).toBe(5);
    // The copy ran in the branch's snapshot unit, as the branch, with the 99.0.0 runtime's _snapshot.
    const unit = host.layout.units.snapshot(branch.id);
    expect(host.driver.calls.slice(calls)).toContain(`start ${unit}`);
    expect(runs.map((r) => [r.user, r.runtime])).toEqual([[`ib-${branch.id}`, "99.0.0"]]);
    const dropIn = readFileSync(host.layout.dropIn(unit), "utf8");
    expect(dropIn).toContain(`User=ib-${branch.id}\n`);
    expect(dropIn).toContain(
      `ExecStart=${host.layout.runtimeBinary("99.0.0")} _snapshot --data ${host.layout.branch(branch.id).data} --out ${host.layout.branch(branch.id).snapshotFile}\n`,
    );
    // The staging file is gone, and root left no temp behind.
    expect(readdirSync(host.layout.branch(branch.id).snapshot)).toEqual([]);
    expect(strayTemps(host)).toEqual([]);
  });

  test("runs the newer of the host's runtime and the branch's pin, never one root cannot trust", async () => {
    const { host } = await prodBranch();
    expect(VERSION).not.toBe("0.0.1");
    // Pinned to a runtime older than this host's (say, from before _snapshot existed): the host's own runs it.
    const old = await pinnedBranch(host, "old", "0.0.1");
    seedDatabase(host, old, 2);
    const runs: FakeRun[] = [];
    host.driver.snapshot = (run) => (runs.push(run), host.driver.copySnapshot(run));
    await snapshotDatabase(host, old, host.layout.snapshot(old.id, "pre-1"), ROOT_FILE);
    expect(runs.map((r) => r.runtime)).toEqual([VERSION]);
    expect(readFileSync(host.layout.dropIn(host.layout.units.snapshot(old.id)), "utf8")).toContain(`ExecStart=${host.layout.runtimeBinary(VERSION)} _snapshot `);
    // A newer runtime nobody pins is never picked: only this host's and the branch's own count.
    await withRuntime(host, "98.0.0");
    expect(hostRuntime(host, old.runtime_version)?.version).toBe(VERSION);
    expect(hostRuntime(host, "98.0.0")?.version).toBe("98.0.0");
    // A binary or its version dir that someone else can write or own, or a symlink, is never run; nothing in a
    // runtime root someone else can write is.
    const binary = host.layout.runtimeBinary("98.0.0");
    for (const [path, uid, mode, expected] of [
      [binary, 0, 0o775, VERSION],
      [binary, 1000, 0o755, VERSION],
      [binary, 0, 0o750, VERSION], // not executable by the branch
      [host.layout.runtimeDir("98.0.0"), 0, 0o777, VERSION],
      [host.layout.runtimeRoot, 0, 0o775, undefined],
    ] as const) {
      const before = host.sys.lstat(path)!;
      host.sys.own(path, uid, 0, mode);
      expect(hostRuntime(host, "98.0.0")?.version).toBe(expected);
      host.sys.own(path, before.uid, before.gid, before.mode);
    }
    expect(hostRuntime(host, "98.0.0")?.version).toBe("98.0.0");
    const script = readFileSync(binary);
    rmSync(binary);
    symlinkSync(host.layout.runtimeBinary(VERSION), binary);
    expect(hostRuntime(host, "98.0.0")?.version).toBe(VERSION);
    rmSync(binary);
    writeFileSync(binary, script, { mode: 0o755 });
    host.sys.own(binary, 0, 0, 0o755);
    // Doctor's probe (no pin) uses the same pick: this host's runtime while it is trusted, else the newest trusted.
    expect(hostRuntime(host, null)?.version).toBe(VERSION);
    host.sys.own(host.layout.runtimeBinary(VERSION), 0, 0, 0o777);
    expect(hostRuntime(host, null)?.version).toBe("98.0.0");
    // Neither this host's runtime nor the pin trusted: no snapshot, saying why, before any unit starts.
    host.sys.own(host.layout.runtimeBinary("0.0.1"), 0, 0, 0o777);
    const calls = host.driver.calls.length;
    await expect(snapshotDatabase(host, old, host.layout.snapshot(old.id, "pre-2"), ROOT_FILE)).rejects.toThrow(
      new RegExp(`No runtime to snapshot shop/old with: neither this host's ${VERSION.replaceAll(".", "\\.")} nor its pinned 0\\.0\\.1 is installed`),
    );
    expect(host.driver.calls.slice(calls).filter((c) => c.startsWith("start "))).toEqual([]);
  });

  test("a runtime without _snapshot fails the snapshot saying so", async () => {
    const { host } = await prodBranch();
    const old = await pinnedBranch(host, "old", "0.0.1");
    seedDatabase(host, old, 2);
    // This host's own runtime cannot be trusted, so the pin (from before _snapshot) is all there is.
    host.sys.own(host.layout.runtimeBinary(VERSION), 0, 0, 0o777);
    const dest = host.layout.snapshot(old.id, "pre-1");
    // What every incibase before _snapshot does with it: "Unknown command", exit 64 (CONFIG).
    host.driver.snapshot = (run) => (host.driver.log(run.unit, 'Unknown command "_snapshot"'), 64);
    await expect(snapshotDatabase(host, old, dest, ROOT_FILE)).rejects.toThrow(
      new RegExp(`it exited with 64: the runtime 0\\.0\\.1 it ran \\(${host.layout.runtimeBinary("0.0.1")}\\) has no _snapshot; install a newer one`),
    );
    // 78 is never _snapshot's own exit: a binary that does not run it.
    host.driver.snapshot = () => 78;
    await expect(snapshotDatabase(host, old, dest, ROOT_FILE)).rejects.toThrow(/it exited with 78: the runtime 0\.0\.1 it ran .* has no _snapshot/);
    // _snapshot's own 64 (bad arguments) still names both causes.
    host.driver.snapshot = () => SNAPSHOT_EXIT.USAGE;
    await expect(snapshotDatabase(host, old, dest, ROOT_FILE)).rejects.toThrow(/it exited with 64 \(bad arguments, or the runtime 0\.0\.1 it ran .* has no _snapshot/);
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(host.layout.branch(old.id).snapshot)).toEqual([]);
  });

  test("never writes through the destination's directory entries: the copy is renamed in from backups/", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 3);
    // The preflight copy goes into the branch's preflight dir (0700, branch-owned). Entries planted there are never followed.
    const dir = host.layout.branch(branch.id).preflight;
    const sentinel = join(host.dir, "sentinel-should-not-be-created");
    symlinkSync(sentinel, join(dir, ".data.db.tmp"));
    symlinkSync(sentinel, join(dir, "data.db"));
    await snapshotDatabase(host, branch, join(dir, "data.db"), { uid: branch.os_uid, gid: branch.os_uid, mode: 0o600 });
    expect(existsSync(sentinel)).toBe(false);
    expect(host.sys.lstat(join(dir, "data.db"))).toMatchObject({ type: "file", uid: branch.os_uid, mode: 0o600 });
    expect(count(join(dir, "data.db"))).toBe(3);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a staging file that is a symlink is refused, whatever it points at", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    const secret = join(host.dir, "control-plane-secret.db");
    writeFileSync(secret, "SECRET-MARKER-symlink");
    stagingIs(host, (path) => symlinkSync(secret, path));
    const dest = host.layout.snapshot(branch.id, "pre-1");
    await expect(snapshotDatabase(host, branch, dest, ROOT_FILE)).rejects.toThrow(/is a symlink; refusing to read it/);
    expect(existsSync(dest)).toBe(false);
    expect(strayTemps(host)).toEqual([]);
    // Root unlinked the planted entry itself, never what it pointed at.
    expect(existsSync(host.layout.branch(branch.id).snapshotFile)).toBe(false);
    expect(readFileSync(secret, "utf8")).toBe("SECRET-MARKER-symlink");
  });

  test("a staging file owned by anyone but the branch is refused", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    stagingIs(host, (path) => {
      takeSnapshot(host.layout.branch(branch.id).data, path);
      host.sys.own(path, 0, 0, 0o600); // e.g. a root file the branch got a name for
    });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(
      new RegExp(`owned by uid 0, not ${branch.os_uid}`),
    );
    expect(strayTemps(host)).toEqual([]);
  });

  test("a staging file with a second link is refused", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    stagingIs(host, (path, b) => {
      takeSnapshot(host.layout.branch(b.id).data, path);
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
      linkSync(path, join(host.layout.branch(b.id).data, "another-name"));
    });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/has 2 links/);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a FIFO as the staging file is refused at once, without blocking root", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    stagingIs(host, (path, b) => {
      expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
    });
    const started = performance.now();
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/is a FIFO; refusing to read it/);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a directory as the staging file is refused (and left for the unit to clear)", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    stagingIs(host, (path, b) => {
      mkdirSync(path);
      host.sys.own(path, b.os_uid, b.os_uid, 0o700);
    });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/is a directory; refusing to read it/);
    // The next run's _snapshot (as the branch) clears it and copies.
    host.driver.snapshot = (run) => host.driver.copySnapshot(run);
    await snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE);
    expect(count(host.layout.snapshot(branch.id, "pre-1"))).toBe(2);
  });

  test("a huge sparse staging file is refused from its size, before a byte is copied", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    stagingIs(host, (path, b) => {
      writeFileSync(path, "");
      truncateSync(path, 2 ** 40); // 1 TiB, sparse
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
    });
    const started = performance.now();
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/is 1099511627776 bytes, more than the \d+ allowed/);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a sparse staging file under the size cap is taken in as a sparse copy that costs no disk", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    // 64 MiB that the branch never wrote (holes, behind a valid header): under the cap of twice a tiny database
    // plus 100 MiB. Root's copy keeps the holes, so it costs backups/ no more disk than the branch's file did.
    const size = 64 * 1024 * 1024;
    stagingIs(host, (path, b) => {
      writeFileSync(path, sqliteHeader(size));
      truncateSync(path, size);
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
    });
    const dest = host.layout.snapshot(branch.id, "pre-1");
    await snapshotDatabase(host, branch, dest, ROOT_FILE);
    expect(statSync(dest).size).toBe(size);
    expect(allocated(dest)).toBeLessThan(1024 * 1024);
    expect(readFileSync(dest).subarray(0, 100).equals(sqliteHeader(size))).toBe(true);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a database with long runs of zeros round-trips byte for byte, its zeros left as holes", async () => {
    const { host, branch } = await prodBranch();
    // 64 KiB pages with zeroblob overflow: every page is 4 bytes of next-page number and then zeros.
    const path = join(host.layout.branch(branch.id).data, "data.db");
    const db = new Database(path, { create: true });
    db.run("PRAGMA page_size = 65536");
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE docs (id INTEGER PRIMARY KEY, body BLOB)");
    for (let i = 0; i < 4; i++) db.run("INSERT INTO docs (body) VALUES (zeroblob(2 * 1024 * 1024))");
    db.run("INSERT INTO docs (body) VALUES ('not all zeros')");
    db.close();
    host.sys.own(path, branch.os_uid, branch.os_uid, 0o600);
    // The real _snapshot copy, its bytes noted before root takes it in.
    let staged = "";
    stagingIs(host, (out, b) => {
      takeSnapshot(host.layout.branch(b.id).data, out);
      host.sys.own(out, b.os_uid, b.os_uid, 0o600);
      staged = sha256Of(out);
    });
    const dest = host.layout.snapshot(branch.id, "pre-1");
    await snapshotDatabase(host, branch, dest, ROOT_FILE);
    expect(sha256Of(dest)).toBe(staged);
    expect(statSync(dest).size).toBeGreaterThan(8 * 1024 * 1024);
    // (Whether those zeros became holes is the file system's call: APFS zero-fills many small holes itself. The
    // Linux suite checks it on a file system that keeps them.)
    expect(count(dest)).toBe(5);
    expect(new Database(dest, { readonly: true }).query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  test("the copy is capped at the branch's INCIBASE_MAX_DB_BYTES, even with free disk to spare", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    // The branch's own database may never exceed 10 MiB, so neither may a copy of it. A dense 12 MiB staging file
    // is refused although there is 100 GiB free and twice the database plus headroom would otherwise allow it.
    const limited = { ...branch, limits_json: JSON.stringify({ memoryMax: 512 * 1024 * 1024, maxDbBytes: 10 * 1024 * 1024 }) };
    stagingIs(host, (path, b) => {
      writeFileSync(path, Buffer.alloc(12 * 1024 * 1024, 0x41));
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
    });
    await expect(snapshotDatabase(host, limited, host.layout.snapshot(limited.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/more than the 10485760 allowed/);
    expect(strayTemps(host)).toEqual([]);
  });

  test("inflating data.db lifts the INCIBASE_MAX_DB_BYTES cap to at most twice the limit; a database over a lowered limit still snapshots", async () => {
    const { host, branch } = await prodBranch();
    const MiB = 1024 * 1024;
    const limited = (maxDbBytes: number) => ({ ...branch, limits_json: JSON.stringify({ memoryMax: 512 * MiB, maxDbBytes }) });
    const dense = (size: number) =>
      stagingIs(host, (path, b) => {
        writeFileSync(path, Buffer.concat([sqliteHeader(size), Buffer.alloc(size - 100, 0x41)]));
        host.sys.own(path, b.os_uid, b.os_uid, 0o600);
      });
    const path = seedDatabase(host, branch, 2);
    // The branch makes its data.db look 2 GiB (a sparse file costs it nothing) and leaves a dense 64 MiB file:
    // the cap is twice its 8 MiB limit, not the 2 GiB its database seems to be, nor the 100 GiB free.
    truncateSync(path, 2 * 1024 * MiB);
    dense(64 * MiB);
    await expect(snapshotDatabase(host, limited(8 * MiB), host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(
      /is 67108864 bytes, more than the 16777216 allowed; refusing to copy it \(its INCIBASE_MAX_DB_BYTES is 8388608; a database already over it is snapshotted up to 2 times that\)/,
    );
    expect(strayTemps(host)).toEqual([]);
    // A database really over a limit lowered under it: 12 MiB of rows with an 8 MiB limit. Its own size is allowed.
    rmSync(path);
    const db = new Database(path, { create: true });
    db.run("CREATE TABLE docs (id INTEGER PRIMARY KEY, body BLOB)");
    for (let i = 0; i < 12; i++) db.run("INSERT INTO docs (body) VALUES (randomblob(1024 * 1024))");
    db.close();
    host.sys.own(path, branch.os_uid, branch.os_uid, 0o600);
    host.driver.snapshot = (run) => host.driver.copySnapshot(run);
    const dest = host.layout.snapshot(branch.id, "pre-2");
    await snapshotDatabase(host, limited(8 * MiB), dest, ROOT_FILE);
    expect(statSync(dest).size).toBeGreaterThan(12 * MiB);
    expect(count(dest)).toBe(12);
    // More than twice over that limit (a 4 MiB limit): refused, saying it is the limit that holds it.
    await expect(snapshotDatabase(host, limited(4 * MiB), host.layout.snapshot(branch.id, "pre-3"), ROOT_FILE)).rejects.toThrow(
      /more than the 8388608 allowed; refusing to copy it \(its INCIBASE_MAX_DB_BYTES is 4194304;/,
    );
    // A refusal for any other cap, or for anything else, does not blame the limit.
    dense(64 * MiB);
    host.sys.free = 150 * MiB;
    await expect(snapshotDatabase(host, limited(1024 * MiB), host.layout.snapshot(branch.id, "pre-4"), ROOT_FILE)).rejects.toThrow(/more than the 52428800 allowed; refusing to copy it$/);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a staging file bigger than the free space allows is refused", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    stagingIs(host, (path, b) => {
      takeSnapshot(host.layout.branch(b.id).data, path);
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
      // Room for the pre-check (twice the database plus 100 MiB), gone by the time root copies.
      host.sys.free = 100 * 1024 * 1024;
    });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/more than the 0 allowed/);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a staging file that is not an SQLite database of its size is refused", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    stagingIs(host, (path, b) => {
      writeFileSync(path, Buffer.alloc(8192, 0x41));
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
    });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/not an SQLite database/);
    stagingIs(host, (path, b) => {
      takeSnapshot(host.layout.branch(b.id).data, path);
      writeFileSync(path, Buffer.alloc(readFileSync(path).readUInt16BE(16)), { flag: "a" }); // a page more than its header says
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
    });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/its header says \d+ pages/);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a snapshot unit that is killed or fails mid-copy leaves its staging dir empty", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    const staging = host.layout.branch(branch.id).snapshot;
    // What a VACUUM INTO killed halfway leaves (OOM, RuntimeMaxSec, a stop, a crash): a partial
    // snapshot.db.tmp, as large as the database, and its -journal. The job lives on and must clear them.
    const killedMidCopy = (outcome: { oom: true } | { exit: number }) => (run: FakeRun) => {
      if (run.kind !== "snapshot") return {};
      for (const [name, size] of [["snapshot.db.tmp", 1024 * 1024], ["snapshot.db.tmp-journal", 512]] as const) {
        const p = join(staging, name);
        writeFileSync(p, Buffer.alloc(size, 0x41));
        host.sys.own(p, branch.os_uid, branch.os_uid, 0o644);
      }
      return outcome;
    };
    host.driver.behavior = killedMidCopy({ oom: true });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/ran out of memory/);
    expect(readdirSync(staging)).toEqual([]);
    host.driver.behavior = killedMidCopy({ exit: 1 });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/exited with 1 \(the copy failed\)/);
    expect(readdirSync(staging)).toEqual([]);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a snapshot unit that fails is a SnapshotError naming how it ended", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    const dest = host.layout.snapshot(branch.id, "pre-1");
    host.driver.behavior = (run) => (run.kind === "snapshot" ? { exit: 1 } : {});
    await expect(snapshotDatabase(host, branch, dest, ROOT_FILE)).rejects.toThrow(/snapshot@.* it exited with 1 \(the copy failed\)/);
    host.driver.behavior = (run) => (run.kind === "snapshot" ? { oom: true } : {});
    await expect(snapshotDatabase(host, branch, dest, ROOT_FILE)).rejects.toThrow(/ran out of memory/);
    host.driver.behavior = () => ({});
    host.driver.snapshot = () => SNAPSHOT_EXIT.NO_DATABASE;
    await expect(snapshotDatabase(host, branch, dest, ROOT_FILE)).rejects.toThrow(/exited with 66 \(no database\)/);
    expect(existsSync(dest)).toBe(false);
    expect(strayTemps(host)).toEqual([]);
  });

  test("an orphaned snapshot unit is stopped before a new one starts", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    const unit = host.layout.units.snapshot(branch.id);
    // A killed job's snapshot unit still runs.
    host.driver.behavior = () => ({ hang: true });
    const { renderSnapshotUnit } = await import("../src/host/render.ts");
    renderSnapshotUnit(host, branch);
    host.driver.start(unit);
    expect(host.driver.isActive(unit)).toBe(true);
    host.driver.behavior = () => ({});
    const calls = host.driver.calls.length;
    await snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE);
    const after = host.driver.calls.slice(calls);
    expect(after.indexOf(`stop ${unit}`)).toBeGreaterThanOrEqual(0);
    expect(after.indexOf(`stop ${unit}`)).toBeLessThan(after.indexOf(`start ${unit}`));
  });

  test("too little free space refuses before the unit runs; no database refuses too", async () => {
    const { host, branch } = await prodBranch();
    const dest = host.layout.snapshot(branch.id, "pre-1");
    await expect(snapshotDatabase(host, branch, dest, ROOT_FILE)).rejects.toThrow(/has no database to snapshot/);
    seedDatabase(host, branch, 2);
    host.sys.free = 1024;
    const calls = host.driver.calls.length;
    await expect(snapshotDatabase(host, branch, dest, ROOT_FILE)).rejects.toThrow(/Not enough free space for a snapshot/);
    expect(host.driver.calls.slice(calls)).toEqual([]);
  });

  test("a branch provisioned before the staging dir existed gets it, the branch's and 0700", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    const staging = host.layout.branch(branch.id).snapshot;
    host.sys.remove(staging);
    await snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE);
    expect(host.sys.lstat(staging)).toMatchObject({ type: "dir", uid: branch.os_uid, gid: branch.os_uid, mode: 0o700 });
  });
});

describe("placeCopy: root's copy goes into a branch directory by rename", () => {
  test("planted entries in the destination directory are replaced, never followed", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 3);
    const snapshot = host.layout.snapshot(branch.id, "pre-1");
    await snapshotDatabase(host, branch, snapshot, ROOT_FILE);
    const dir = host.layout.branch(branch.id).preflight;
    const sentinel = join(host.dir, "sentinel");
    symlinkSync(sentinel, join(dir, "data.db"));
    symlinkSync(sentinel, join(dir, ".data.db.tmp"));
    placeCopy(host, branch, snapshot, join(dir, "data.db"), { uid: branch.os_uid, gid: branch.os_uid, mode: 0o600 });
    expect(existsSync(sentinel)).toBe(false);
    expect(host.sys.lstat(join(dir, "data.db"))).toMatchObject({ type: "file", uid: branch.os_uid, mode: 0o600 });
    expect(count(join(dir, "data.db"))).toBe(3);
    expect(strayTemps(host)).toEqual([]);
  });
});

describe("cleanupSnapshot leaves no orphan after a killed job", () => {
  test("empties the whole staging dir, including a killed _snapshot's snapshot.db.tmp", async () => {
    const { host, branch } = await prodBranch();
    const staging = host.layout.branch(branch.id).snapshot;
    // A killed _snapshot (OOM, RuntimeMaxSec, stop) left a near-full temp beside a partial final file.
    for (const [name, size] of [["snapshot.db.tmp", 4096], ["snapshot.db", 64]] as const) {
      const p = join(staging, name);
      writeFileSync(p, Buffer.alloc(size));
      host.sys.own(p, branch.os_uid, branch.os_uid, 0o600);
    }
    await cleanupSnapshot(host, branch);
    expect(readdirSync(staging)).toEqual([]);
  });

  test("sweeps this branch's backups/.snap-<id>-*.tmp a killed ingest left, and no other's", async () => {
    const { host, branch } = await prodBranch();
    const mine = join(host.layout.backups, `.snap-${branch.id}-deadbeef.tmp`);
    writeFileSync(mine, Buffer.alloc(4096));
    host.sys.own(mine, 0, 0, 0o600);
    // Another branch's temp (and a non-temp file) must survive.
    const other = join(host.layout.backups, `.snap-bz9q8w7e-cafe.tmp`);
    writeFileSync(other, Buffer.alloc(16));
    await cleanupSnapshot(host, branch);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
    rmSync(other, { force: true });
  });

  test("when ingest throws, the staging dir is emptied (snapshot.db and any leftover .tmp)", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    stagingIs(host, (path, b) => {
      // A refused final file (not an SQLite database), plus a .tmp a killed VACUUM would have left next to it.
      writeFileSync(path, Buffer.alloc(8192, 0x41));
      writeFileSync(`${path}.tmp`, Buffer.alloc(4096));
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
    });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/not an SQLite database/);
    expect(readdirSync(host.layout.branch(branch.id).snapshot)).toEqual([]);
    expect(strayTemps(host)).toEqual([]);
  });
});

describe("restoreDatabase is failure-safe and never opens what it replaces", () => {
  test("too little free space keeps the old database in place", async () => {
    const { host, branch } = await prodBranch();
    const path = seedDatabase(host, branch, 5);
    const snapshot = host.layout.snapshot(branch.id, "pre-1");
    await snapshotDatabase(host, branch, snapshot, ROOT_FILE);
    host.sys.free = 1024; // not enough to copy the snapshot in
    expect(() => restoreDatabase(host, branch, snapshot, Date.now())).toThrow(SnapshotError);
    // The live database is untouched: same rows, still owned by the branch, nothing moved to replaced-*.
    expect(host.sys.lstat(path)).toMatchObject({ type: "file", uid: branch.os_uid });
    expect(count(path)).toBe(5);
    expect(readdirSync(host.layout.branch(branch.id).backups).filter((n) => n.startsWith("replaced-"))).toEqual([]);
    expect(strayTemps(host)).toEqual([]);
  });

  test("a restore moves the old database aside and swaps the snapshot in", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    const snapshot = host.layout.snapshot(branch.id, "pre-1");
    await snapshotDatabase(host, branch, snapshot, ROOT_FILE);
    // The live data grows past the snapshot, then is restored.
    seedDatabase(host, branch, 7); // now 2 (kept) + 7
    const kept = restoreDatabase(host, branch, snapshot, 1_800_000_000_000);
    const data = host.layout.branch(branch.id).data;
    expect(host.sys.lstat(join(data, "data.db"))).toMatchObject({ uid: branch.os_uid, gid: branch.os_uid, mode: 0o600 });
    expect(count(join(data, "data.db"))).toBe(2);
    // Only the restored file in data/: the copy was made in backups/ and renamed in.
    expect(readdirSync(data)).toEqual(["data.db"]);
    expect(strayTemps(host)).toEqual([]);
    expect(kept).not.toBeNull();
    expect(count(join(kept!, "data.db"))).toBe(9);
  });

  test("planted -wal and -shm symlinks are moved aside as links; what they point at is never touched", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    const snapshot = host.layout.snapshot(branch.id, "pre-1");
    await snapshotDatabase(host, branch, snapshot, ROOT_FILE);
    const data = host.layout.branch(branch.id).data;
    const outside = join(host.dir, "outside.db");
    writeFileSync(outside, "SECRET-MARKER-restore");
    for (const name of ["data.db-wal", "data.db-shm"]) {
      rmSync(join(data, name), { force: true });
      symlinkSync(outside, join(data, name));
    }
    const kept = restoreDatabase(host, branch, snapshot, 1_800_000_000_000);
    expect(readFileSync(outside, "utf8")).toBe("SECRET-MARKER-restore");
    expect(host.sys.lstat(join(kept!, "data.db-wal"))?.type).toBe("symlink");
    expect(host.sys.lstat(join(kept!, "data.db-shm"))?.type).toBe("symlink");
    expect(readdirSync(data)).toEqual(["data.db"]);
    expect(count(join(data, "data.db"))).toBe(2);
  });
});

describe("the by-fd copy (ingestByFd, LinuxSystem.copyFile)", () => {
  test("gives back the same bytes, zeros anywhere and any length, and keeps a trailing hole", async () => {
    const { host } = await prodBranch();
    const from = join(host.dir, "from.bin");
    const to = join(host.dir, "to.bin");
    const M = 1024 * 1024;
    // Zeros at the start, a run of data across a 4 KiB edge, zeros in the middle, a lone non-zero byte, a length
    // that is no multiple of the block, and a file that ends in a hole.
    const fd = openSync(from, "w");
    writeSync(fd, Buffer.alloc(5000, 0x41), 0, 5000, 3 * M + 1234);
    writeSync(fd, Buffer.from([7]), 0, 1, 5 * M + 4095);
    writeSync(fd, Buffer.alloc(3333, 0x42), 0, 3333, 6 * M);
    closeSync(fd);
    truncateSync(from, 6 * M + 3333 + 12345);
    const options = { uid: 501, maxBytes: 64 * M, owner: ROOT_FILE };
    const platform = { uidOf: () => 501, chown: false };
    expect(ingestByFd(from, to, options, platform)).toBe(statSync(from).size);
    expect(statSync(to).size).toBe(statSync(from).size);
    expect(sha256Of(to)).toBe(sha256Of(from));
    rmSync(to);
    // All zeros (here a 256 MiB hole) is still that many bytes, and costs the copy no disk.
    writeFileSync(from, "");
    truncateSync(from, 256 * M);
    ingestByFd(from, to, { ...options, maxBytes: 256 * M }, platform);
    expect(statSync(to).size).toBe(256 * M);
    expect(allocated(to)).toBeLessThan(M);
    expect(sha256Of(to)).toBe(sha256Of(from));
  });
});

describe("the SQLite header check root makes by fd", () => {
  test("accepts what VACUUM INTO writes and refuses anything else", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 3);
    const out = join(host.dir, "copy.db");
    takeSnapshot(host.layout.branch(branch.id).data, out);
    const bytes = readFileSync(out);
    expect(sqliteHeaderProblem(bytes.subarray(0, 100), bytes.length)).toBeNull();
    expect(sqliteHeaderProblem(bytes.subarray(0, 100), bytes.length + 4096)).toMatch(/its header says/);
    expect(sqliteHeaderProblem(bytes.subarray(0, 100), bytes.length + 1)).toMatch(/not a whole number/);
    expect(sqliteHeaderProblem(bytes.subarray(0, 50), bytes.length)).toBe("not an SQLite database");
    expect(sqliteHeaderProblem(Buffer.alloc(100), 4096)).toBe("not an SQLite database");
    const badPage = Buffer.from(bytes.subarray(0, 100));
    badPage.writeUInt16BE(3000, 16);
    expect(sqliteHeaderProblem(badPage, bytes.length)).toMatch(/invalid page size/);
  });
});

describe("incibase _snapshot (what the unit runs, as the branch)", () => {
  const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "_snapshot", ...args], { stdout: "pipe", stderr: "pipe" });

  test("copies data.db, WAL included, into --out (0600), replacing what was there", async () => {
    const { host, branch } = await prodBranch();
    const path = seedDatabase(host, branch, 4);
    const live = new Database(path);
    live.run("PRAGMA wal_autocheckpoint = 0");
    live.run("INSERT INTO docs (body) VALUES ('wal only')");
    const out = join(host.dir, "staging", "snapshot.db");
    mkdirSync(join(host.dir, "staging"));
    mkdirSync(out); // something left at the output: the branch's own dir, cleared first
    const result = cli("--data", host.layout.branch(branch.id).data, "--out", out);
    live.close();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ ev: "snapshot", bytes: expect.any(Number) });
    expect(count(out)).toBe(5);
    expect((statSync(out).mode & 0o777).toString(8)).toBe("600");
    expect(readdirSync(join(host.dir, "staging"))).toEqual(["snapshot.db"]);
  });

  test("exits 66 without a database, 64 on bad arguments", async () => {
    const { host, branch } = await prodBranch();
    const out = join(host.dir, "snapshot.db");
    const none = cli("--data", host.layout.branch(branch.id).data, "--out", out);
    expect(none.exitCode).toBe(66);
    expect(none.stderr.toString()).toContain("There is no database at");
    expect(cli("--data", "relative/dir", "--out", out).exitCode).toBe(64);
    expect(cli("--data", host.layout.branch(branch.id).data).exitCode).toBe(64);
    expect(cli("--nope").exitCode).toBe(64);
    expect(existsSync(out)).toBe(false);
    expect(() => takeSnapshot(host.layout.branch(branch.id).data, "/a/../b")).toThrow(SnapshotCommandError);
  });
});
