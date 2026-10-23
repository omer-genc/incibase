// The snapshot TOCTOU race on a real Linux machine, as root (design hard
// rule: root never follows a branch-controlled path into another tenant's
// data or the control plane). A branch process keeps flipping its data.db
// between its own live database and a symlink to the root-only control
// registry (which holds every branch's INCIBASE_ADMIN_KEY) while root runs
// snapshotDatabase in a tight loop. The snapshot must never capture the
// symlink's target: pinning the inode with O_RDONLY|O_NOFOLLOW defeats the
// swap. Skipped unless INCIBASE_TEST_HOST=1 on Linux as root. Uses its own
// host root (INCIBASE_TEST_HOST_ROOT, default /var/lib/incibase-fix) and uid
// base (INCIBASE_TEST_UID_BASE, default 76000); removes everything it made.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import { createBranch, createProject, initHost, type HostContext } from "../src/host/provision.ts";
import { Registry, type BranchRow } from "../src/host/registry.ts";
import { snapshotDatabase, SnapshotError } from "../src/host/snapshot.ts";
import { LinuxSystem } from "../src/host/system.ts";

const enabled = process.env.INCIBASE_TEST_HOST === "1" && process.platform === "linux" && process.getuid?.() === 0;
const ROOT = process.env.INCIBASE_TEST_HOST_ROOT ?? "/var/lib/incibase-fix";
const UID_BASE = Number(process.env.INCIBASE_TEST_UID_BASE ?? 76000);
const MARKER = ".incibase-test-root";
const LABEL = basename(ROOT).slice(0, 24);
const GROUPS = { proxy: `${LABEL}-proxy`, admin: `${LABEL}-admin` };
const FLIP = `/tmp/${LABEL}-flip.ts`;

const sys = new LinuxSystem();
let ctx: HostContext;
let branch: BranchRow;

function cleanup() {
  if (existsSync(join(ROOT, "control", "registry.db"))) {
    const registry = Registry.open(new HostLayout({ root: ROOT, groups: GROUPS }));
    for (const b of registry.listBranches()) {
      for (const pid of sys.processesOf(b.os_uid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      if (sys.getpwnam(`ib-${b.id}`)?.uid === b.os_uid) sys.userdel(`ib-${b.id}`);
      if (sys.getgrnam(`ib-${b.id}`)?.gid === b.os_uid) sys.groupdel(`ib-${b.id}`);
    }
    registry.close();
  }
  for (const g of [GROUPS.proxy, GROUPS.admin]) if (sys.getgrnam(g)) sys.groupdel(g);
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(FLIP, { force: true });
}

// A branch process: keeps its own WAL database live and repeatedly swaps data.db for a symlink to the control registry.
const FLIP_SOURCE = `import { Database } from "bun:sqlite";
import { renameSync, symlinkSync, rmSync } from "node:fs";
const [db, secret, secs] = process.argv.slice(2);
const live = new Database(db, { create: true });
live.run("PRAGMA journal_mode=WAL"); live.run("PRAGMA wal_autocheckpoint=0");
live.run("CREATE TABLE IF NOT EXISTS t (v TEXT)");
for (let i = 0; i < 40; i++) live.run("INSERT INTO t VALUES ('branchdata')");
const end = Date.now() + Number(secs) * 1000;
let n = 0;
while (Date.now() < end) {
  renameSync(db, db + ".real");
  rmSync(db, { force: true });
  symlinkSync(secret, db);
  renameSync(db + ".real", db);
  if (++n % 100 === 0) live.run("INSERT INTO t VALUES ('branchdata')");
}
live.close();
`;

describe.skipIf(!enabled)("snapshotDatabase defeats a data.db symlink race", () => {
  beforeAll(async () => {
    if (ROOT === DEFAULT_ROOT) throw new Error(`Refusing to test on ${DEFAULT_ROOT}`);
    if (existsSync(ROOT)) {
      if (!existsSync(join(ROOT, MARKER))) throw new Error(`${ROOT} exists and is not a test root; remove it or set INCIBASE_TEST_HOST_ROOT`);
      cleanup();
    }
    mkdirSync(ROOT, { mode: 0o755 });
    writeFileSync(join(ROOT, MARKER), "");
    writeFileSync(FLIP, FLIP_SOURCE, { mode: 0o755 });
    const layout = new HostLayout({ root: ROOT, groups: GROUPS });
    ctx = { layout, sys, registry: Registry.open(layout), actor: "root:test" };
    await initHost(ctx, { uidBase: UID_BASE, domain: "incibase.example.net", timezone: "UTC" });
    await createProject(ctx, { slug: "shop" });
    branch = await createBranch(ctx, { project: "shop", name: "prod" });
    // The branch's own database, owned by it.
    const dataDb = join(layout.branch(branch.id).data, "data.db");
    const db = new Database(dataDb, { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run("CREATE TABLE t (v TEXT)");
    for (let i = 0; i < 40; i++) db.run("INSERT INTO t VALUES ('branchdata')");
    db.close();
    for (const name of ["data.db", "data.db-wal", "data.db-shm"]) {
      const p = join(layout.branch(branch.id).data, name);
      if (existsSync(p)) sys.chown(p, branch.os_uid, branch.os_uid);
    }
    // The control registry holds every branch's INCIBASE_ADMIN_KEY; its presence in a snapshot would be a leak.
    // Checkpoint so the key is in the main registry.db file (the symlink target), not only its WAL.
    ctx.registry.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(layout.registry).includes("ik_admin_")).toBe(true);
  }, 60_000);

  afterAll(() => {
    ctx?.registry.close();
    if (enabled) cleanup();
  });

  test("a symlinked data.db never yields a snapshot with the control plane's contents", async () => {
    const layout = ctx.layout;
    const dataDb = join(layout.branch(branch.id).data, "data.db");
    const dest = join(ROOT, "snap.db");
    const flipper = Bun.spawn(["setpriv", `--reuid=${branch.os_uid}`, `--regid=${branch.os_uid}`, "--clear-groups", "--", process.execPath, FLIP, dataDb, layout.registry, "8"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(300);
    let ok = 0;
    let rejected = 0;
    let leaked = 0;
    let foreignOwner = 0;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      rmSync(dest, { force: true });
      try {
        snapshotDatabase(ctx, branch, dest, { uid: 0, gid: 0, mode: 0o600 });
      } catch (err) {
        if (err instanceof SnapshotError) {
          rejected++;
          continue;
        }
        throw err;
      }
      ok++;
      const bytes = readFileSync(dest);
      if (bytes.includes("ik_admin_")) leaked++;
      // A successful snapshot is the branch's own database: it has table t, not the registry's env table.
      try {
        const copy = new Database(dest, { readonly: true });
        const tables = copy.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
        copy.close();
        if (tables.some((r) => r.name === "env" || r.name === "branches")) foreignOwner++;
      } catch {
        // A torn copy that will not open is not a leak.
      }
    }
    flipper.kill("SIGKILL");
    await flipper.exited;
    rmSync(dest, { force: true });
    // The race must be lossless of safety: zero leaks and zero foreign schemas, with real snapshots still taken.
    expect(leaked).toBe(0);
    expect(foreignOwner).toBe(0);
    expect(ok).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  }, 30_000);
});
