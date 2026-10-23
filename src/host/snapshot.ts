// Snapshots of a branch's database (design section 3.2 D.3.1): root runs
// `VACUUM INTO` over a read-only connection while the branch keeps running
// (the branch's data dir lock does not stop it). Taken before a production
// release (`backups/<id>/pre-<seq>.db`, root 0600, the last 3 kept), used as
// the preflight's copy, and put back by `rollback --restore`.
//
// SQLite here only copies pages: the connection is read-only and
// trusted_schema is off, so nothing in the tenant's schema (views, triggers,
// functions) runs as root.
import { Database } from "bun:sqlite";
import { basename, dirname, join } from "node:path";
import { MiB } from "./config.ts";
import type { HostContext } from "./provision.ts";
import type { BranchRow } from "./registry.ts";

/** Room a snapshot needs besides its own size: VACUUM INTO writes a full copy, and the branch keeps writing. */
export const SNAPSHOT_HEADROOM = 100 * MiB;
/** Snapshots kept per branch. */
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

/**
 * Copies the branch's live database to `dest` with `owner`, atomically
 * (a temp file next to it, then rename). Refuses when the file system of
 * `dest` has less than twice the database plus SNAPSHOT_HEADROOM free.
 */
export function snapshotDatabase(ctx: HostContext, branch: BranchRow, dest: string, owner: { uid: number; gid: number; mode: number }) {
  const { sys, layout } = ctx;
  const data = layout.branch(branch.id).data;
  const source = join(data, "data.db");
  if (sys.lstat(source)?.type !== "file") throw new SnapshotError(`${branch.project}/${branch.name} has no database to snapshot`);
  const size = databaseBytes(ctx, data);
  const free = sys.freeBytes(dirname(dest));
  const need = 2 * size + SNAPSHOT_HEADROOM;
  if (free < need) {
    throw new SnapshotError(
      `Not enough free space for a snapshot: ${Math.ceil(free / MiB)} MiB free under ${dirname(dest)}, ` +
        `${Math.ceil(need / MiB)} MiB needed (twice the ${Math.ceil(size / MiB)} MiB database plus 100 MiB)`,
    );
  }
  const temp = join(dirname(dest), `.${basename(dest)}.tmp`);
  if (sys.lstat(temp)) sys.remove(temp);
  const before = new Set(DB_FILES.filter((name) => sys.lstat(join(data, name))));
  const db = new Database(source, { readonly: true });
  try {
    db.run("PRAGMA trusted_schema = OFF");
    db.run(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
  } catch (err) {
    if (sys.lstat(temp)) sys.remove(temp);
    throw new SnapshotError(`The snapshot of ${source} failed: ${(err as Error).message}`);
  } finally {
    db.close();
  }
  // VACUUM INTO writes 0644 as root; the directory is root 0700, and the mode is fixed before the rename.
  sys.chown(temp, owner.uid, owner.gid);
  sys.chmod(temp, owner.mode);
  sys.rename(temp, dest);
  // A -wal or -shm this connection had to create belongs to root now; the branch must still open them.
  for (const name of DB_FILES) {
    const path = join(data, name);
    const info = sys.lstat(path);
    if (info && !before.has(name) && (info.uid !== branch.os_uid || info.gid !== branch.os_uid)) sys.chown(path, branch.os_uid, branch.os_uid);
  }
}

/** Removes all but the newest `keep` snapshots (`pre-*.db`) of a branch. */
export function pruneSnapshots(ctx: HostContext, branch: BranchRow, keep = KEEP_SNAPSHOTS): string[] {
  const dir = ctx.layout.branch(branch.id).backups;
  const snapshots = ctx.sys
    .readdir(dir)
    .filter((name) => /^pre-[a-z0-9-]+\.db$/.test(name))
    .map((name) => ({ name, mtime: ctx.sys.lstat(join(dir, name))?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  const removed: string[] = [];
  for (const { name } of snapshots.slice(keep)) {
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
 * Puts `snapshot` in place of a stopped branch's database. The database it
 * replaces (with its WAL) is kept in `backups/<id>/replaced-<at>/`; the
 * restored file belongs to the branch, 0600, with no -wal or -shm next to it.
 */
export function restoreDatabase(ctx: HostContext, branch: BranchRow, snapshot: string, at: number): string | null {
  const { sys, layout } = ctx;
  const paths = layout.branch(branch.id);
  if (sys.lstat(snapshot)?.type !== "file") throw new SnapshotError(`No snapshot ${snapshot}`);
  if (sys.processesOf(branch.os_uid).length) throw new SnapshotError(`${branch.project}/${branch.name} still runs; it must stop before a restore`);
  let kept: string | null = null;
  const present = DB_FILES.filter((name) => sys.lstat(join(paths.data, name)));
  if (present.length) {
    if (!sys.lstat(paths.backups)) sys.mkdir(paths.backups, 0o700);
    kept = join(paths.backups, `replaced-${Math.trunc(at)}`);
    sys.mkdir(kept, 0o700);
    sys.chown(kept, 0, 0);
    sys.chmod(kept, 0o700);
    for (const name of present) sys.rename(join(paths.data, name), join(kept, name));
  }
  sys.copyFile(snapshot, join(paths.data, "data.db"), { uid: branch.os_uid, gid: branch.os_uid, mode: 0o600 });
  // Keep the last two replaced databases.
  const replaced = sys.readdir(paths.backups).filter((name) => /^replaced-\d+$/.test(name));
  replaced.sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
  for (const name of replaced.slice(0, -2)) sys.remove(join(paths.backups, name));
  return kept;
}
