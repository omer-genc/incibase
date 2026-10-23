// What the host layer asks of the operating system: users and groups, and
// files with exact owners and modes. Provisioning goes through this
// interface, so tests on macOS run it against FakeSystem and the Linux
// tests against LinuxSystem. Commands run from argument arrays, never a
// shell; every name is checked before it reaches one.
import {
  constants as fsConstants,
  closeSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  chmodSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}

export interface GroupEntry {
  name: string;
  gid: number;
  members: string[];
}

export interface FileInfo {
  type: "dir" | "file" | "symlink" | "other";
  uid: number;
  gid: number;
  /** Permission bits with setuid, setgid and sticky (`& 0o7777`). */
  mode: number;
  size: number;
  mtimeMs: number;
}

export interface NewUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  comment: string;
}

export interface Owner {
  uid: number;
  gid: number;
  mode: number;
}

export interface IngestOptions {
  /** The only owner the file may have: the branch whose unit wrote it. */
  uid: number;
  /** Larger is refused before a byte is copied. */
  maxBytes: number;
  /** Owner and mode of the copy. */
  owner: Owner;
  /** Sees the file's first bytes (up to 100) and its size before the copy; a string refuses it with that reason. */
  check?: (head: Uint8Array, size: number) => string | null;
}

/** A file a branch left for root was refused; nothing was copied. */
export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

export interface HostSystem {
  getpwnam(name: string): PasswdEntry | null;
  getpwuid(uid: number): PasswdEntry | null;
  getgrnam(name: string): GroupEntry | null;
  getgrgid(gid: number): GroupEntry | null;
  /** A system group; `gid` picks its id, otherwise the system chooses. */
  groupadd(name: string, gid?: number): void;
  groupdel(name: string): void;
  /** A system user without a home directory or login shell. */
  useradd(user: NewUser): void;
  /** Removes the user; its group goes too if it was the user's private group. */
  userdel(name: string): void;
  /** Adds an existing user to a supplementary group (`usermod --append --groups`). */
  addToGroup(user: string, group: string): void;

  /** The path itself, never what a symlink points at; null when missing. */
  lstat(path: string): FileInfo | null;
  /** One directory level; an existing directory is fine. */
  mkdir(path: string, mode: number): void;
  /** Owner of the path itself (lchown). */
  chown(path: string, uid: number, gid: number): void;
  /** Refuses a symlink, so it never changes what one points at. */
  chmod(path: string, mode: number): void;
  /** Points `path` at `target`, replacing what is there atomically. */
  symlink(target: string, path: string): void;
  readlink(path: string): string | null;
  /** Writes `content` to a temp file next to `path` with the owner and mode, syncs it and renames it over `path`. */
  writeFile(path: string, content: string, owner: { uid: number; gid: number; mode: number }): void;
  /** Copies the file `from` (not following a link) the same way, by fd and sparse-preserving: temp file with owner and mode, fsync, rename. */
  copyFile(from: string, to: string, owner: { uid: number; gid: number; mode: number }): void;
  /**
   * Takes in a file a branch controls without trusting its directory entry
   * (design section 3.2 D.3.1): opens `from` once with
   * O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC (a symlink is refused, a FIFO
   * cannot block), checks from that fd that it is a regular file owned by
   * `uid` with one link and at most `maxBytes`, and copies its bytes by fd
   * into `to`, a new file (O_CREAT|O_EXCL|O_NOFOLLOW) that gets `owner` and
   * an fsync. The copy is sparse-preserving (blocks of zeros stay holes), so
   * a sparse or zero-filled file costs `to` no disk; `maxBytes` bounds how
   * much root reads. Throws IngestError and leaves no `to` when it refuses.
   * Returns the bytes copied.
   */
  ingestFile(from: string, to: string, options: IngestOptions): number;
  /** Removes one directory entry with unlink(2): never follows it, never recurses. Missing is fine; a directory throws. */
  unlink(path: string): void;
  readFile(path: string): string | null;
  /** Names in a directory, sorted; empty when it is missing. */
  readdir(path: string): string[];
  /** Bytes an unprivileged writer could still use on the file system of `path`. */
  freeBytes(path: string): number;
  rename(from: string, to: string): void;
  /** Removes a file, link or whole tree without following links; missing is fine. */
  remove(path: string): void;
  /** The first path under `root` whose owner or group is `id`, skipping (pruning) `exclude`; null when none. */
  findOwned(root: string, id: number, exclude: string[]): string | null;
  /** Ids of the processes running as `uid`. */
  processesOf(uid: number): number[];
}

export class SystemCommandError extends Error {
  constructor(
    readonly command: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${command.join(" ")} failed (exit ${exitCode ?? "signal"}): ${stderr.trim() || "no output"}`);
    this.name = "SystemCommandError";
  }
}

/** User and group names this layer passes to commands: never one that could read as an option. */
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

export function checkAccountName(name: string): string {
  if (!ACCOUNT_NAME.test(name)) throw new Error(`Invalid user or group name ${JSON.stringify(name)}`);
  return name;
}

function checkId(id: number): number {
  if (!Number.isInteger(id) || id < 0 || id >= 2 ** 32 - 1) throw new Error(`Invalid uid or gid ${id}`);
  return id;
}

function checkPath(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error(`Expected an absolute path, got ${JSON.stringify(path)}`);
  return path;
}

/** `/etc/passwd` and `/etc/group` lines as getent prints them. */
export function parsePasswd(line: string): PasswdEntry | null {
  const f = line.trim().split(":");
  if (f.length < 7) return null;
  return { name: f[0]!, uid: Number(f[2]), gid: Number(f[3]), gecos: f[4]!, home: f[5]!, shell: f[6]! };
}

export function parseGroup(line: string): GroupEntry | null {
  const f = line.trim().split(":");
  if (f.length < 4) return null;
  return { name: f[0]!, gid: Number(f[2]), members: f[3] ? f[3].split(",") : [] };
}

function fileInfo(path: string): FileInfo | null {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
  const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  return { type, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777, size: st.size, mtimeMs: st.mtimeMs };
}

/** Names in `dir`, sorted; empty when it does not exist. */
export function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

function tempPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.tmp`);
}

function removeQuietly(path: string) {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
}

/** Bun opens every file close-on-exec already; this says so explicitly where it matters. */
const O_CLOEXEC = process.platform === "linux" ? 0o2000000 : process.platform === "darwin" ? 0x1000000 : 0;
/** Reads a file a branch may control: never through a symlink, never blocking on a FIFO. */
const OPEN_UNTRUSTED = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | O_CLOEXEC;
/** Creates a file that must be new: a planted file or symlink makes it fail (EEXIST). */
const CREATE_NEW = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | O_CLOEXEC;
const COPY_CHUNK = 1024 * 1024;

/** Opens `path` with OPEN_UNTRUSTED; a symlink, a socket or a missing file is an IngestError. */
function openUntrusted(path: string): number {
  try {
    return openSync(path, OPEN_UNTRUSTED);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") throw new IngestError(`${path} does not exist`);
    // O_NOFOLLOW turns a symlink final component into ELOOP (EMLINK on some BSDs): it is never followed.
    if (code === "ELOOP" || code === "EMLINK") throw new IngestError(`${path} is a symlink; refusing to read it`);
    if (code === "ENXIO" || code === "EOPNOTSUPP") throw new IngestError(`${path} is not a regular file`);
    throw err;
  }
}

function describeType(st: Stats): string {
  return st.isDirectory() ? "a directory" : st.isFIFO() ? "a FIFO" : st.isSocket() ? "a socket" : st.isSymbolicLink() ? "a symlink" : "not a regular file";
}

/** Blocks of zeros a copy leaves as holes: the usual file system block (4 KiB on ext4, btrfs, xfs and APFS). */
const SPARSE_BLOCK = 4096;
const ZERO_BLOCK = Buffer.alloc(SPARSE_BLOCK);

/** Writes `buffer[from, to)` at `position + from` with positional writes, however many calls that takes. */
function writeAt(fd: number, buffer: Buffer, from: number, to: number, position: number) {
  for (let at = from; at < to; ) at += writeSync(fd, buffer, at, to - at, position + at);
}

/**
 * Copies exactly `size` bytes from `src` to `dst` (new and empty) by fd; a
 * source that shrinks or grows meanwhile is refused. Sparse-preserving: each
 * SPARSE_BLOCK that reads as all zeros is skipped (the writes are positional,
 * so it stays a hole) and `dst` is truncated to `size` at the end, so a run of
 * zeros costs the copy no disk, whether it was a hole in the source (a
 * branch's sparse file), zeros the branch really wrote, or a database's empty
 * pages. The bytes read back are the same either way.
 */
function copyBytes(src: number, dst: number, size: number, what: string) {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(size, 1)));
  let done = 0;
  while (done < size) {
    const n = readSync(src, buffer, 0, Math.min(buffer.length, size - done), done);
    if (n === 0) throw new IngestError(`${what} shrank while it was copied`);
    let run = -1; // where the current run of non-zero blocks started
    for (let at = 0; at < n; at += SPARSE_BLOCK) {
      const end = Math.min(at + SPARSE_BLOCK, n);
      const zero = buffer.compare(ZERO_BLOCK, 0, end - at, at, end) === 0;
      if (!zero && run < 0) run = at;
      else if (zero && run >= 0) {
        writeAt(dst, buffer, run, at, done);
        run = -1;
      }
    }
    if (run >= 0) writeAt(dst, buffer, run, n, done);
    done += n;
  }
  ftruncateSync(dst, size); // the length, and any trailing zeros as a hole
  if (readSync(src, buffer, 0, 1, size) !== 0) throw new IngestError(`${what} grew while it was copied`);
}

/**
 * HostSystem.ingestFile for both systems: `uidOf` says who owns the opened
 * inode (fstat on Linux; FakeSystem's records in tests), `chown` whether the
 * copy's owner can be set (only root can).
 */
export function ingestByFd(from: string, to: string, options: IngestOptions, platform: { uidOf: (st: Stats) => number; chown: boolean }): number {
  const src = openUntrusted(from);
  let dst: number | null = null;
  try {
    const st = fstatSync(src);
    if (!st.isFile()) throw new IngestError(`${from} is ${describeType(st)}; refusing to read it`);
    const uid = platform.uidOf(st);
    if (uid !== options.uid) throw new IngestError(`${from} is owned by uid ${uid}, not ${options.uid}; refusing to read it`);
    if (st.nlink !== 1) throw new IngestError(`${from} has ${st.nlink} links; refusing to read it`);
    if (st.size > options.maxBytes) throw new IngestError(`${from} is ${st.size} bytes, more than the ${options.maxBytes} allowed; refusing to copy it`);
    if (options.check) {
      const head = Buffer.alloc(Math.min(100, st.size));
      const n = head.length ? readSync(src, head, 0, head.length, 0) : 0;
      const problem = options.check(head.subarray(0, n), st.size);
      if (problem) throw new IngestError(`${from}: ${problem}`);
    }
    dst = openSync(to, CREATE_NEW, 0o600);
    if (platform.chown) fchownSync(dst, checkId(options.owner.uid), checkId(options.owner.gid));
    fchmodSync(dst, platform.chown ? options.owner.mode : 0o600);
    copyBytes(src, dst, st.size, from);
    fsyncSync(dst);
    closeSync(dst);
    dst = null;
    return st.size;
  } catch (err) {
    if (dst !== null) {
      closeSync(dst);
      removeQuietly(to); // Never a partial copy (e.g. ENOSPC).
    }
    throw err;
  } finally {
    closeSync(src);
  }
}

function fsyncDir(dir: string) {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The real thing: shadow-utils, getent and find on Linux; run as root. */
export class LinuxSystem implements HostSystem {
  private run(command: string[], okCodes: number[] = [0]): { exitCode: number; stdout: string } {
    const result = Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } });
    const exitCode = result.exitCode ?? -1;
    if (!okCodes.includes(exitCode)) throw new SystemCommandError(command, result.exitCode, result.stderr.toString());
    return { exitCode, stdout: result.stdout.toString() };
  }

  /** getent exits 2 when the key is not found. */
  private getent(db: "passwd" | "group", key: string): string | null {
    const { exitCode, stdout } = this.run(["getent", db, key], [0, 2]);
    return exitCode === 0 ? stdout.split("\n")[0]! : null;
  }

  getpwnam(name: string) {
    const line = this.getent("passwd", checkAccountName(name));
    return line === null ? null : parsePasswd(line);
  }

  getpwuid(uid: number) {
    const line = this.getent("passwd", String(checkId(uid)));
    return line === null ? null : parsePasswd(line);
  }

  getgrnam(name: string) {
    const line = this.getent("group", checkAccountName(name));
    return line === null ? null : parseGroup(line);
  }

  getgrgid(gid: number) {
    const line = this.getent("group", String(checkId(gid)));
    return line === null ? null : parseGroup(line);
  }

  groupadd(name: string, gid?: number) {
    const args = ["groupadd", "--system"];
    if (gid !== undefined) args.push("--gid", String(checkId(gid)));
    this.run([...args, "--", checkAccountName(name)]);
  }

  groupdel(name: string) {
    this.run(["groupdel", "--", checkAccountName(name)]);
  }

  addToGroup(user: string, group: string) {
    this.run(["usermod", "--append", "--groups", checkAccountName(group), "--", checkAccountName(user)]);
  }

  useradd(user: NewUser) {
    if (/[:\n,]/.test(user.comment)) throw new Error(`Invalid user comment ${JSON.stringify(user.comment)}`);
    this.run([
      "useradd",
      "--system",
      "--uid",
      String(checkId(user.uid)),
      "--gid",
      String(checkId(user.gid)),
      "--no-create-home",
      "--home-dir",
      checkPath(user.home),
      "--shell",
      checkPath(user.shell),
      "--comment",
      user.comment,
      "--",
      checkAccountName(user.name),
    ]);
  }

  userdel(name: string) {
    this.run(["userdel", "--", checkAccountName(name)]);
  }

  lstat(path: string) {
    return fileInfo(checkPath(path));
  }

  mkdir(path: string, mode: number) {
    try {
      mkdirSync(checkPath(path), { mode });
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      if (fileInfo(path)?.type !== "dir") throw new Error(`${path} exists and is not a directory`);
    }
  }

  chown(path: string, uid: number, gid: number) {
    lchownSync(checkPath(path), checkId(uid), checkId(gid));
  }

  chmod(path: string, mode: number) {
    const info = fileInfo(checkPath(path));
    if (!info) throw new Error(`${path} does not exist`);
    if (info.type === "symlink") throw new Error(`${path} is a symlink; refusing to chmod what it points at`);
    chmodSync(path, mode);
  }

  symlink(target: string, path: string) {
    const temp = tempPath(checkPath(path));
    removeQuietly(temp);
    symlinkSync(target, temp);
    renameSync(temp, path);
    fsyncDir(dirname(path));
  }

  readlink(path: string) {
    try {
      return readlinkSync(checkPath(path));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT" || code === "EINVAL") return null;
      throw err;
    }
  }

  writeFile(path: string, content: string, owner: { uid: number; gid: number; mode: number }) {
    const temp = tempPath(checkPath(path));
    removeQuietly(temp);
    // O_CREAT|O_EXCL (wx) refuses a planted symlink or a pre-existing temp.
    const fd = openSync(temp, "wx", 0o600);
    try {
      fchownSync(fd, checkId(owner.uid), checkId(owner.gid));
      fchmodSync(fd, owner.mode);
      const bytes = Buffer.from(content);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      removeQuietly(temp); // Leave no half-written temp behind (e.g. ENOSPC).
      throw err;
    }
    closeSync(fd);
    try {
      renameSync(temp, path);
    } catch (err) {
      removeQuietly(temp);
      throw err;
    }
    fsyncDir(dirname(path));
  }

  copyFile(from: string, to: string, owner: { uid: number; gid: number; mode: number }) {
    const temp = tempPath(checkPath(to));
    removeQuietly(temp);
    // By fd from start to end: the source is opened once without following a link, and the temp is created
    // new (a planted symlink or file fails) and given its owner and mode before a byte is written.
    let src: number;
    try {
      src = openUntrusted(checkPath(from));
    } catch (err) {
      if (err instanceof IngestError) throw new Error(`${from} is not a regular file: ${err.message}`);
      throw err;
    }
    try {
      const st = fstatSync(src);
      if (!st.isFile()) throw new Error(`${from} is not a regular file`);
      const dst = openSync(temp, CREATE_NEW, 0o600);
      try {
        fchownSync(dst, checkId(owner.uid), checkId(owner.gid));
        fchmodSync(dst, owner.mode);
        copyBytes(src, dst, st.size, from);
        fsyncSync(dst);
      } catch (err) {
        closeSync(dst);
        removeQuietly(temp); // A partial copy (e.g. ENOSPC) is never left behind.
        throw err;
      }
      closeSync(dst);
    } finally {
      closeSync(src);
    }
    try {
      renameSync(temp, to);
    } catch (err) {
      removeQuietly(temp);
      throw err;
    }
    fsyncDir(dirname(to));
  }

  ingestFile(from: string, to: string, options: IngestOptions) {
    return ingestByFd(checkPath(from), checkPath(to), options, { uidOf: (st) => st.uid, chown: true });
  }

  unlink(path: string) {
    removeQuietly(checkPath(path));
  }

  readFile(path: string) {
    try {
      return readFileSync(checkPath(path), "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
  }

  readdir(path: string) {
    return listDir(checkPath(path));
  }

  freeBytes(path: string) {
    const st = statfsSync(checkPath(path));
    return Number(st.bavail) * Number(st.bsize);
  }

  rename(from: string, to: string) {
    renameSync(checkPath(from), checkPath(to));
    fsyncDir(dirname(to));
  }

  remove(path: string) {
    // rmSync never follows symlinks; it removes the link.
    rmSync(checkPath(path), { recursive: true, force: true });
  }

  findOwned(root: string, id: number, exclude: string[]) {
    const prune = exclude.flatMap((p, i) => (i === 0 ? ["-path", checkPath(p)] : ["-o", "-path", checkPath(p)]));
    const args = ["find", checkPath(root)];
    if (prune.length) args.push("(", ...prune, ")", "-prune", "-o");
    args.push("(", "-uid", String(checkId(id)), "-o", "-gid", String(id), ")", "-print", "-quit");
    const { stdout } = this.run(args);
    const first = stdout.split("\n")[0];
    return first ? first : null;
  }

  processesOf(uid: number) {
    checkId(uid);
    const pids: number[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let status: string;
      try {
        status = readFileSync(`/proc/${entry}/status`, "utf8");
      } catch {
        continue; // exited meanwhile
      }
      const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
      if (ids && ids.slice(1).some((v) => Number(v) === uid)) pids.push(Number(entry));
    }
    return pids;
  }
}
