// Snapshot and restore orchestration (design section 3.2 D.3.1) on a fake
// host with real SQLite databases. Root never opens the branch's database:
// the snapshot unit (`incibase-snapshot@<id>`, here FakeDriver running the
// real `_snapshot` copy in-process) writes the branch's staging file, and
// root takes it in by fd into a root-only temp and renames it into place.
// These tests hand root every kind of staging file a branch could leave
// instead (symlink, FIFO, foreign owner, hard link, huge sparse file,
// garbage) and check it is refused without a copy, a hang or a stray temp;
// that the preflight copy and a restore are made in backups/ and renamed in;
// and that a restore never opens the entries it moves aside. The race
// against a real branch uid runs in test/host-snapshot-linux.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SnapshotCommandError, SNAPSHOT_EXIT, takeSnapshot } from "../src/host/snapshot-command.ts";
import * as ops from "../src/host/ops.ts";
import type { BranchRow } from "../src/host/registry.ts";
import { cleanupSnapshot, placeCopy, restoreDatabase, snapshotDatabase, SnapshotError, sqliteHeaderProblem } from "../src/host/snapshot.ts";
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
    const { host, branch } = await prodBranch();
    const path = seedDatabase(host, branch, 4);
    // The branch keeps a connection open with rows only in its WAL.
    const live = new Database(path);
    live.run("PRAGMA wal_autocheckpoint = 0");
    live.run("INSERT INTO docs (body) VALUES ('in the wal')");
    const dest = host.layout.snapshot(branch.id, "pre-1");
    const calls = host.driver.calls.length;
    await snapshotDatabase(host, branch, dest, ROOT_FILE);
    live.close();
    expect(host.sys.lstat(dest)).toMatchObject({ type: "file", uid: 0, gid: 0, mode: 0o600 });
    expect(count(dest)).toBe(5);
    // The copy ran in the branch's snapshot unit, as the branch, with its pinned runtime's _snapshot.
    const unit = host.layout.units.snapshot(branch.id);
    expect(host.driver.calls.slice(calls)).toContain(`start ${unit}`);
    const dropIn = readFileSync(host.layout.dropIn(unit), "utf8");
    expect(dropIn).toContain(`User=ib-${branch.id}\n`);
    expect(dropIn).toContain(
      `ExecStart=${host.layout.runtimeBinary(branch.runtime_version)} _snapshot --data ${host.layout.branch(branch.id).data} --out ${host.layout.branch(branch.id).snapshotFile}\n`,
    );
    // The staging file is gone, and root left no temp behind.
    expect(readdirSync(host.layout.branch(branch.id).snapshot)).toEqual([]);
    expect(strayTemps(host)).toEqual([]);
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

  test("a sparse staging file just under the size cap is refused, and copies nothing large into backups/", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    // Its apparent size is under the cap (twice a tiny database plus 100 MiB), but it is sparse: no real disk is
    // allocated. The old st_size-based cap would let root's copy write 64 MiB of real zero blocks into backups/.
    stagingIs(host, (path, b) => {
      writeFileSync(path, "");
      truncateSync(path, 64 * 1024 * 1024);
      host.sys.own(path, b.os_uid, b.os_uid, 0o600);
    });
    await expect(snapshotDatabase(host, branch, host.layout.snapshot(branch.id, "pre-1"), ROOT_FILE)).rejects.toThrow(/is sparse \(\d+ bytes allocated of 67108864\)/);
    expect(strayTemps(host)).toEqual([]);
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
    expect(Bun.spawnSync(["stat", "-f", "%Lp", out]).stdout.toString().trim()).toBe("600");
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
