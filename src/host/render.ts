// Files rendered from the registry (design section 5.4): the env file,
// service-keys.json, admin/index.json and the systemd units: the template
// `incibase-branch@.service`, `incibase-preflight@.service`, `incibase.slice`
// and each branch's drop-in. The text builders here are pure; the writers
// write a file atomically (temp file, fsync, rename, via HostSystem) and only
// when its content, owner or mode differ, and say whether a unit file changed,
// so the caller runs `systemctl daemon-reload` once, and only then.
import type { BranchConfig, ResolvedLimits } from "./config.ts";
import { authConcurrency, drainMs, durationText, parseConfig, parseLimits, resolveLimits, stopTimeoutSec, systemdSize, timeoutsFlag } from "./config.ts";
import type { HostLayout } from "./layout.ts";
import { branchUser, checkDomain, checkEnvName, checkLabel } from "./names.ts";
import type { HostContext } from "./provision.ts";
import type { BranchRow, EnvRow, ReleaseRow, ServiceKeyRow } from "./registry.ts";

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
  return `${HEADER}[Unit]
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
  return `${HEADER}[Unit]
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

/** `incibase.slice`: all branches together stay under this much memory. */
export function sliceUnit(memoryMax: number | null): string {
  return `${HEADER}[Unit]
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

/** The host's units: the two templates and the slice. True when one changed. */
export function renderHostUnits(ctx: HostContext): boolean {
  const { layout, registry } = ctx;
  ensureDir(ctx, layout.systemdDir);
  const sliceMax = Number(registry.getSetting("slice_memory_max"));
  let changed = writeIfChanged(ctx, layout.unitFile(layout.units.branchTemplate), branchTemplateUnit(layout), UNIT_FILE);
  changed = writeIfChanged(ctx, layout.unitFile(layout.units.preflightTemplate), preflightTemplateUnit(layout), UNIT_FILE) || changed;
  changed = writeIfChanged(ctx, layout.unitFile(layout.units.slice), sliceUnit(Number.isSafeInteger(sliceMax) && sliceMax > 0 ? sliceMax : null), UNIT_FILE) || changed;
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

/** Removes a branch's drop-ins and boot link; true when something was there. */
export function removeBranchUnits(ctx: HostContext, id: string): boolean {
  const { layout } = ctx;
  let changed = removeIfPresent(ctx, layout.wantsLink(id).path);
  for (const unit of [layout.units.branch(id), layout.units.preflight(id)]) {
    const dropIn = layout.dropIn(unit);
    if (removeIfPresent(ctx, dropIn.slice(0, dropIn.lastIndexOf("/")))) changed = true;
  }
  return changed;
}
