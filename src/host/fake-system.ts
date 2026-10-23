// A HostSystem for tests that cannot be root: files and directories are real
// (under a temp root), but owners and modes are recorded in memory, and users
// and groups live in maps. It can crash on purpose before any change, to test
// that provisioning resumes from every point.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { checkAccountName, listDir, SystemCommandError, type FileInfo, type GroupEntry, type HostSystem, type NewUser, type PasswdEntry, type PinnedFile } from "./system.ts";

export class SimulatedCrash extends Error {
  constructor(readonly op: string) {
    super(`simulated crash before ${op}`);
    this.name = "SimulatedCrash";
  }
}

export class FakeSystem implements HostSystem {
  readonly users = new Map<string, PasswdEntry>();
  readonly groups = new Map<string, GroupEntry>();
  /** Owner and mode of paths changed through this system; others read as root's, with their real mode. */
  readonly meta = new Map<string, { uid: number; gid: number; mode: number }>();
  readonly processes = new Map<number, number[]>();
  /** Every change made, in order, e.g. `mkdir /x/branches/b1`. */
  readonly log: string[] = [];
  /** Throw SimulatedCrash instead of making change number `crashAt` (0-based). */
  crashAt: number | null = null;
  /** What freeBytes reports. */
  free = 100 * 1024 ** 3;
  private changes = 0;
  private nextSystemGid = 999;

  /** How many changes have been made (or attempted, for the one that crashed). */
  get changeCount(): number {
    return this.changes;
  }

  private change(op: string) {
    if (this.crashAt !== null && this.changes === this.crashAt) {
      this.changes++;
      throw new SimulatedCrash(op);
    }
    this.changes++;
    this.log.push(op);
  }

  getpwnam(name: string) {
    return this.users.get(name) ?? null;
  }

  getpwuid(uid: number) {
    for (const user of this.users.values()) if (user.uid === uid) return user;
    return null;
  }

  getgrnam(name: string) {
    return this.groups.get(name) ?? null;
  }

  getgrgid(gid: number) {
    for (const group of this.groups.values()) if (group.gid === gid) return group;
    return null;
  }

  groupadd(name: string, gid?: number) {
    checkAccountName(name);
    this.change(`groupadd ${name} ${gid ?? ""}`.trim());
    if (this.groups.has(name)) throw new SystemCommandError(["groupadd", name], 9, `groupadd: group '${name}' already exists`);
    if (gid !== undefined && this.getgrgid(gid)) throw new SystemCommandError(["groupadd", name], 4, `groupadd: GID '${gid}' already exists`);
    this.groups.set(name, { name, gid: gid ?? this.nextSystemGid--, members: [] });
  }

  groupdel(name: string) {
    this.change(`groupdel ${name}`);
    if (!this.groups.delete(name)) throw new SystemCommandError(["groupdel", name], 6, `groupdel: group '${name}' does not exist`);
  }

  useradd(user: NewUser) {
    checkAccountName(user.name);
    this.change(`useradd ${user.name} ${user.uid}`);
    if (this.users.has(user.name)) throw new SystemCommandError(["useradd", user.name], 9, `useradd: user '${user.name}' already exists`);
    if (this.getpwuid(user.uid)) throw new SystemCommandError(["useradd", user.name], 4, `useradd: UID ${user.uid} is not unique`);
    if (!this.getgrgid(user.gid)) throw new SystemCommandError(["useradd", user.name], 6, `useradd: group '${user.gid}' does not exist`);
    this.users.set(user.name, { name: user.name, uid: user.uid, gid: user.gid, gecos: user.comment, home: user.home, shell: user.shell });
  }

  userdel(name: string) {
    this.change(`userdel ${name}`);
    const user = this.users.get(name);
    if (!user) throw new SystemCommandError(["userdel", name], 6, `userdel: user '${name}' does not exist`);
    if (this.processesOf(user.uid).length) throw new SystemCommandError(["userdel", name], 8, `userdel: user ${name} is currently used by a process`);
    this.users.delete(name);
    // USERGROUPS_ENAB: the user's private group goes with it.
    const group = this.groups.get(name);
    if (group && group.gid === user.gid && group.members.length === 0) this.groups.delete(name);
  }

  lstat(path: string): FileInfo | null {
    let st;
    try {
      st = lstatSync(path);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return null;
      throw err;
    }
    const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    const meta = this.meta.get(path);
    return { type, uid: meta?.uid ?? 0, gid: meta?.gid ?? 0, mode: meta?.mode ?? st.mode & 0o7777, size: st.size, mtimeMs: st.mtimeMs };
  }

  openPinned(path: string): PinnedFile | null {
    const info = this.lstat(path);
    if (!info) return null;
    if (info.type === "symlink") throw new Error(`${path} is a symlink; refusing to open it`);
    // No TOCTOU to simulate on a single-threaded fake: the real file under the
    // temp root is handed back by its own path, with the recorded owner.
    return { path, info, close: () => {} };
  }

  mkdir(path: string, mode: number) {
    this.change(`mkdir ${path}`);
    try {
      mkdirSync(path, { mode: 0o700 });
      this.meta.set(path, { uid: 0, gid: 0, mode });
    } catch (err) {
      if ((err as { code?: string }).code !== "EEXIST") throw err;
      if (this.lstat(path)?.type !== "dir") throw new Error(`${path} exists and is not a directory`);
    }
  }

  chown(path: string, uid: number, gid: number) {
    this.change(`chown ${path} ${uid}:${gid}`);
    const info = this.lstat(path);
    if (!info) throw new Error(`ENOENT: chown ${path}`);
    this.meta.set(path, { uid, gid, mode: info.mode });
  }

  chmod(path: string, mode: number) {
    this.change(`chmod ${path} ${mode.toString(8)}`);
    const info = this.lstat(path);
    if (!info) throw new Error(`ENOENT: chmod ${path}`);
    if (info.type === "symlink") throw new Error(`${path} is a symlink; refusing to chmod what it points at`);
    this.meta.set(path, { uid: info.uid, gid: info.gid, mode });
  }

  symlink(target: string, path: string) {
    this.change(`symlink ${path} -> ${target}`);
    const temp = join(dirname(path), `.${basename(path)}.tmp`);
    rmSync(temp, { force: true });
    symlinkSync(target, temp);
    renameSync(temp, path);
    this.meta.delete(path);
  }

  readlink(path: string) {
    try {
      return readlinkSync(path);
    } catch {
      return null;
    }
  }

  writeFile(path: string, content: string, owner: { uid: number; gid: number; mode: number }) {
    this.change(`write ${path}`);
    const temp = join(dirname(path), `.${basename(path)}.tmp`);
    try {
      writeFileSync(temp, content, { mode: 0o600 });
      renameSync(temp, path);
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
    this.meta.set(path, { ...owner });
  }

  copyFile(from: string, to: string, owner: { uid: number; gid: number; mode: number }) {
    this.change(`copy ${from} ${to}`);
    if (this.lstat(from)?.type !== "file") throw new Error(`${from} is not a regular file`);
    const temp = join(dirname(to), `.${basename(to)}.tmp`);
    try {
      copyFileSync(from, temp);
      renameSync(temp, to);
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
    this.meta.set(to, { ...owner });
  }

  readFile(path: string) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  readdir(path: string) {
    return listDir(path);
  }

  freeBytes(_path: string) {
    return this.free;
  }

  rename(from: string, to: string) {
    this.change(`rename ${from} ${to}`);
    renameSync(from, to);
    for (const [path, meta] of [...this.meta]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.meta.delete(path);
        this.meta.set(to + path.slice(from.length), meta);
      }
    }
  }

  remove(path: string) {
    this.change(`remove ${path}`);
    try {
      if (lstatSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
      else unlinkSync(path);
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    for (const key of [...this.meta.keys()]) if (key === path || key.startsWith(`${path}/`)) this.meta.delete(key);
  }

  findOwned(root: string, id: number, exclude: string[]) {
    const skip = new Set(exclude);
    const walk = (path: string): string | null => {
      if (skip.has(path)) return null;
      const info = this.lstat(path);
      if (!info) return null;
      if (info.uid === id || info.gid === id) return path;
      if (info.type !== "dir") return null;
      for (const name of readdirSync(path).sort()) {
        const found = walk(join(path, name));
        if (found) return found;
      }
      return null;
    };
    return walk(root);
  }

  processesOf(uid: number) {
    return this.processes.get(uid) ?? [];
  }

  /** Records `path` (which must exist) as owned by `uid:gid`, without counting it as a change. */
  own(path: string, uid: number, gid: number, mode?: number) {
    const info = this.lstat(path);
    if (!info) throw new Error(`ENOENT: ${path}`);
    this.meta.set(path, { uid, gid, mode: mode ?? info.mode });
  }
}
