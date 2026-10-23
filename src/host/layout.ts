// Where the host keeps everything (design section 6), with the owner, group
// and mode of every path. All paths derive from one root (default
// /var/lib/incibase), so several isolated hosts can share a test machine.
//
//   <root>/                       root 0755
//     control/                    root 0700   registry.db*, LOCK, env/<id>.env 0600
//     admin/                      root:<admin group> 0750   index.json, <label>.sock -> ../branches/<id>/run/admin/admin.sock
//     hosts/                      root:<proxy group> 0750   <label> -> ../branches/<id>/run/http
//     branches/                   root 0711
//       <id>/                     root 0711   the unit's cwd; service-keys.json root:ib-<id> 0640
//         data/                   ib-<id> 0700
//         releases/               root:ib-<id> 0750   <seq>/app.ib root:ib-<id> 0640
//         preflight/              ib-<id> 0700
//         snapshot/               ib-<id> 0700   the snapshot unit's staging file
//         run/                    root 0711
//           http/                 ib-<id>:<proxy group> 2750
//           admin/                ib-<id>:<admin group> 2750
//     backups/                    root 0700   <id>/pre-<seq>.db 0600
//     trash/                      root 0700
//
// Outside the root: the runtimes (`<runtime root>/<version>/incibase`, root
// 0755, recorded with their sha256 in the registry), the CLI link
// (`/usr/local/bin/incibase` -> one of them, `host use-cli`) and the
// systemd units (design section 5.4), named after a unit prefix:
// `incibase-branch@.service`, `incibase-preflight@.service`,
// `incibase-snapshot@.service`, `incibase.slice`, per-branch drop-ins and the transient
// `incibase-release-<id>-<seq>` jobs. A test host picks its own prefix, so
// hosts sharing a machine never touch each other's units.
import { isAbsolute, join, normalize, relative } from "node:path";
import { branchUser, checkBranchId, checkLabel, NameError } from "./names.ts";

export const DEFAULT_ROOT = "/var/lib/incibase";
export const DEFAULT_RUNTIME_ROOT = "/usr/local/lib/incibase";
export const DEFAULT_SYSTEMD_DIR = "/etc/systemd/system";
/** The `incibase` on PATH; `host use-cli` points it at an installed runtime. */
export const DEFAULT_CLI_LINK = "/usr/local/bin/incibase";
export const DEFAULT_UNIT_PREFIX = "incibase";
export const DEFAULT_GROUPS = { proxy: "incibase-proxy", admin: "incibase-admin" } as const;
/** Runtime versions as `incibase --version` prints them; they name directories. */
export const RUNTIME_VERSION_REGEX = /^\d{1,4}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.]{1,40})?$/;
/** A unit prefix: what `incibase` is in the unit names; lowercase words joined by single hyphens. */
const UNIT_PREFIX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Who owns a path: root, or a branch's own user (and group). */
export type Principal = "root" | "branch";

export interface PathSpec {
  path: string;
  type: "dir" | "file" | "symlink";
  owner: Principal;
  /** A host group name, "root", or "branch" for the branch's own group. */
  group: string;
  mode: number;
}

export interface LayoutOptions {
  root?: string;
  runtimeRoot?: string;
  groups?: { proxy: string; admin: string };
  /** Where unit files go (default /etc/systemd/system). */
  systemdDir?: string;
  /** What unit names start with (default `incibase`). */
  unitPrefix?: string;
  /** The `incibase` command `host use-cli` points at a runtime (default /usr/local/bin/incibase). */
  cliLink?: string;
}

/** The layout options a host keeps in its registry, so every later command (and job) builds the same layout. */
export interface SavedLayout {
  runtimeRoot: string;
  systemdDir: string;
  unitPrefix: string;
  groups: { proxy: string; admin: string };
  /** Only when it is not the default, so layouts saved before it existed still compare equal. */
  cliLink?: string;
}

export function checkRuntimeVersion(value: unknown): string {
  if (typeof value !== "string" || !RUNTIME_VERSION_REGEX.test(value)) {
    throw new NameError(`Invalid runtime version ${JSON.stringify(value)}: expected a version such as 0.3.1`);
  }
  return value;
}

export function checkUnitPrefix(value: unknown): string {
  if (typeof value !== "string" || value.length > 32 || !UNIT_PREFIX.test(value)) {
    throw new NameError(`Invalid unit prefix ${JSON.stringify(value)}: lowercase letters, digits and single hyphens, at most 32`);
  }
  return value;
}

const GROUP_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
/** Snapshot names: `pre-<seq>` before a release, `pre-upgrade-<n>` before a runtime upgrade. */
export const SNAPSHOT_NAME = /^pre-(?:\d{1,9}|upgrade-\d{1,15})$/;

function checkRoot(root: string, what: string): string {
  if (!isAbsolute(root) || normalize(root) !== root || root === "/" || root.endsWith("/") || /[\s:]/.test(root)) {
    throw new NameError(`${what} must be an absolute, normalized path other than "/", got ${JSON.stringify(root)}`);
  }
  return root;
}

export interface BranchPaths {
  dir: string;
  serviceKeys: string;
  data: string;
  releases: string;
  preflight: string;
  /** Where the snapshot unit (as the branch) writes its copy for root to take in. */
  snapshot: string;
  /** The staging file in it: `snapshot/snapshot.db`. */
  snapshotFile: string;
  run: string;
  runHttp: string;
  httpSock: string;
  runAdmin: string;
  adminSock: string;
  envFile: string;
  backups: string;
}

/** The systemd names of a host: units, and where their files go. */
export interface UnitNames {
  prefix: string;
  slice: string;
  branchTemplate: string;
  preflightTemplate: string;
  snapshotTemplate: string;
  /** `<prefix>-branch@<id>.service`. */
  branch(id: string): string;
  preflight(id: string): string;
  /** `<prefix>-snapshot@<id>.service`: `VACUUM INTO` as the branch, in its sandbox. */
  snapshot(id: string): string;
  /** `<prefix>-check.service`, the health check `<prefix>-check.timer` runs every 30 s. */
  checkService: string;
  checkTimer: string;
  /** A transient job, e.g. `<prefix>-release-<id>-<seq>.service`. */
  job(kind: "release" | "rollback" | "upgrade" | "restore", id: string, n: number): string;
}

export class HostLayout {
  readonly root: string;
  readonly runtimeRoot: string;
  readonly groups: { proxy: string; admin: string };
  readonly control: string;
  readonly registry: string;
  readonly lock: string;
  readonly envDir: string;
  readonly admin: string;
  readonly adminIndex: string;
  readonly hosts: string;
  readonly branches: string;
  readonly backups: string;
  readonly trash: string;
  readonly ballast: string;
  /** The check's per-branch counters (consecutive failed probes, failure episodes), root 0600. */
  readonly checkState: string;
  /** Held by a running `host check`, so a manual run never overlaps the timer's. */
  readonly checkLock: string;
  readonly systemdDir: string;
  readonly cliLink: string;
  readonly units: UnitNames;

  constructor(options: LayoutOptions = {}) {
    this.root = checkRoot(options.root ?? DEFAULT_ROOT, "The host root");
    this.runtimeRoot = checkRoot(options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, "The runtime root");
    this.systemdDir = checkRoot(options.systemdDir ?? DEFAULT_SYSTEMD_DIR, "The systemd unit directory");
    this.cliLink = checkRoot(options.cliLink ?? DEFAULT_CLI_LINK, "The CLI link");
    const prefix = checkUnitPrefix(options.unitPrefix ?? DEFAULT_UNIT_PREFIX);
    this.units = {
      prefix,
      slice: `${prefix}.slice`,
      branchTemplate: `${prefix}-branch@.service`,
      preflightTemplate: `${prefix}-preflight@.service`,
      snapshotTemplate: `${prefix}-snapshot@.service`,
      checkService: `${prefix}-check.service`,
      checkTimer: `${prefix}-check.timer`,
      branch: (id) => `${prefix}-branch@${checkBranchId(id)}.service`,
      preflight: (id) => `${prefix}-preflight@${checkBranchId(id)}.service`,
      snapshot: (id) => `${prefix}-snapshot@${checkBranchId(id)}.service`,
      job: (kind, id, n) => {
        if (!Number.isSafeInteger(n) || n < 0) throw new NameError(`Invalid job number ${n}`);
        return `${prefix}-${kind}-${checkBranchId(id)}-${n}.service`;
      },
    };
    const groups = options.groups ?? DEFAULT_GROUPS;
    for (const name of [groups.proxy, groups.admin]) {
      if (!GROUP_NAME.test(name)) throw new NameError(`Invalid group name ${JSON.stringify(name)}`);
    }
    if (groups.proxy === groups.admin) throw new NameError("The proxy and admin groups must differ");
    this.groups = { proxy: groups.proxy, admin: groups.admin };
    this.control = join(this.root, "control");
    this.registry = join(this.control, "registry.db");
    this.lock = join(this.control, "LOCK");
    this.envDir = join(this.control, "env");
    this.admin = join(this.root, "admin");
    this.adminIndex = join(this.admin, "index.json");
    this.hosts = join(this.root, "hosts");
    this.branches = join(this.root, "branches");
    this.backups = join(this.root, "backups");
    this.trash = join(this.root, "trash");
    this.ballast = join(this.root, "ballast");
    this.checkState = join(this.control, "check-state.json");
    this.checkLock = join(this.control, "check.lock");
  }

  /** What the registry keeps so later commands rebuild this layout from the root alone. */
  saved(): SavedLayout {
    return {
      runtimeRoot: this.runtimeRoot,
      systemdDir: this.systemdDir,
      unitPrefix: this.units.prefix,
      groups: { ...this.groups },
      ...(this.cliLink === DEFAULT_CLI_LINK ? {} : { cliLink: this.cliLink }),
    };
  }

  /** `<runtime root>/<version>/incibase`. */
  runtimeDir(version: string): string {
    return join(this.runtimeRoot, checkRuntimeVersion(version));
  }

  runtimeBinary(version: string): string {
    return join(this.runtimeDir(version), "incibase");
  }

  /** A unit file in the systemd directory. */
  unitFile(name: string): string {
    return join(this.systemdDir, name);
  }

  /** The drop-in incibase renders for one instance, e.g. `incibase-branch@<id>.service.d/10-incibase.conf`. */
  dropIn(unit: string): string {
    return join(this.systemdDir, `${unit}.d`, "10-incibase.conf");
  }

  /** What `systemctl enable` would create for a branch: started at boot. */
  wantsLink(id: string): { path: string; target: string } {
    return {
      path: join(this.systemdDir, "multi-user.target.wants", this.units.branch(id)),
      target: join(this.systemdDir, this.units.branchTemplate),
    };
  }

  /** What `systemctl enable` makes for the check timer: started at boot. */
  timerWantsLink(): { path: string; target: string } {
    return { path: join(this.systemdDir, "timers.target.wants", this.units.checkTimer), target: join(this.systemdDir, this.units.checkTimer) };
  }

  releaseDir(id: string, seq: number): string {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new NameError(`Invalid release number ${seq}`);
    return join(this.branch(id).releases, String(seq));
  }

  releaseFile(id: string, seq: number): string {
    return join(this.releaseDir(id, seq), "app.ib");
  }

  /** `backups/<id>/<name>.db`, a snapshot such as `pre-7`. */
  snapshot(id: string, name: string): string {
    if (!SNAPSHOT_NAME.test(name)) throw new NameError(`Invalid snapshot name ${JSON.stringify(name)}: expected e.g. pre-7`);
    return join(this.branch(id).backups, `${name}.db`);
  }

  /** The directories every host has, in creation order. */
  hostTree(): PathSpec[] {
    const dir = (path: string, group: string, mode: number): PathSpec => ({ path, type: "dir", owner: "root", group, mode });
    return [
      dir(this.root, "root", 0o755),
      dir(this.control, "root", 0o700),
      dir(this.envDir, "root", 0o700),
      dir(this.admin, this.groups.admin, 0o750),
      dir(this.hosts, this.groups.proxy, 0o750),
      dir(this.branches, "root", 0o711),
      dir(this.backups, "root", 0o700),
      dir(this.trash, "root", 0o700),
    ];
  }

  branch(id: string): BranchPaths {
    const dir = join(this.branches, checkBranchId(id));
    const run = join(dir, "run");
    const runHttp = join(run, "http");
    const runAdmin = join(run, "admin");
    return {
      dir,
      serviceKeys: join(dir, "service-keys.json"),
      data: join(dir, "data"),
      releases: join(dir, "releases"),
      preflight: join(dir, "preflight"),
      snapshot: join(dir, "snapshot"),
      snapshotFile: join(dir, "snapshot", "snapshot.db"),
      run,
      runHttp,
      httpSock: join(runHttp, "http.sock"),
      runAdmin,
      adminSock: join(runAdmin, "admin.sock"),
      envFile: join(this.envDir, `${id}.env`),
      backups: join(this.backups, id),
    };
  }

  /** A branch's directories, in creation order (parents first). */
  branchTree(id: string): PathSpec[] {
    const b = this.branch(id);
    const spec = (path: string, owner: Principal, group: string, mode: number): PathSpec => ({ path, type: "dir", owner, group, mode });
    return [
      spec(b.dir, "root", "root", 0o711),
      spec(b.data, "branch", "branch", 0o700),
      spec(b.releases, "root", "branch", 0o750),
      spec(b.preflight, "branch", "branch", 0o700),
      spec(b.snapshot, "branch", "branch", 0o700),
      spec(b.run, "root", "root", 0o711),
      // setgid: the sockets serve creates inherit the group, and with its chmod 0770 only that group may connect.
      spec(b.runHttp, "branch", this.groups.proxy, 0o2750),
      spec(b.runAdmin, "branch", this.groups.admin, 0o2750),
    ];
  }

  /** The files a branch's provisioning writes. */
  branchFiles(id: string): PathSpec[] {
    const b = this.branch(id);
    return [
      { path: b.serviceKeys, type: "file", owner: "root", group: "branch", mode: 0o640 },
      { path: b.envFile, type: "file", owner: "root", group: "root", mode: 0o600 },
    ];
  }

  /** `hosts/<label>`, the directory nginx proxies `<label>.<domain>` to. */
  hostLink(label: string): string {
    return join(this.hosts, checkLabel(label));
  }

  /** `admin/<label>.sock`, what `incibase tunnel` forwards to. */
  adminLink(label: string): string {
    return join(this.admin, `${checkLabel(label)}.sock`);
  }

  /** The links that route to a branch: path, and the relative target it must point at. */
  branchLinks(id: string, label: string): { path: string; target: string }[] {
    const b = this.branch(id);
    return [
      { path: this.hostLink(label), target: relative(this.hosts, b.runHttp) },
      { path: this.adminLink(label), target: relative(this.admin, b.adminSock) },
    ];
  }

  /** A trash entry for a deleted branch's directory. */
  trashEntry(id: string, at: number): string {
    return join(this.trash, `${checkBranchId(id)}-${Math.trunc(at)}`);
  }

  /** The OS user of a branch. */
  user(id: string): string {
    return branchUser(id);
  }

  /** Whether `path` is the root or inside it (no `..` games). */
  contains(path: string): boolean {
    const rel = relative(this.root, normalize(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }
}
