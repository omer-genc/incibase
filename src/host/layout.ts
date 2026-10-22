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
//         run/                    root 0711
//           http/                 ib-<id>:<proxy group> 2750
//           admin/                ib-<id>:<admin group> 2750
//     backups/                    root 0700   <id>/pre-<seq>.db 0600
//     trash/                      root 0700
import { isAbsolute, join, normalize, relative } from "node:path";
import { branchUser, checkBranchId, checkLabel, NameError } from "./names.ts";

export const DEFAULT_ROOT = "/var/lib/incibase";
export const DEFAULT_RUNTIME_ROOT = "/usr/local/lib/incibase";
export const DEFAULT_GROUPS = { proxy: "incibase-proxy", admin: "incibase-admin" } as const;

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
}

const GROUP_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;

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
  run: string;
  runHttp: string;
  httpSock: string;
  runAdmin: string;
  adminSock: string;
  envFile: string;
  backups: string;
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

  constructor(options: LayoutOptions = {}) {
    this.root = checkRoot(options.root ?? DEFAULT_ROOT, "The host root");
    this.runtimeRoot = checkRoot(options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, "The runtime root");
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
