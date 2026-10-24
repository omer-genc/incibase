// Files rendered from the registry (design section 5.4): the env file,
// service-keys.json, admin/index.json and the systemd units: the templates
// `incibase-branch@.service`, `incibase-preflight@.service` and
// `incibase-snapshot@.service`, `incibase.slice` and each branch's drop-ins. The text builders here are pure; the writers
// write a file atomically (temp file, fsync, rename, via HostSystem) and only
// when its content, owner or mode differ, and say whether a unit file changed,
// so the caller runs `systemctl daemon-reload` once, and only then. The
// host's own units (the templates, the slice and the check timer's two) name
// the host root they belong to (ownerRecord), so `host init` of another root
// refuses them: one machine runs one host.
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { VERSION } from "../engine/version.ts";
import type { BranchConfig, ResolvedLimits } from "./config.ts";
import { authConcurrency, drainMs, durationText, parseConfig, parseLimits, resolveLimits, stopTimeoutSec, systemdSize, timeoutsFlag } from "./config.ts";
import { RUNTIME_VERSION_REGEX, type HostLayout } from "./layout.ts";
import { branchUser, checkDomain, checkEnvName, checkLabel } from "./names.ts";
import type { HostContext } from "./provision.ts";
import type { BranchRow, EnvRow, ReleaseRow, ServiceKeyRow } from "./registry.ts";
import type { FileInfo, HostSystem } from "./system.ts";

/** Values systemd reads the same unquoted: no spaces, quotes, backslashes or comment marks. */
const PLAIN_VALUE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/**
 * One value for a systemd EnvironmentFile. Inside double quotes systemd
 * turns `\"` and `\\` into `"` and `\`, keeps `$` and newlines as they are,
 * and strips nothing (verified on systemd 255).
 */
export function quoteEnvValue(value: string): string {
  if (value.includes("\0")) throw new Error("An environment value cannot contain a NUL character");
  if (PLAIN_VALUE.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** An EnvironmentFile: one `NAME=value` per entry, later entries win. */
export function envFileContent(entries: [name: string, value: string][]): string {
  let out = "# Rendered by incibase from control/registry.db; changes here are overwritten.\n";
  for (const [name, value] of entries) out += `${checkEnvName(name)}=${quoteEnvValue(value)}\n`;
  return out;
}

/** The env a branch process gets: the registry's rows (system ones first), then what the host derives. */
export function branchEnv(rows: EnvRow[], derived: Record<string, string>): [string, string][] {
  const sorted = [...rows].sort((a, b) => b.system - a.system || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries: [string, string][] = sorted.filter((r) => !(r.name in derived)).map((r) => [r.name, r.value]);
  for (const [name, value] of Object.entries(derived)) entries.push([name, value]);
  return entries;
}

/** `INCIBASE_SERVICE_KEYS_FILE` for serve: sha256 and scopes of the keys not revoked. */
export function serviceKeysContent(rows: ServiceKeyRow[]): string {
  const keys = rows
    .filter((r) => r.revoked_at === null)
    .map((r) => ({ id: r.id, sha256: r.sha256, scopes: r.scopes.split(",").filter(Boolean), label: r.label }));
  return `${JSON.stringify(keys, null, 2)}\n`;
}

/**
 * `admin/index.json`, what `incibase tunnel` reads over SSH to find a
 * branch's admin socket and its fixed laptop port. Ready branches only.
 */
export function adminIndexContent(branches: BranchRow[], domain: string | null): string {
  const index: Record<string, { label: string; socket: string; port: number; kind: string; url: string | null }> = {};
  for (const b of [...branches].sort((x, y) => x.label.localeCompare(y.label))) {
    if (b.phase !== "ready") continue;
    index[`${b.project}/${b.name}`] = {
      label: b.label,
      socket: `${b.label}.sock`,
      port: b.tunnel_port,
      kind: b.kind,
      url: domain ? `https://${b.label}.${domain}` : null,
    };
  }
  return `${JSON.stringify(index, null, 2)}\n`;
}

// ---- systemd units ---------------------------------------------------------

const HEADER = "# Rendered by incibase from control/registry.db; changes here are overwritten.\n";
/** What an owner record says: `# host root: <root>`. */
const OWNER_RECORD = /^# host root: (\/[A-Za-z0-9_./:=,@+-]*)$/;

/**
 * The owner record of a file every host of a layout would write in the same
 * place (its units, the nginx front door): the host root it belongs to. One
 * machine runs one host, and `host init` of another root refuses a file
 * that names someone else (ops.checkMachineOwner).
 */
export function ownerRecord(layout: HostLayout): string {
  return `# host root: ${word(layout.root)}\n`;
}

/** The host root a rendered file's leading comments name; null when they name none (or not readably). */
export function recordedRoot(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("#")) break;
    const match = OWNER_RECORD.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

/** The header of a host unit: rendered, and whose. */
const hostHeader = (layout: HostLayout) => `${HEADER}${ownerRecord(layout)}`;
/**
 * Network the sandbox denies: loopback, private ranges (IPv4 and IPv6
 * unique-local), the shared/CGNAT range an overlay such as Tailscale uses,
 * and link-local (cloud metadata); the DNS stub stays reachable.
 */
export const IP_ADDRESS_DENY = "localhost 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 fc00::/7 fe80::/10";
export const IP_ADDRESS_ALLOW = "127.0.0.53/32";
/** Set for every branch process: no home, no colors, no transpiler cache outside the data dir. */
const BRANCH_ENVIRONMENT = "HOME=/nonexistent NO_COLOR=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0";
/** Ubuntu's nginx log directory (nginx.ts DEFAULT_NGINX.logDir), hidden from branches. */
const NGINX_LOG_DIR = "/var/log/nginx";
/** Characters a value may have to go into a unit file unquoted: systemd expands `%` and `$`, splits on spaces. */
const UNIT_WORD = /^[A-Za-z0-9_./:=,@+-]+$/;

function word(value: string): string {
  if (!UNIT_WORD.test(value)) throw new Error(`Refusing to write ${JSON.stringify(value)} into a unit file`);
  return value;
}

/** `<base>/%i<rest>`: a path of the unit's instance, `base` checked. */
function instancePath(base: string, rest = ""): string {
  if (rest && !UNIT_WORD.test(rest)) throw new Error(`Refusing to write ${JSON.stringify(rest)} into a unit file`);
  return `${word(base)}/%i${rest}`;
}

/**
 * The sandbox both a branch and its preflight run in (design sections 4.1
 * and 5.4). `writable` (already checked) are the only paths it may write.
 */
function sandbox(layout: HostLayout, writable: string[]): string {
  return [
    "UMask=0007",
    // An empty /tmp per process; mode 1777 so the branch user can use it (a bare tmpfs is root 0755).
    "TemporaryFileSystem=/tmp:size=64M,mode=1777",
    "SocketBindDeny=any",
    `IPAddressDeny=${IP_ADDRESS_DENY}`,
    `IPAddressAllow=${IP_ADDRESS_ALLOW}`,
    "ProtectSystem=strict",
    `ReadWritePaths=${writable.join(" ")}`,
    `InaccessiblePaths=-${word(layout.control)} -${word(layout.trash)} -${word(layout.backups)}`,
    // nginx's logs hold every tenant's requests (nginx.ts creates its own 0640; this covers the rest).
    `InaccessiblePaths=-${NGINX_LOG_DIR}`,
    "ProtectHome=yes",
    "PrivateDevices=yes",
    "ProtectProc=invisible",
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "RestrictNamespaces=yes",
  ].join("\n");
}

/** `incibase-branch@.service`: what every branch shares. The per-branch drop-in adds the user, command and limits. */
export function branchTemplateUnit(layout: HostLayout): string {
  const writable = ["/data", "/run/http", "/run/admin"].map((rest) => instancePath(layout.branches, rest));
  return `${hostHeader(layout)}[Unit]
Description=incibase branch %i
Wants=network-online.target
After=network-online.target
RequiresMountsFor=${word(layout.root)}
StartLimitIntervalSec=120
StartLimitBurst=8

[Service]
Type=exec
Slice=${layout.units.slice}
WorkingDirectory=${instancePath(layout.branches)}
EnvironmentFile=${instancePath(layout.envDir, ".env")}
Environment=${BRANCH_ENVIRONMENT}
Restart=on-failure
RestartSec=2
RestartPreventExitStatus=64 65 78
# A reload that comes before serve has its own SIGHUP handler (runtime start and imports, about 40 ms)
# ends the process by signal; systemd would take that as a clean exit and not restart it.
RestartForceExitStatus=SIGHUP
ExecReload=/bin/kill -HUP $MAINPID
TimeoutStopSec=25
${sandbox(layout, writable)}

[Install]
WantedBy=multi-user.target
`;
}

/** `incibase-preflight@.service`: the same sandbox, where only the branch's preflight dir is writable. */
export function preflightTemplateUnit(layout: HostLayout): string {
  return `${hostHeader(layout)}[Unit]
Description=incibase preflight %i
RequiresMountsFor=${word(layout.root)}

[Service]
Type=exec
Slice=${layout.units.slice}
WorkingDirectory=${instancePath(layout.branches)}
EnvironmentFile=${instancePath(layout.envDir, ".env")}
Environment=${BRANCH_ENVIRONMENT}
RestartForceExitStatus=SIGHUP
# A migration that runs this long is stopped (Result=timeout).
RuntimeMaxSec=900
${sandbox(layout, [instancePath(layout.branches, "/preflight")])}
`;
}

/** How long a snapshot may run before systemd stops it (Result=timeout); the job waits a little longer. */
export const SNAPSHOT_RUNTIME_MAX_SEC = 900;

/**
 * `incibase-snapshot@.service`: `incibase _snapshot` as the branch, in the
 * same sandbox (design section 3.2 D.3.1). Root never opens a branch's
 * database: this unit copies it with the branch's own rights into its
 * staging dir, so a symlink or a swapped file can only ever point it at what
 * the branch could read anyway. data/ is writable because SQLite's reader
 * maps data.db-shm; nothing else is. No EnvironmentFile: the copy needs no secret.
 */
export function snapshotTemplateUnit(layout: HostLayout): string {
  return `${hostHeader(layout)}[Unit]
Description=incibase snapshot %i
RequiresMountsFor=${word(layout.root)}

[Service]
Type=exec
Slice=${layout.units.slice}
WorkingDirectory=${instancePath(layout.branches)}
Environment=${BRANCH_ENVIRONMENT}
# A copy that runs this long is stopped (Result=timeout).
RuntimeMaxSec=${SNAPSHOT_RUNTIME_MAX_SEC}
${sandbox(layout, [instancePath(layout.branches, "/data"), instancePath(layout.branches, "/snapshot")])}
`;
}

/** `incibase.slice`: all branches together stay under this much memory. */
export function sliceUnit(layout: HostLayout, memoryMax: number | null): string {
  return `${hostHeader(layout)}[Unit]
Description=incibase branches

[Slice]
${memoryMax ? `MemoryMax=${systemdSize(memoryMax)}\n` : ""}`;
}

function limitLines(limits: ResolvedLimits, config: BranchConfig): string {
  return [
    `MemoryMax=${systemdSize(limits.memoryMax)}`,
    `MemoryHigh=${systemdSize(limits.memoryHigh)}`,
    "MemorySwapMax=0",
    `CPUQuota=${limits.cpuQuota}%`,
    `TasksMax=${limits.tasksMax}`,
    `TimeoutStopSec=${stopTimeoutSec(config)}`,
  ].join("\n");
}

export interface BranchUnitInput {
  layout: HostLayout;
  branch: BranchRow;
  domain: string;
  /** The release the branch runs, if any. */
  release: Pick<ReleaseRow, "seq" | "status" | "allow_field_removal"> | null;
}

/** The public URL of a branch: `https://<branch>--<project>.<domain>`. */
export function branchUrl(label: string, domain: string): string {
  return `https://${checkLabel(label)}.${checkDomain(domain)}`;
}

function serveCommand(layout: HostLayout, branch: BranchRow, domain: string, config: BranchConfig, flags: string[], paths: { bundle: string; data: string; socket: string; adminSocket: string }) {
  return [
    layout.runtimeBinary(branch.runtime_version),
    "serve",
    ...flags,
    "--bundle",
    paths.bundle,
    "--data",
    paths.data,
    "--socket",
    paths.socket,
    "--admin-socket",
    paths.adminSocket,
    "--url",
    branchUrl(branch.label, domain),
    "--log-format",
    "json",
    "--timeouts",
    timeoutsFlag(config),
    "--drain-timeout",
    durationText(drainMs(config)),
  ]
    .map(word)
    .join(" ");
}

/**
 * `incibase-branch@<id>.service.d/10-incibase.conf`: the branch's user, its
 * command (the pinned runtime serving its release) with INCIBASE_GENERATION,
 * and its limits. Without a release there is no ExecStart, so the unit cannot
 * start. `--allow-field-removal` stays only until the release is live.
 */
export function branchDropIn(input: BranchUnitInput): string {
  const { layout, branch, domain, release } = input;
  const limits = resolveLimits(parseLimits(branch.limits_json));
  const config = parseConfig(branch.config_json);
  const paths = layout.branch(branch.id);
  const user = branchUser(branch.id);
  let exec = "";
  if (release) {
    const flags = release.allow_field_removal && release.status !== "live" ? ["--allow-field-removal"] : [];
    exec =
      "ExecStart=\n" +
      `ExecStart=${serveCommand(layout, branch, domain, config, flags, {
        bundle: layout.releaseFile(branch.id, release.seq),
        data: paths.data,
        socket: paths.httpSock,
        adminSocket: paths.adminSock,
      })}\n`;
  }
  const generation = branch.generation ? `Environment=INCIBASE_GENERATION=${word(branch.generation)}\n` : "";
  return `${HEADER}[Service]
User=${user}
Group=${user}
${exec}${generation}${limitLines(limits, config)}
`;
}

export interface PreflightUnitInput {
  layout: HostLayout;
  branch: BranchRow;
  domain: string;
  /** The release to try, and the runtime to try it with. */
  seq: number;
  runtimeVersion: string;
  /** The branch has no data yet: let serve --migrate-only create the database. */
  allowEmpty: boolean;
  allowFieldRemoval: boolean;
}

/** `incibase-preflight@<id>.service.d/10-incibase.conf`: `serve --migrate-only` on the copy in preflight/. */
export function preflightDropIn(input: PreflightUnitInput): string {
  const { layout, branch, domain } = input;
  const limits = resolveLimits(parseLimits(branch.limits_json));
  const config = parseConfig(branch.config_json);
  const dir = layout.branch(branch.id).preflight;
  const flags = ["--migrate-only", ...(input.allowEmpty ? ["--allow-empty"] : []), ...(input.allowFieldRemoval ? ["--allow-field-removal"] : [])];
  const command = serveCommand(layout, { ...branch, runtime_version: input.runtimeVersion }, domain, config, flags, {
    bundle: layout.releaseFile(branch.id, input.seq),
    data: dir,
    socket: `${dir}/http.sock`,
    adminSocket: `${dir}/admin.sock`,
  });
  const user = branchUser(branch.id);
  return `${HEADER}[Service]
User=${user}
Group=${user}
ExecStart=
ExecStart=${command}
${limitLines(limits, config)}
`;
}

/**
 * Installed runtime versions root can trust to run as a tenant, oldest first
 * (semver): the binary a root-owned regular file (lstat, so never a symlink),
 * world-executable and writable by no one else, in a root-owned version
 * directory and runtime root that no one else can write either, on a way
 * from / that only root controls (rootOnlyDir).
 */
export function trustedRuntimes(ctx: HostContext): string[] {
  const { sys, layout } = ctx;
  if (!rootOnlyPath(sys, layout.runtimeRoot, "dir") || rootOnlyDir(sys, dirname(layout.runtimeRoot))) return [];
  return sys
    .readdir(layout.runtimeRoot)
    .filter((v) => RUNTIME_VERSION_REGEX.test(v) && runtimeFilesRootOnly(sys, layout, v))
    .sort(Bun.semver.order);
}

/** `path` (lstat, so never a symlink) is a `type` of root's that no one else can write, with the `mustAllow` mode bits. */
function rootOnlyPath(sys: HostSystem, path: string, type: "dir" | "file", mustAllow = 0): boolean {
  const info = sys.lstat(path);
  return info?.type === type && info.uid === 0 && (info.mode & 0o022) === 0 && (info.mode & mustAllow) === mustAllow;
}

/**
 * The files of the runtime `version` as trustedRuntimes needs them, what is
 * above the runtime root aside: its binary, version directory and the
 * runtime root itself root's and writable by root alone, the binary
 * world-executable. What install-runtime puts back (installRuntime).
 */
export function runtimeFilesRootOnly(sys: HostSystem, layout: HostLayout, version: string): boolean {
  return (
    rootOnlyPath(sys, layout.runtimeRoot, "dir") &&
    rootOnlyPath(sys, layout.runtimeDir(version), "dir") &&
    rootOnlyPath(sys, layout.runtimeBinary(version), "file", 0o005)
  );
}

export interface HostRuntime {
  version: string;
  binary: string;
}

/**
 * The runtime the host runs its own code with as a tenant (`_snapshot` as
 * the branch, doctor's sandbox probe as nobody): the newer, by semver, of
 * this binary's VERSION and `pinned` (the branch's runtime) among the
 * trusted installed runtimes (trustedRuntimes). A runtime older than the
 * host's code may predate `_snapshot`, and one older than the branch's pin
 * may predate the SQLite that wrote its database, so the newer of the two is
 * the one to run. Without a pin (doctor), this VERSION if it is trusted,
 * else the newest trusted runtime. Null when there is none.
 */
export function hostRuntime(ctx: HostContext, pinned: string | null): HostRuntime | null {
  const trusted = trustedRuntimes(ctx);
  const version = trusted.filter((v) => v === VERSION || v === pinned).at(-1) ?? (pinned === null ? trusted.at(-1) : undefined);
  return version ? { version, binary: ctx.layout.runtimeBinary(version) } : null;
}

/** Links followed on the way to a path before giving up, as the kernel does (MAXSYMLINKS). */
const MAX_LINKS = 40;

/** A part of the way to a directory that root does not control alone: `why` completes "<path> …". */
export interface NotRootOnly {
  path: string;
  why: string;
}

/**
 * Whether root alone controls what the directory `dir` holds: every
 * directory on the way from /, through the links on the way, root's and
 * writable by no one else, since whoever can write one can rename what is
 * below it and put their own in its place. Not even a sticky one (/tmp):
 * no one else can rename root's entries in it, but a unit names the path
 * long after this check, and once root's entry is gone (a reboot clears
 * /tmp) anyone can make it again. With `missing`, a part of the way that
 * does not exist yet is fine when only root can create it. The first part
 * that fails; null when none does.
 */
export function rootOnlyDir(sys: HostSystem, dir: string, missing = false): NotRootOnly | null {
  if (!isAbsolute(dir)) return { path: dir, why: "is not an absolute path" };
  const rest = dir.split("/").filter(Boolean);
  let at = "/";
  let links = 0;
  const notOnly = (info: FileInfo | null): string | null => {
    if (!info) return "does not exist";
    if (info.type !== "dir") return `is a ${info.type}, not a directory`;
    if (info.uid !== 0) return `belongs to uid ${info.uid}, not root`;
    if ((info.mode & 0o022) !== 0) return "is writable by someone other than root";
    return null;
  };
  const first = notOnly(sys.lstat(at));
  if (first) return { path: at, why: first };
  while (rest.length) {
    const name = rest.shift()!;
    if (name === ".") continue;
    if (name === "..") {
      at = dirname(at);
      continue;
    }
    const path = join(at, name);
    const info = sys.lstat(path);
    // Not there yet: its parent is root's alone (checked on the way), so only root can create it.
    if (!info && missing) return null;
    if (info?.type === "symlink") {
      if (info.uid !== 0) return { path, why: `is a link that belongs to uid ${info.uid}, not root` };
      if (++links > MAX_LINKS) return { path, why: `leads through more than ${MAX_LINKS} links` };
      const target = sys.readlink(path) ?? "";
      rest.unshift(...target.split("/").filter(Boolean));
      if (isAbsolute(target)) at = "/";
      continue;
    }
    const why = notOnly(info);
    if (why) return { path, why };
    at = path;
  }
  return null;
}

/** Where `path` leads with its links followed, as stat() does: the last path, and what is there (null: nothing, or a loop). */
function follow(sys: HostSystem, path: string): { path: string; info: FileInfo | null } {
  for (let i = 0; i <= MAX_LINKS; i++) {
    const info = sys.lstat(path);
    if (info?.type !== "symlink") return { path, info };
    path = resolve(dirname(path), sys.readlink(path) ?? "");
  }
  return { path, info: null };
}

/**
 * What the CLI link runs: a trusted installed runtime, or why not.
 * `skipped`: there is no executable regular file at the end of the link,
 * which is what the check service's ConditionFileIsExecutable= tests
 * (stat(), so through every link), so systemd skips its runs. `fix` is what
 * puts it right when `host use-cli` cannot; null when use-cli does.
 */
export type CliLinkRuntime =
  | { ok: true; version: string }
  | {
      ok: false;
      skipped: boolean;
      problem: string;
      fix: string | null;
      /** The link's directory, which does not exist yet: root creates it (only root can) before use-cli. */
      createDir?: string;
    };

/** "chown root:root <path>; chmod go-w <path>": root's, and writable by root alone. */
const rootOnlyFix = (path: string) => `chown root:root ${path}; chmod go-w ${path}`;

/**
 * What puts right a part of the way to the CLI link's directory that root
 * does not control alone (rootOnlyDir). chown and chmod only for a plain
 * directory: never a sticky one (go-w would break /tmp for everyone), nor a
 * link, a file or a path that is not there.
 */
export function cliLinkPlaceFix(sys: HostSystem, bad: NotRootOnly): string {
  const elsewhere = "give the host a CLI link in a directory only root can write";
  const info = sys.lstat(bad.path);
  return info?.type === "dir" && (info.mode & 0o1000) === 0 ? `make ${bad.path} root's and writable by root alone (${rootOnlyFix(bad.path)}), or ${elsewhere}` : elsewhere;
}

/**
 * What puts right a part of the way to the runtime root that root does not
 * control alone, as cliLinkPlaceFix does for the CLI link; null when there
 * is none. No runtime is trusted until then, whatever its own files are.
 */
export function runtimeRootPlaceFix(sys: HostSystem, layout: HostLayout): string | null {
  // Not there yet is fine when only root can create it: install-runtime does.
  const bad = rootOnlyDir(sys, dirname(layout.runtimeRoot), true);
  if (!bad) return null;
  const elsewhere = "give the host a runtime root in a directory only root can write";
  const info = sys.lstat(bad.path);
  return info?.type === "dir" && (info.mode & 0o1000) === 0
    ? `make ${bad.path}, on the way to ${layout.runtimeRoot}, root's and writable by root alone (${rootOnlyFix(bad.path)}), or ${elsewhere}`
    : `${elsewhere} (${bad.path}, on the way to ${layout.runtimeRoot}, ${bad.why})`;
}

/**
 * What makes the installed runtime `version` trusted (trustedRuntimes), as
 * use-cli needs: the way to the runtime root (runtimeRootPlaceFix), then
 * install-runtime of it again, which makes its files root's alone once a
 * root-only copy of their bytes is the recorded ones, and puts those back
 * otherwise. Never chown by hand: whoever could write the binary may have
 * changed it, and chown would make their bytes root's.
 */
export function runtimeFix(sys: HostSystem, layout: HostLayout, version: string): string {
  const steps = [runtimeRootPlaceFix(sys, layout)];
  if (!runtimeFilesRootOnly(sys, layout, version)) steps.push(`install it again (host install-runtime --version ${version}), which makes its files root's alone`);
  return steps.filter((s) => s !== null).join(", then ");
}

/**
 * Whether the runtime `version` is installed (recorded, its binary there)
 * but not trusted: use-cli refuses it, so runtimeFix is what to do.
 */
export function untrustedRuntime(ctx: HostContext, version: string): boolean {
  const { sys, layout, registry } = ctx;
  return registry.getRuntime(version) !== null && sys.lstat(layout.runtimeBinary(version))?.type === "file" && !trustedRuntimes(ctx).includes(version);
}

/**
 * What root runs when it runs the CLI link (the check service every 30 s,
 * `sudo incibase`): fine only when the link is a symlink, in a directory
 * only root controls (rootOnlyDir), straight to the binary of a trusted
 * runtime (trustedRuntimes). `problem` completes "<link> …".
 */
export function cliLinkRuntime(ctx: HostContext): CliLinkRuntime {
  const { sys, layout } = ctx;
  const link = layout.cliLink;
  const info = sys.lstat(link);
  const end = follow(sys, link);
  const skipped = end.info?.type !== "file" || (end.info.mode & 0o111) === 0;
  // Whoever can change its directory can put their own incibase there, linked or not.
  const dir = rootOnlyDir(sys, dirname(link), true);
  if (dir) {
    return { ok: false, skipped, problem: `is in ${dirname(link)}, which someone other than root can change (${dir.path} ${dir.why})`, fix: cliLinkPlaceFix(sys, dir) };
  }
  // Root's alone, but not there yet (a custom layout): root creates it, then use-cli.
  if (rootOnlyDir(sys, dirname(link))) return { ok: false, skipped: true, problem: `is in ${dirname(link)}, which does not exist`, fix: null, createDir: dirname(link) };
  if (!info) return { ok: false, skipped: true, problem: "does not exist", fix: null };
  if (info.type !== "symlink") {
    const what = info.type === "file" && skipped ? "a file no one can execute" : `a ${info.type}`;
    return { ok: false, skipped, problem: `is ${what}, not a link to an installed runtime`, fix: null };
  }
  const target = resolve(dirname(link), sys.readlink(link) ?? "");
  if (skipped) {
    const there = end.info ? (end.info.type === "file" ? "a file no one can execute" : `a ${end.info.type}`) : null;
    const leads = end.path === target ? (there ? `which is ${there}` : "which does not exist") : `which leads to ${end.path}, ${there ? `which is ${there}` : "where there is nothing"}`;
    return { ok: false, skipped, problem: `points at ${target}, ${leads}`, fix: null };
  }
  const version = trustedRuntimes(ctx).find((v) => layout.runtimeBinary(v) === target);
  if (version !== undefined) return { ok: true, version };
  const installed = basename(target) === "incibase" && dirname(dirname(target)) === layout.runtimeRoot && RUNTIME_VERSION_REGEX.test(basename(dirname(target)));
  if (!installed) return { ok: false, skipped, problem: `points at ${target}, not at a runtime installed in ${layout.runtimeRoot} that only root can write`, fix: null };
  // The runtime use-cli would link again: its files are what to put right.
  return {
    ok: false,
    skipped,
    problem: `points at ${target}, a runtime in ${layout.runtimeRoot} that someone other than root can change`,
    fix: `${runtimeFix(sys, layout, basename(dirname(target)))}, or point it at another installed runtime (host use-cli <version>)`,
  };
}

/** `incibase-snapshot@<id>.service.d/10-incibase.conf`: the branch's user and limits, `_snapshot` of the runtime hostRuntime picked. */
export function snapshotDropIn(layout: HostLayout, branch: BranchRow, runtimeBinary: string): string {
  const limits = resolveLimits(parseLimits(branch.limits_json));
  const config = parseConfig(branch.config_json);
  const paths = layout.branch(branch.id);
  const command = [runtimeBinary, "_snapshot", "--data", paths.data, "--out", paths.snapshotFile].map(word).join(" ");
  const user = branchUser(branch.id);
  return `${HEADER}[Service]
User=${user}
Group=${user}
ExecStart=
ExecStart=${command}
${limitLines(limits, config)}
`;
}

/** What the host derives into a branch's env file, next to the registry's rows. */
export function derivedEnv(layout: HostLayout, branch: BranchRow): Record<string, string> {
  const limits = resolveLimits(parseLimits(branch.limits_json));
  const env: Record<string, string> = {
    INCIBASE_SERVICE_KEYS_FILE: layout.branch(branch.id).serviceKeys,
    INCIBASE_AUTH_CONCURRENCY: String(authConcurrency(limits.memoryMax)),
  };
  if (limits.maxDbBytes !== undefined) env.INCIBASE_MAX_DB_BYTES = String(limits.maxDbBytes);
  if (limits.maxStorageBytes !== undefined) env.INCIBASE_MAX_STORAGE_BYTES = String(limits.maxStorageBytes);
  if (limits.maxUploadBytes !== undefined) env.INCIBASE_MAX_UPLOAD_BYTES = String(limits.maxUploadBytes);
  return env;
}

// ---- writing ---------------------------------------------------------------

const UNIT_FILE = { uid: 0, gid: 0, mode: 0o644 };

/** Writes `path` unless it already has this content, owner and mode; true when it wrote. */
export function writeIfChanged(ctx: HostContext, path: string, content: string, owner: { uid: number; gid: number; mode: number }): boolean {
  const info = ctx.sys.lstat(path);
  if (info?.type === "file" && info.uid === owner.uid && info.gid === owner.gid && info.mode === owner.mode && ctx.sys.readFile(path) === content) return false;
  ctx.sys.writeFile(path, content, owner);
  return true;
}

function ensureDir(ctx: HostContext, path: string, mode = 0o755) {
  const info = ctx.sys.lstat(path);
  if (info && info.type !== "dir") throw new Error(`${path} exists and is not a directory`);
  if (!info) ctx.sys.mkdir(path, mode);
}

/** Removes a file or link if it is there; true when it removed something. */
export function removeIfPresent(ctx: HostContext, path: string): boolean {
  if (!ctx.sys.lstat(path)) return false;
  ctx.sys.remove(path);
  return true;
}

/** The host's units: the three templates, the slice and the check timer's two. True when one changed. */
export function renderHostUnits(ctx: HostContext): boolean {
  const { layout, registry } = ctx;
  ensureDir(ctx, layout.systemdDir);
  const sliceMax = Number(registry.getSetting("slice_memory_max"));
  let changed = writeIfChanged(ctx, layout.unitFile(layout.units.branchTemplate), branchTemplateUnit(layout), UNIT_FILE);
  changed = writeIfChanged(ctx, layout.unitFile(layout.units.preflightTemplate), preflightTemplateUnit(layout), UNIT_FILE) || changed;
  changed = writeIfChanged(ctx, layout.unitFile(layout.units.snapshotTemplate), snapshotTemplateUnit(layout), UNIT_FILE) || changed;
  changed = writeIfChanged(ctx, layout.unitFile(layout.units.slice), sliceUnit(layout, Number.isSafeInteger(sliceMax) && sliceMax > 0 ? sliceMax : null), UNIT_FILE) || changed;
  changed = renderCheckUnits(ctx) || changed;
  return changed;
}

// ---- the check timer (design section 9) ------------------------------------

/**
 * `<prefix>-check.service`: one `incibase host check` of this host, as root,
 * every 30 s. It runs the CLI link (`host use-cli`), the link's own path,
 * never the binary that rendered it: `host init` runs from a download in a
 * login account's home, which that account (anything running as it) can
 * replace. Through the link root runs an installed runtime, the check
 * follows `use-cli` without a render, and gc keeps what it runs (it keeps
 * the link's runtime). Until the link points at an executable file, systemd
 * skips each run instead of failing it: path conditions follow symlinks, so
 * a missing link and one to nothing are both unmet; the service stays
 * inactive and the timer goes on firing (systemd 255). `host doctor` says
 * so (cliLinkRuntime).
 */
export function checkServiceUnit(layout: HostLayout): string {
  return `${hostHeader(layout)}[Unit]
Description=incibase health check of ${word(layout.root)}
After=network-online.target
# Skipped, not failed, until host use-cli points the link at an installed runtime.
${cliCondition(layout)}

[Service]
Type=oneshot
ExecStart=${word(layout.cliLink)} host check --root ${word(layout.root)}
Environment=NO_COLOR=1
# Probes run in parallel with a 5 s timeout and an alert POST has 10 s; anything longer is stuck.
TimeoutStartSec=120
`;
}

/** The check service's line that names the CLI link it runs; another host's init looks for it (ops.foreignPaths). */
export function cliCondition(layout: HostLayout): string {
  return `ConditionFileIsExecutable=${word(layout.cliLink)}`;
}

/** `<prefix>-check.timer`: the check every 30 s; a oneshot never runs twice at once. */
export function checkTimerUnit(layout: HostLayout): string {
  return `${hostHeader(layout)}[Unit]
Description=incibase health check every 30 s

[Timer]
OnActiveSec=10s
OnBootSec=60s
OnUnitActiveSec=30s
AccuracySec=1s
Unit=${layout.units.checkService}

[Install]
WantedBy=timers.target
`;
}

/**
 * The check service and timer, and the timer's boot link unless the host
 * turned the timer off (setting check_timer = off). True when one changed.
 */
export function renderCheckUnits(ctx: HostContext): boolean {
  const { layout, sys } = ctx;
  let changed = writeIfChanged(ctx, layout.unitFile(layout.units.checkService), checkServiceUnit(layout), UNIT_FILE);
  changed = writeIfChanged(ctx, layout.unitFile(layout.units.checkTimer), checkTimerUnit(layout), UNIT_FILE) || changed;
  const wants = layout.timerWantsLink();
  if (ctx.registry.getSetting("check_timer") !== "off") {
    if (sys.readlink(wants.path) !== wants.target) {
      ensureDir(ctx, wants.path.slice(0, wants.path.lastIndexOf("/")));
      sys.symlink(wants.target, wants.path);
      changed = true;
    }
  } else if (removeIfPresent(ctx, wants.path)) changed = true;
  return changed;
}

/** The domain branches are served under; units cannot be rendered without it. */
export function hostDomain(ctx: HostContext): string {
  const domain = ctx.registry.getSetting("domain");
  if (!domain) throw new Error("The host has no domain: set it with `incibase host init --domain …` first");
  return domain;
}

/**
 * A branch's drop-in and its boot link (`multi-user.target.wants`, while it
 * should run). True when a unit file changed.
 */
export function renderBranchUnits(ctx: HostContext, branch: BranchRow): boolean {
  const { layout, registry, sys } = ctx;
  const unit = layout.units.branch(branch.id);
  const release = branch.release_seq === null ? null : registry.getRelease(branch.id, branch.release_seq);
  const content = branchDropIn({ layout, branch, domain: hostDomain(ctx), release });
  const dropIn = layout.dropIn(unit);
  ensureDir(ctx, dropIn.slice(0, dropIn.lastIndexOf("/")));
  let changed = writeIfChanged(ctx, dropIn, content, UNIT_FILE);
  const wants = layout.wantsLink(branch.id);
  if (branch.desired_state === "running" && release) {
    if (sys.readlink(wants.path) !== wants.target) {
      ensureDir(ctx, wants.path.slice(0, wants.path.lastIndexOf("/")));
      sys.symlink(wants.target, wants.path);
      changed = true;
    }
  } else if (removeIfPresent(ctx, wants.path)) changed = true;
  return changed;
}

/** Writes the preflight drop-in for one try; true when it changed. */
export function renderPreflightUnit(ctx: HostContext, input: Omit<PreflightUnitInput, "layout" | "domain">): boolean {
  const { layout } = ctx;
  const dropIn = layout.dropIn(layout.units.preflight(input.branch.id));
  ensureDir(ctx, dropIn.slice(0, dropIn.lastIndexOf("/")));
  return writeIfChanged(ctx, dropIn, preflightDropIn({ ...input, layout, domain: hostDomain(ctx) }), UNIT_FILE);
}

/**
 * Writes the snapshot template (a host rendered before it existed gets it
 * here) and the branch's snapshot drop-in, running `runtime` (by default
 * hostRuntime's pick for the branch); true when a unit file changed.
 */
export function renderSnapshotUnit(ctx: HostContext, branch: BranchRow, runtime = hostRuntime(ctx, branch.runtime_version)): boolean {
  const { layout } = ctx;
  if (!runtime) throw new Error(`Neither this host's runtime ${VERSION} nor ${branch.runtime_version} is installed to take a snapshot with; install one with incibase host install-runtime`);
  ensureDir(ctx, layout.systemdDir);
  let changed = writeIfChanged(ctx, layout.unitFile(layout.units.snapshotTemplate), snapshotTemplateUnit(layout), UNIT_FILE);
  const dropIn = layout.dropIn(layout.units.snapshot(branch.id));
  ensureDir(ctx, dropIn.slice(0, dropIn.lastIndexOf("/")));
  changed = writeIfChanged(ctx, dropIn, snapshotDropIn(layout, branch, runtime.binary), UNIT_FILE) || changed;
  return changed;
}

/** Removes a branch's drop-ins and boot link; true when something was there. */
export function removeBranchUnits(ctx: HostContext, id: string): boolean {
  const { layout } = ctx;
  let changed = removeIfPresent(ctx, layout.wantsLink(id).path);
  for (const unit of [layout.units.branch(id), layout.units.preflight(id), layout.units.snapshot(id)]) {
    const dropIn = layout.dropIn(unit);
    if (removeIfPresent(ctx, dropIn.slice(0, dropIn.lastIndexOf("/")))) changed = true;
  }
  return changed;
}
