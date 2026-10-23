// Snapshots of a branch's database (design section 3.2 D.3.1): taken before
// a production release (`backups/<id>/pre-<seq>.db`, root 0600, the last 3
// kept), used as the preflight's copy, and put back by `rollback --restore`.
//
// Root never opens a branch's database files (data.db, -wal, -shm), neither
// by name nor through SQLite: the branch owns data/ and keeps writing while a
// production snapshot is taken, and SQLite resolves symlinks in a database
// path and opens the -wal and -shm by name, so a read made as root could be
// pointed at another branch's data or the control plane. Instead:
//
//   1. `incibase-snapshot@<id>` runs `incibase _snapshot` (snapshot-command.ts)
//      with the branch's uid, in the branch's sandbox (control/, backups/ and
//      trash/ inaccessible, its MemoryMax, RuntimeMaxSec), from the newer of
//      the host's own runtime and the branch's pinned one (render.hostRuntime).
//      It `VACUUM INTO`s data.db into the branch-owned staging dir
//      (snapshot/snapshot.db). As the branch it can only ever read what the
//      branch could read anyway.
//   2. Root takes the staging file in by fd (HostSystem.ingestFile): opened
//      once with O_NOFOLLOW|O_NONBLOCK, checked from that fd (a regular file
//      of the branch's uid with one link, no larger than the database, its
//      INCIBASE_MAX_DB_BYTES and the free space allow, an SQLite header that
//      agrees with its size) and copied, sparse-preserving (blocks of zeros
//      stay holes, so a sparse file costs root no disk), into a fresh temp in
//      backups/ (root 0700) that gets its final owner and mode and an fsync,
//      then renamed into place. Root never runs SQLite on those bytes. The
//      staging dir is emptied afterwards, whether the unit or the ingest
//      worked or not (each entry removed, never followed).
//
// The preflight copy and `rollback --restore` follow the same rule: the copy
// is made in backups/ and renamed into the branch's directory (a rename
// replaces the entry, never follows it), and the database a restore replaces
// is moved aside by rename, never opened.
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { VERSION } from "../engine/version.ts";
import { MiB, parseLimits, resolveLimits } from "./config.ts";
import { defaults, type OpsContext } from "./context.ts";
import { CLD_EXITED, ranToSuccess, settled, unitJournalTail, type UnitStatus } from "./driver.ts";
import { SNAPSHOT_NAME } from "./layout.ts";
import type { HostContext } from "./provision.ts";
import type { BranchRow } from "./registry.ts";
import { hostRuntime, renderSnapshotUnit, SNAPSHOT_RUNTIME_MAX_SEC, type HostRuntime } from "./render.ts";
import { SNAPSHOT_EXIT } from "./snapshot-command.ts";
import { IngestError, type Owner } from "./system.ts";

/** Room a snapshot needs besides its own size: the staging copy and root's copy are both full copies, and the branch keeps writing. */
export const SNAPSHOT_HEADROOM = 100 * MiB;
/** Snapshots kept per branch (besides any a firing alert or a committed-but-failed release still needs). */
export const KEEP_SNAPSHOTS = 3;
export const DB_FILES = ["data.db", "data.db-wal", "data.db-shm"] as const;
/** What the job waits for a snapshot unit: its RuntimeMaxSec and a little more. */
const SNAPSHOT_WAIT_MS = (SNAPSHOT_RUNTIME_MAX_SEC + 60) * 1000;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/**
 * The size of the database and its WAL in bytes (st_size, lstat: never
 * followed; 0 when the branch has no database yet). A VACUUM INTO copy is
 * never larger. It is the apparent size, which a branch can inflate with a
 * sparse file, so it only bounds the copy of a database that is not hostile:
 * the copy is sparse-preserving (a hole costs root no disk), and how much
 * root reads is held by the free space and INCIBASE_MAX_DB_BYTES, which the
 * branch cannot raise. (Never st_blocks: on a compressing file system, ZFS or
 * btrfs with compression, it is the compressed size.)
 */
export function databaseBytes(ctx: HostContext, dataDir: string): number {
  return ["data.db", "data.db-wal"].reduce((sum, name) => {
    const info = ctx.sys.lstat(join(dataDir, name));
    return sum + (info?.type === "file" ? info.size : 0);
  }, 0);
}

export function hasDatabase(ctx: HostContext, branch: BranchRow): boolean {
  return ctx.sys.lstat(join(ctx.layout.branch(branch.id).data, "data.db"))?.type === "file";
}

/** A fresh root-only path under backups/ for a copy the branch cannot reach until it is renamed into place. */
function snapshotTemp(ctx: HostContext, id: string): string {
  const dir = ctx.layout.backups;
  if (!ctx.sys.lstat(dir)) ctx.sys.mkdir(dir, 0o700);
  return join(dir, `.snap-${id}-${randomBytes(8).toString("hex")}.tmp`);
}

function removeTemp(ctx: HostContext, temp: string) {
  if (ctx.sys.lstat(temp)) ctx.sys.remove(temp);
}

/**
 * Why `head` (an SQLite file's first 100 bytes) does not describe a database
 * of `size` bytes; null when it does. Read from the fd root copies, so root
 * checks the file without handing it to SQLite.
 */
export function sqliteHeaderProblem(head: Uint8Array, size: number): string | null {
  const bytes = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (bytes.length < 100 || bytes.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") return "not an SQLite database";
  const raw = bytes.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) return `an invalid page size ${raw}`;
  if (size % pageSize !== 0) return `${size} bytes is not a whole number of ${pageSize}-byte pages`;
  // The page count in the header is valid when its change counter matches "version-valid-for" (VACUUM INTO writes both).
  if (bytes.readUInt32BE(24) === bytes.readUInt32BE(92) && bytes.readUInt32BE(28) * pageSize !== size) {
    return `its header says ${bytes.readUInt32BE(28)} pages of ${pageSize} bytes, the file has ${size} bytes`;
  }
  return null;
}

/** The branch's staging dir for the snapshot unit: branch-owned 0700, in root's branches/<id>/ (so the branch cannot swap it). */
function ensureStaging(ctx: HostContext, branch: BranchRow): string {
  const { sys } = ctx;
  const dir = ctx.layout.branch(branch.id).snapshot;
  const info = sys.lstat(dir);
  if (info && info.type !== "dir") throw new SnapshotError(`${dir} is a ${info.type}, not a directory; run incibase host render`);
  if (!info) sys.mkdir(dir, 0o700);
  const now = sys.lstat(dir);
  if (now?.uid !== branch.os_uid || now.gid !== branch.os_uid) sys.chown(dir, branch.os_uid, branch.os_uid);
  if (sys.lstat(dir)?.mode !== 0o700) sys.chmod(dir, 0o700);
  return dir;
}

/** Stops `unit` if it runs and waits until it settles; true when it settled. */
async function stopUnit(ctx: OpsContext, unit: string): Promise<boolean> {
  const { driver } = ctx;
  const sleep = defaults.sleep(ctx);
  if (!settled(driver.show(unit))) {
    driver.stop(unit);
    for (let i = 0; i < 300 && !settled(driver.show(unit)); i++) await sleep(100);
  }
  const ok = settled(driver.show(unit));
  if (ok) driver.resetFailed(unit);
  return ok;
}

/**
 * What a runtime that has no `_snapshot` exits with: every incibase built
 * before it says `Unknown command "_snapshot"` and exits 64 (ExitCode.CONFIG,
 * the code `_snapshot` itself uses for bad arguments); `_snapshot` never
 * exits 78 (ExitCode.DEFINITION), so 78 means a binary that does not run it.
 */
const NO_SNAPSHOT_COMMAND = /Unknown command "_snapshot"/;

function describeSnapshotExit(status: UnitStatus, runtime: HostRuntime, tail: string): string {
  if (status.result === "oom-kill") return "it ran out of memory (killed by the OOM killer)";
  if (status.result === "timeout") return `it ran past its time limit (${SNAPSHOT_RUNTIME_MAX_SEC} s)`;
  if (status.execMainCode === CLD_EXITED) {
    const code = status.execMainStatus;
    const lacking = `the runtime ${runtime.version} it ran (${runtime.binary}) has no _snapshot; install a newer one with incibase host install-runtime`;
    if (code === 78 || (code === SNAPSHOT_EXIT.USAGE && NO_SNAPSHOT_COMMAND.test(tail))) return `it exited with ${code}: ${lacking}`;
    const why = code === SNAPSHOT_EXIT.NO_DATABASE ? "no database" : code === SNAPSHOT_EXIT.USAGE ? `bad arguments, or ${lacking}` : "the copy failed";
    return `it exited with ${code} (${why})`;
  }
  if (status.execMainCode > CLD_EXITED) return `it was killed by signal ${status.execMainStatus}`;
  return `the unit is ${status.activeState}/${status.subState} (${status.result || "no result"})`;
}

/** Runs the branch's snapshot unit to completion: the branch's database is in its staging file afterwards. */
async function runSnapshotUnit(ctx: OpsContext, branch: BranchRow): Promise<void> {
  const { driver, layout } = ctx;
  const unit = layout.units.snapshot(branch.id);
  const sleep = defaults.sleep(ctx);
  const runtime = hostRuntime(ctx, branch.runtime_version);
  if (!runtime) {
    throw new SnapshotError(
      `No runtime to snapshot ${branch.project}/${branch.name} with: neither this host's ${VERSION} nor its pinned ${branch.runtime_version} is installed ` +
        `as a root-owned file no one else can write under ${layout.runtimeRoot}; install one with incibase host install-runtime`,
    );
  }
  // An earlier snapshot of this branch may still run (its job was killed): `start` would be a no-op on that
  // active unit and we would take in the OLD run's file. Stop it and wait until it settles first.
  if (!(await stopUnit(ctx, unit))) throw new SnapshotError(`An earlier snapshot (${unit}) is still running and would not stop`);
  if (renderSnapshotUnit(ctx, branch, runtime)) driver.daemonReload();
  const cursor = driver.journalCursor();
  driver.resetFailed(unit);
  const started = performance.now();
  let status: UnitStatus;
  try {
    driver.start(unit);
    for (;;) {
      status = driver.show(unit);
      if (settled(status)) break;
      if (performance.now() - started > SNAPSHOT_WAIT_MS) {
        driver.stop(unit);
        status = driver.show(unit);
        break;
      }
      await sleep(defaults.pollMs(ctx));
    }
  } finally {
    // Never leave it running: its file would be mistaken for the next snapshot's.
    if (!settled(driver.show(unit))) driver.stop(unit);
  }
  driver.resetFailed(unit);
  if (!ranToSuccess(status)) {
    const tail = unitJournalTail(driver, unit, cursor, 10);
    throw new SnapshotError(`The snapshot of ${branch.project}/${branch.name} failed: ${unit} ${describeSnapshotExit(status, runtime, tail)}${tail ? `\n${tail}` : ""}`);
  }
}

/**
 * Copies the branch's live database to `dest` with `owner` (design section
 * 3.2 D.3.1): the branch's snapshot unit copies it as the branch, then root
 * takes the staging file in by fd into a root-only temp and renames that
 * into place. Refuses when the file system of `dest` has less than twice the
 * database plus SNAPSHOT_HEADROOM free, and refuses a staging file that is
 * not what the unit leaves (a symlink, a FIFO, another owner, a hard link,
 * larger than the database, its limit or the free space allows, no SQLite
 * header). The staging dir is emptied however it ends.
 */
export async function snapshotDatabase(ctx: OpsContext, branch: BranchRow, dest: string, owner: Owner): Promise<void> {
  const { sys, layout } = ctx;
  const paths = layout.branch(branch.id);
  if (!hasDatabase(ctx, branch)) throw new SnapshotError(`${branch.project}/${branch.name} has no database to snapshot`);
  const before = databaseBytes(ctx, paths.data);
  const free = sys.freeBytes(dirname(dest));
  const need = 2 * before + SNAPSHOT_HEADROOM;
  if (free < need) {
    throw new SnapshotError(
      `Not enough free space for a snapshot: ${Math.ceil(free / MiB)} MiB free under ${dirname(dest)}, ` +
        `${Math.ceil(need / MiB)} MiB needed (twice the ${Math.ceil(before / MiB)} MiB database plus 100 MiB)`,
    );
  }
  ensureStaging(ctx, branch);
  let temp: string | null = null;
  try {
    // A unit that fails or is killed (OOM, RuntimeMaxSec, a stop) while this job lives on leaves a partial
    // snapshot.db.tmp and its -journal, as large as the database; the finally below clears them too.
    await runSnapshotUnit(ctx, branch);
    // How much root reads: no more than the database could hold (twice, as it keeps growing meanwhile), no more
    // than the branch's own INCIBASE_MAX_DB_BYTES (a VACUUM copy is at most the live database, which
    // max_page_count holds to that; one already over a lowered limit keeps its size), and room for the headroom
    // in backups/. The database's size is the apparent one, which a branch can inflate; the free space and the
    // limit are not, and the copy keeps holes, so neither a sparse nor a zero-filled file costs root disk.
    const after = databaseBytes(ctx, paths.data);
    const maxDbBytes = resolveLimits(parseLimits(branch.limits_json)).maxDbBytes;
    const caps = [2 * Math.max(before, after) + SNAPSHOT_HEADROOM, sys.freeBytes(layout.backups) - SNAPSHOT_HEADROOM];
    if (maxDbBytes !== undefined) caps.push(Math.max(maxDbBytes, before));
    const maxBytes = Math.max(0, Math.min(...caps));
    temp = snapshotTemp(ctx, branch.id);
    try {
      sys.ingestFile(paths.snapshotFile, temp, { uid: branch.os_uid, maxBytes, owner, check: sqliteHeaderProblem });
    } catch (err) {
      if (err instanceof IngestError) throw new SnapshotError(`The snapshot of ${branch.project}/${branch.name} was refused: ${err.message}`);
      throw new SnapshotError(`Taking in the snapshot of ${branch.project}/${branch.name} failed: ${(err as Error).message}`);
    }
    sys.rename(temp, dest);
    temp = null;
  } finally {
    if (temp) removeTemp(ctx, temp);
    discardStaging(ctx, branch);
  }
}

/**
 * Empties the branch's staging dir (every entry, never followed): snapshot.db
 * and any snapshot.db.tmp a killed `_snapshot` left mid-VACUUM, which can be a
 * near-full copy of the database. The dir is branch-owned 0700; root removes
 * each entry by lstat + remove without following it, so a symlink or FIFO
 * planted there has only its own entry removed.
 */
function discardStaging(ctx: HostContext, branch: BranchRow) {
  const dir = ctx.layout.branch(branch.id).snapshot;
  for (const name of ctx.sys.readdir(dir)) {
    const path = join(dir, name);
    try {
      if (ctx.sys.lstat(path)) ctx.sys.remove(path);
    } catch {
      // Whatever cannot go is the next unit's to clear, with the branch's own rights, before its next copy.
    }
  }
}

/** Removes any `backups/.snap-<id>-*.tmp` a killed ingest or placeCopy left: root-only dir, each by lstat + unlink, never followed. */
function sweepSnapshotTemps(ctx: HostContext, id: string) {
  const dir = ctx.layout.backups;
  const prefix = `.snap-${id}-`;
  for (const name of ctx.sys.readdir(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    if (ctx.sys.lstat(path)) ctx.sys.unlink(path);
  }
}

/** Stops a branch's snapshot unit and discards its staging dir and any root-side ingest temp, so a killed job leaves no orphan behind. */
export async function cleanupSnapshot(ctx: OpsContext, branch: BranchRow): Promise<void> {
  await stopUnit(ctx, ctx.layout.units.snapshot(branch.id));
  discardStaging(ctx, branch);
  sweepSnapshotTemps(ctx, branch.id);
}

/**
 * Puts a copy of root's own file `from` (a snapshot in backups/) at `dest`
 * in a branch-owned directory, with `owner`: copied by fd into a root-only
 * temp, then renamed in, so nothing is ever written through a name the
 * branch controls.
 */
export function placeCopy(ctx: HostContext, branch: BranchRow, from: string, dest: string, owner: Owner) {
  const temp = snapshotTemp(ctx, branch.id);
  try {
    ctx.sys.copyFile(from, temp, owner);
    ctx.sys.rename(temp, dest);
  } catch (err) {
    removeTemp(ctx, temp);
    throw err;
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
 * snapshot is copied first (into a root-only temp under backups/, by fd, as
 * the branch's 0600 file) while the old database is still there, and only an
 * atomic rename swaps it in, so a copy that runs out of space or a job that
 * dies mid-restore never leaves the branch without a database. The entries
 * it replaces (data.db and its WAL, whatever they are) are moved by rename,
 * never opened, into `backups/<id>/replaced-<at>/`; the restored file has no
 * -wal or -shm next to it.
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
  // The copy, made where the branch cannot reach it, while the old database is still in place.
  const temp = snapshotTemp(ctx, branch.id);
  try {
    sys.copyFile(snapshot, temp, { uid: branch.os_uid, gid: branch.os_uid, mode: 0o600 });
  } catch (err) {
    removeTemp(ctx, temp);
    throw err;
  }
  // Only now move the old entries aside; the rename of the copy is atomic and cannot fail for lack of space.
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
    sys.rename(temp, join(paths.data, "data.db"));
  } catch (err) {
    // Put the old database back and leave no copy behind.
    if (kept) {
      for (const name of present) sys.rename(join(kept, name), join(paths.data, name));
      sys.remove(kept);
      kept = null;
    }
    removeTemp(ctx, temp);
    throw err;
  }
  // Keep the last two replaced databases.
  const replaced = sys.readdir(paths.backups).filter((name) => /^replaced-\d+$/.test(name));
  replaced.sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
  for (const name of replaced.slice(0, -2)) sys.remove(join(paths.backups, name));
  return kept;
}
