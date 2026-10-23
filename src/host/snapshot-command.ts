// `incibase _snapshot --data <dir> --out <file>`: what the snapshot unit
// (`incibase-snapshot@<id>`) runs, as the branch, in its sandbox (design
// section 3.2 D.3.1). It copies <dir>/data.db with `VACUUM INTO` over a
// read-only connection (trusted_schema off, so nothing in the schema runs)
// into a temp next to <file>, checks the copy with `PRAGMA quick_check`,
// fsyncs it and renames it to <file>, 0600.
//
// It runs with the branch's own rights, so whatever data/ holds (a symlink,
// a swapped -wal or -shm, a FIFO) it can only ever read what the branch
// could read anyway. Root never opens the branch's database: it takes the
// finished file in by fd afterwards (HostSystem.ingestFile).
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { parseArgs } from "node:util";

/** How `_snapshot` exits (sysexits.h): the host tells "no database" from a failed copy. */
export const SNAPSHOT_EXIT = { OK: 0, FAILED: 1, USAGE: 64, NO_DATABASE: 66 } as const;

export class SnapshotCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "SnapshotCommandError";
  }
}

function absolute(path: string | undefined, flag: string): string {
  if (!path || !isAbsolute(path) || normalize(path) !== path || path.endsWith("/")) {
    throw new SnapshotCommandError(`${flag} must be an absolute, normalized path, got ${JSON.stringify(path ?? "")}`, SNAPSHOT_EXIT.USAGE);
  }
  return path;
}

function fsyncPath(path: string, flags: "r" | "r+" = "r") {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Copies `<dataDir>/data.db` into `out` (0600); returns its size. Throws SnapshotCommandError. */
export function takeSnapshot(dataDir: string, out: string): { bytes: number } {
  const source = join(absolute(dataDir, "--data"), "data.db");
  absolute(out, "--out");
  if (!existsSync(source)) throw new SnapshotCommandError(`There is no database at ${source}`, SNAPSHOT_EXIT.NO_DATABASE);
  const temp = `${out}.tmp`;
  // The staging dir is this branch's own: whatever an earlier run (or the branch) left there goes first,
  // since VACUUM INTO refuses an existing file.
  rmSync(out, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
  try {
    const db = new Database(source, { readonly: true });
    try {
      db.run("PRAGMA trusted_schema = OFF");
      // The branch keeps writing; a checkpoint holding a lock for a moment is waited for, not a failure.
      db.run("PRAGMA busy_timeout = 10000");
      db.run(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    const copy = new Database(temp, { readonly: true });
    try {
      copy.run("PRAGMA trusted_schema = OFF");
      const rows = copy.query("PRAGMA quick_check").all() as { quick_check: string }[];
      if (rows.length !== 1 || rows[0]!.quick_check !== "ok") {
        throw new Error(`the copy failed its quick_check: ${rows.map((r) => r.quick_check).join("; ").slice(0, 500)}`);
      }
    } finally {
      copy.close();
    }
    chmodSync(temp, 0o600);
    fsyncPath(temp, "r+");
    renameSync(temp, out);
    fsyncPath(dirname(out));
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    if (err instanceof SnapshotCommandError) throw err;
    throw new SnapshotCommandError(`The snapshot of ${source} failed: ${(err as Error).message}`, SNAPSHOT_EXIT.FAILED);
  }
  return { bytes: statSync(out).size };
}

/** `incibase _snapshot …`; returns the exit code. One JSON line on stdout when it worked, the reason on stderr otherwise. */
export function snapshotCli(argv: string[]): number {
  try {
    let values: { data?: string; out?: string };
    try {
      ({ values } = parseArgs({ args: argv, options: { data: { type: "string" }, out: { type: "string" } }, allowPositionals: false }));
    } catch (err) {
      throw new SnapshotCommandError((err as Error).message, SNAPSHOT_EXIT.USAGE);
    }
    const { bytes } = takeSnapshot(values.data ?? "", values.out ?? "");
    console.log(JSON.stringify({ ev: "snapshot", bytes }));
    return SNAPSHOT_EXIT.OK;
  } catch (err) {
    console.error((err as Error).message);
    return err instanceof SnapshotCommandError ? err.exitCode : SNAPSHOT_EXIT.FAILED;
  }
}
