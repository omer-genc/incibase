// Snapshot and restore internals (design section 3.2 D.3.1) on a fake host
// with a real SQLite database: that root pins the source inode and refuses a
// swapped-in file or symlink (finding: the TOCTOU snapshot read), that the
// VACUUM temp never lands in a branch-owned directory (finding: the temp
// symlink-follow), and that a restore that runs out of space keeps the old
// database instead of destroying it (finding: unsafe restore order). The
// Linux race proof runs in test/host-systemd.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/host/ops.ts";
import type { BranchRow } from "../src/host/registry.ts";
import { restoreDatabase, snapshotDatabase, SnapshotError } from "../src/host/snapshot.ts";
import { closeOpsHosts, fakeOpsHost, seedDatabase, type OpsTestHost } from "./host-helpers.ts";

afterEach(closeOpsHosts);

async function prodBranch(): Promise<{ host: OpsTestHost; branch: BranchRow }> {
  const host = await fakeOpsHost();
  await ops.createProject(host, { slug: "shop", branches: ["prod"] });
  const branch = host.registry.findBranch("shop", "prod")!;
  return { host, branch };
}

describe("snapshotDatabase pins the source", () => {
  test("copies the branch's own database", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 4);
    const dest = host.layout.snapshot(branch.id, "pre-1");
    host.sys.mkdir(host.layout.branch(branch.id).backups, 0o700);
    snapshotDatabase(host, branch, dest, { uid: 0, gid: 0, mode: 0o600 });
    expect(host.sys.lstat(dest)).toMatchObject({ type: "file", uid: 0, gid: 0, mode: 0o600 });
    expect(new Database(dest, { readonly: true }).query("SELECT count(*) AS n FROM docs").get()).toEqual({ n: 4 });
  });

  test("refuses a data.db that is not owned by the branch", async () => {
    const { host, branch } = await prodBranch();
    const path = seedDatabase(host, branch, 2);
    // Someone swapped in a file owned by another uid (e.g. a hardlink to the control plane).
    host.sys.own(path, 1, 1, 0o600);
    const dest = host.layout.snapshot(branch.id, "pre-1");
    host.sys.mkdir(host.layout.branch(branch.id).backups, 0o700);
    expect(() => snapshotDatabase(host, branch, dest, { uid: 0, gid: 0, mode: 0o600 })).toThrow(/owned by 1, not the branch/);
    expect(existsSync(dest)).toBe(false);
  });

  test("refuses a data.db that is a symlink", async () => {
    const { host, branch } = await prodBranch();
    const data = host.layout.branch(branch.id).data;
    // A dangling symlink in place of the database: openPinned (O_NOFOLLOW) rejects it.
    writeFileSync(join(host.dir, "elsewhere.db"), "secret");
    symlinkSync(join(host.dir, "elsewhere.db"), join(data, "data.db"));
    const dest = host.layout.snapshot(branch.id, "pre-1");
    host.sys.mkdir(host.layout.branch(branch.id).backups, 0o700);
    expect(() => snapshotDatabase(host, branch, dest, { uid: 0, gid: 0, mode: 0o600 })).toThrow(/symlink/);
    expect(existsSync(dest)).toBe(false);
  });

  test("writes its temp in a root-only directory, not the branch-owned destination directory", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 3);
    // The copy goes into the branch's preflight dir (0700, branch-owned). A temp planted there must not be used.
    const dir = host.layout.branch(branch.id).preflight;
    const sentinel = join(host.dir, "sentinel-should-not-be-created");
    symlinkSync(sentinel, join(dir, ".data.db.tmp"));
    const owner = { uid: branch.os_uid, gid: branch.os_uid, mode: 0o600 };
    snapshotDatabase(host, branch, join(dir, "data.db"), owner);
    // VACUUM never followed the planted temp symlink, because the temp lives under backups/, not preflight/.
    expect(existsSync(sentinel)).toBe(false);
    expect(new Database(join(dir, "data.db"), { readonly: true }).query("SELECT count(*) AS n FROM docs").get()).toEqual({ n: 3 });
    // No stray VACUUM temp left in backups/ either.
    expect(readdirSync(host.layout.backups).filter((n) => n.startsWith(".snap-"))).toEqual([]);
  });
});

describe("restoreDatabase is failure-safe", () => {
  test("too little free space keeps the old database in place", async () => {
    const { host, branch } = await prodBranch();
    const path = seedDatabase(host, branch, 5);
    const before = new Database(path, { readonly: true }).query("SELECT count(*) AS n FROM docs").get();
    // A snapshot to restore.
    const snapshot = host.layout.snapshot(branch.id, "pre-1");
    host.sys.mkdir(host.layout.branch(branch.id).backups, 0o700);
    snapshotDatabase(host, branch, snapshot, { uid: 0, gid: 0, mode: 0o600 });
    host.sys.free = 1024; // not enough to copy the snapshot in
    expect(() => restoreDatabase(host, branch, snapshot, Date.now())).toThrow(SnapshotError);
    // The live database is untouched: same rows, still owned by the branch, nothing moved to replaced-*.
    expect(host.sys.lstat(path)).toMatchObject({ type: "file", uid: branch.os_uid });
    expect(new Database(path, { readonly: true }).query("SELECT count(*) AS n FROM docs").get()).toEqual(before as { n: number });
    expect(readdirSync(host.layout.branch(branch.id).backups).filter((n) => n.startsWith("replaced-"))).toEqual([]);
    expect(existsSync(join(host.layout.branch(branch.id).data, "data.db.restoring"))).toBe(false);
  });

  test("a restore moves the old database aside and swaps the snapshot in", async () => {
    const { host, branch } = await prodBranch();
    seedDatabase(host, branch, 2);
    const snapshot = host.layout.snapshot(branch.id, "pre-1");
    host.sys.mkdir(host.layout.branch(branch.id).backups, 0o700);
    snapshotDatabase(host, branch, snapshot, { uid: 0, gid: 0, mode: 0o600 });
    // The live data grows past the snapshot, then is restored.
    seedDatabase(host, branch, 7); // now 2 (kept) + 7
    const kept = restoreDatabase(host, branch, snapshot, 1_800_000_000_000);
    const data = host.layout.branch(branch.id).data;
    expect(host.sys.lstat(join(data, "data.db"))).toMatchObject({ uid: branch.os_uid, gid: branch.os_uid, mode: 0o600 });
    expect(new Database(join(data, "data.db"), { readonly: true }).query("SELECT count(*) AS n FROM docs").get()).toEqual({ n: 2 });
    expect(existsSync(join(data, "data.db.restoring"))).toBe(false);
    expect(kept).not.toBeNull();
    expect(new Database(join(kept!, "data.db"), { readonly: true }).query("SELECT count(*) AS n FROM docs").get()).toEqual({ n: 9 });
  });
});
