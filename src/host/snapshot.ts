// Snapshots of a branch's database (design section 3.2 D.3.1): root runs
// `VACUUM INTO` over a read-only connection while the branch keeps running
// (the branch's data dir lock does not stop it). Taken before a production
// release (`backups/<id>/pre-<seq>.db`, root 0600, the last 3 kept), used as
// the preflight's copy, and put back by `rollback --restore`.
//
// The branch owns its data dir (0700) and keeps writing during a prod
// snapshot, so root never opens data.db by name: it pins the inode with
// O_RDONLY|O_NOFOLLOW (sys.openPinned) and hands SQLite that inode, so a
// symlink swapped into data/ cannot redirect the read to another branch's
// data or the control plane. The VACUUM temp is written in a root-only
// directory (backups/, 0700) and then renamed into place, so a symlink
// planted in the branch-owned destination directory cannot redirect the
// write either.
//
// SQLite here only copies pages: the connection is read-only and
// trusted_schema is off, so nothing in the tenant's schema (views, triggers,
// functions) runs as root.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { MiB } from "./config.ts";
import { SNAPSHOT_NAME } from "./layout.ts";
import type { HostContext } from "./provision.ts";
import type { BranchRow } from "./registry.ts";

/** Room a snapshot needs besides its own size: VACUUM INTO writes a full copy, and the branch keeps writing. */
export const SNAPSHOT_HEADROOM = 100 * MiB;
/** Snapshots kept per branch (besides any a firing alert or a committed-but-failed release still needs). */
export const KEEP_SNAPSHOTS = 3;
export const DB_FILES = ["data.db", "data.db-wal", "data.db-shm"] as const;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** The database and its WAL, in bytes; 0 when the branch has no database yet. */
export function databaseBytes(ctx: HostContext, dataDir: string): number {
  return ["data.db", "data.db-wal"].reduce((sum, name) => sum + (ctx.sys.lstat(join(dataDir, name))?.size ?? 0), 0);
}

export function hasDatabase(ctx: HostContext, branch: BranchRow): boolean {
  return ctx.sys.lstat(join(ctx.layout.branch(branch.id).data, "data.db"))?.type === "file";
}

/** A fresh root-only path under backups/ for a VACUUM/copy temp the branch cannot reach. */
function snapshotTemp(ctx: HostContext, id: string): string {
  const dir = ctx.layout.backups;
  if (!ctx.sys.lstat(dir)) ctx.sys.mkdir(dir, 0o700);
  return join(dir, `.snap-${id}-${randomBytes(8).toString("hex")}.tmp`);
}

/**
 * Copies the branch's live database to `dest` with `owner`, atomically
 * (a temp file in a root-only directory, then rename). Refuses when the file
 * system of `dest` has less than twice the database plus SNAPSHOT_HEADROOM
 * free. Pins the source inode so a symlink swapped into the branch's data
 * dir cannot redirect the read.
 */
export function snapshotDatabase(ctx: HostContext, branch: BranchRow, dest: string, owner: { uid: number; gid: number; mode: number }) {
  const { sys, layout } = ctx;
  const data = layout.branch(branch.id).data;
  const source = join(data, "data.db");
  let pinned;
  try {
    pinned = sys.openPinned(source);
  } catch (err) {
    // A symlink swapped into the branch's data dir (openPinned refuses it): a clean refusal, not a crash.
    throw new SnapshotError(`The snapshot of ${source} was refused: ${(err as Error).message}`);
  }
  if (!pinned) throw new SnapshotError(`${branch.project}/${branch.name} has no database to snapshot`);
  try {
    if (pinned.info.type !== "file") throw new SnapshotError(`${source} is not a regular file; refusing to snapshot it`);
    // The branch owns data/: a symlink or a file put there by anyone else is not the branch's database.
    if (pinned.info.uid !== branch.os_uid) {
      throw new SnapshotError(`${source} is owned by ${pinned.info.uid}, not the branch (${branch.os_uid}); refusing to snapshot it`);
    }
    const size = databaseBytes(ctx, data);
    const free = sys.freeBytes(dirname(dest));
    const need = 2 * size + SNAPSHOT_HEADROOM;
    if (free < need) {
      throw new SnapshotError(
        `Not enough free space for a snapshot: ${Math.ceil(free / MiB)} MiB free under ${dirname(dest)}, ` +
          `${Math.ceil(need / MiB)} MiB needed (twice the ${Math.ceil(size / MiB)} MiB database plus 100 MiB)`,
      );
    }
    const temp = snapshotTemp(ctx, branch.id);
    if (sys.lstat(temp)) sys.remove(temp);
    const before = new Set(DB_FILES.filter((name) => sys.lstat(join(data, name))));
    try {
      // Open the pinned inode (never the directory entry); while the branch writes, a transient open
      // or VACUUM failure is a clean refusal to retry, not a crash.
      const db = new Database(pinned.path, { readonly: true });
      try {
        db.run("PRAGMA trusted_schema = OFF");
        db.run(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
      } finally {
        db.close();
      }
    } catch (err) {
      if (sys.lstat(temp)) sys.remove(temp);
      throw new SnapshotError(`The snapshot of ${source} failed: ${(err as Error).message}`);
    }
    // VACUUM INTO writes 0644 as root in the root-only temp dir; the mode and owner are fixed before the rename.
    sys.chown(temp, owner.uid, owner.gid);
    sys.chmod(temp, owner.mode);
    sys.rename(temp, dest);
    // A -wal or -shm this connection had to create belongs to root now; the branch must still open them.
    for (const name of DB_FILES) {
      const path = join(data, name);
      const info = sys.lstat(path);
      if (info && !before.has(name) && (info.uid !== branch.os_uid || info.gid !== branch.os_uid)) sys.chown(path, branch.os_uid, branch.os_uid);
    }
  } finally {
    pinned.close();
  }
}

/** The release seq a `pre-<seq>` snapshot belongs to, or null for `pre-upgrade-*` and anything else. */
function snapshotReleaseSeq(name: string): number | null {
  const match = /^pre-(\d{1,9})\.db$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** Snapshot names (e.g. `pre-2.db`) that pruning must never remove: those a firing alert or a committed-but-failed release still needs. */
function protectedSnapshots(ctx: HostContext, branch: BranchRow): Set<string> {
  const names = new Set<string>();
  const re = /\bpre-(?:\d{1,9}|upgrade-\d{1,15})\b/g;
  for (const alert of ctx.registry.listAlerts("firing")) {
    if (alert.key !== `release:${branch.id}` && alert.key !== `branch:${branch.id}`) continue;
    for (const match of (alert.message ?? "").matchAll(re)) names.add(`${match[0]}.db`);
  }
  // The newest release that committed its migration and did not go live is the one `--restore` goes back to.
  const committed = ctx.registry.listReleases(branch.id).find((r) => r.migration_committed === 1 && r.status !== "live");
  if (committed?.snapshot) names.add(basename(committed.snapshot));
  return names;
}

/**
 * Removes a branch's snapshots (`pre-*.db`) beyond the newest `keep`, never
 * removing one a firing alert or a committed-but-failed release still needs,
 * and removing failed releases' snapshots before successful ones.
 */
export function pruneSnapshots(ctx: HostContext, branch: BranchRow, keep = KEEP_SNAPSHOTS): string[] {
  const dir = ctx.layout.branch(branch.id).backups;
  const protect = protectedSnapshots(ctx, branch);
  const failed = new Set(
    ctx.registry
      .listReleases(branch.id)
      .filter((r) => r.status === "failed" || r.status === "interrupted")
      .map((r) => r.seq),
  );
  const snapshots = ctx.sys
    .readdir(dir)
    .filter((name) => SNAPSHOT_NAME.test(name.replace(/\.db$/, "")) && name.endsWith(".db"))
    .map((name) => {
      const seq = snapshotReleaseSeq(name);
      return { name, mtime: ctx.sys.lstat(join(dir, name))?.mtimeMs ?? 0, failed: seq !== null && failed.has(seq) };
    });
  const candidates = snapshots.filter((s) => !protect.has(s.name));
  // Keep preference: successful releases before failed ones, newer before older. Prune what falls past `keep`.
  candidates.sort((a, b) => Number(a.failed) - Number(b.failed) || b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  const removed: string[] = [];
  for (const { name } of candidates.slice(keep)) {
    ctx.sys.remove(join(dir, name));
    removed.push(name);
  }
  return removed;
}

/** Empties a directory, keeping the directory itself. */
export function emptyDir(ctx: HostContext, dir: string) {
  for (const name of ctx.sys.readdir(dir)) ctx.sys.remove(join(dir, name));
}

/**
 * Puts `snapshot` in place of a stopped branch's database, failure-safe: the
 * snapshot is copied into the data dir first (while the old database is still
 * there), and only an atomic rename swaps it in, so a copy that runs out of
 * space or a job that dies mid-restore never leaves the branch without a
 * database. The database it replaces (with its WAL) is kept in
 * `backups/<id>/replaced-<at>/`; the restored file belongs to the branch,
 * 0600, with no -wal or -shm next to it.
 */
export function restoreDatabase(ctx: HostContext, branch: BranchRow, snapshot: string, at: number): string | null {
  const { sys, layout } = ctx;
  const paths = layout.branch(branch.id);
  const info = sys.lstat(snapshot);
  if (info?.type !== "file") throw new SnapshotError(`No snapshot ${snapshot}`);
  if (sys.processesOf(branch.os_uid).length) throw new SnapshotError(`${branch.project}/${branch.name} still runs; it must stop before a restore`);
  const free = sys.freeBytes(paths.data);
  const need = info.size + SNAPSHOT_HEADROOM;
  if (free < need) {
    throw new SnapshotError(
      `Not enough free space to restore: ${Math.ceil(free / MiB)} MiB free under ${paths.data}, ${Math.ceil(need / MiB)} MiB needed`,
    );
  }
  // Copy the snapshot into the data dir while the old database is still in place.
  const restoring = join(paths.data, "data.db.restoring");
  if (sys.lstat(restoring)) sys.remove(restoring);
  sys.copyFile(snapshot, restoring, { uid: branch.os_uid, gid: branch.os_uid, mode: 0o600 });
  // Only now move the old files aside; the rename of the copy is atomic and cannot fail for lack of space.
  const present = DB_FILES.filter((name) => sys.lstat(join(paths.data, name)));
  let kept: string | null = null;
  if (present.length) {
    if (!sys.lstat(paths.backups)) sys.mkdir(paths.backups, 0o700);
    kept = join(paths.backups, `replaced-${Math.trunc(at)}`);
    sys.mkdir(kept, 0o700);
    sys.chown(kept, 0, 0);
    sys.chmod(kept, 0o700);
    for (const name of present) sys.rename(join(paths.data, name), join(kept, name));
  }
  try {
    sys.rename(restoring, join(paths.data, "data.db"));
  } catch (err) {
    // Put the old database back and leave no half-restored file behind.
    if (kept) {
      for (const name of present) sys.rename(join(kept, name), join(paths.data, name));
      sys.remove(kept);
      kept = null;
    }
    if (sys.lstat(restoring)) sys.remove(restoring);
    throw err;
  }
  // Keep the last two replaced databases.
  const replaced = sys.readdir(paths.backups).filter((name) => /^replaced-\d+$/.test(name));
  replaced.sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
  for (const name of replaced.slice(0, -2)) sys.remove(join(paths.backups, name));
  return kept;
}
