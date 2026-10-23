// `incibase host doctor` (design sections 4, 7 and 13): one OK/WARN/FAIL
// line per thing the host relies on, and a non-zero exit when one fails.
//
// The sandbox is not taken on trust: a short transient unit runs a probe as
// `nobody` with the directives a branch gets and reports which of them
// actually take effect here (a container may switch some off; on a VM each
// one that does not is a FAIL). SocketBindDeny needs systemd's BPF framework:
// a systemd built without it (`-BPF_FRAMEWORK`, as Ubuntu 24.04's is) ignores
// it on a VM too, so that is a WARN naming the build, not the container.
//
// The check timer is judged by what its runs leave behind (the check cannot
// alert about itself): a failed check service, or no completed run for two
// minutes, is a FAIL; so are alerts waiting more than 5 minutes to reach the
// webhook. The journal's effective Storage= comes from journald.conf and its
// drop-ins. The probe is incibase's own script run by an
// installed runtime (BUN_BE_BUN=1 makes the standalone binary act as bun);
// root runs no tenant code.
//
// Everything outside the host's own files goes through DoctorHooks, so the
// macOS tests feed it the machine they want.
import { lstatSync, readFileSync } from "node:fs";
import { VERSION } from "../engine/version.ts";
import { RUNTIME_VERSION_REGEX } from "./layout.ts";
import { readCheckState, statDisk, type DiskUsage } from "./check.ts";
import { ALERT_WEBHOOK } from "./alerts.ts";
import type { OpsContext } from "./context.ts";
import { printable } from "./driver.ts";
import { branchRef } from "./names.ts";
import { OpError } from "./ops.ts";
import { verifyBranch, verifyHostTree } from "./provision.ts";
import { checkUnitName } from "./systemd.ts";
import type { FileInfo } from "./system.ts";

export type DoctorStatus = "OK" | "WARN" | "FAIL";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The four directives the probe tries, and how each shows. */
export const PROBED_DIRECTIVES = ["SocketBindDeny", "ProtectProc", "IPAddressDeny", "ProtectSystem"] as const;
export type ProbedDirective = (typeof PROBED_DIRECTIVES)[number];

export type SandboxProbe =
  | { ran: true; directives: Record<ProbedDirective, { effective: boolean; detail: string }> }
  | { ran: false; reason: string };

export interface DoctorHooks {
  /** Runs a command from an argument array; null when it is not installed. */
  command(argv: string[], timeoutMs?: number): CommandResult | null;
  /** A path on the machine outside the host's files (/sys, /var/log, /etc). */
  file(path: string): FileInfo | null;
  readText(path: string): string | null;
  diskUsage(path: string): DiskUsage;
  sandboxProbe(ctx: OpsContext): Promise<SandboxProbe>;
}

export interface DoctorContext extends OpsContext {
  doctor?: Partial<DoctorHooks>;
}

const PATH_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", SYSTEMD_COLORS: "0", SYSTEMD_PAGER: "" };
/** systemd 252 is the oldest with every directive the branch units use (and `systemctl kill --kill-whom`). */
export const MIN_SYSTEMD = 252;
/** A check that has not completed for this long is not running (the timer fires every 30 s). */
export const CHECK_STALE_MS = 120_000;
/** An alert that has waited this long for the webhook is not being delivered. */
export const ALERT_DELIVERY_GRACE_MS = 5 * 60_000;

/**
 * Whether `systemctl --version` lists a compile-time feature: true for
 * `+NAME`, false for `-NAME`, null when it is not listed.
 */
export function systemdFeature(versionOutput: string, name: string): boolean | null {
  for (const word of versionOutput.split(/\s+/)) {
    if (word === `+${name}`) return true;
    if (word === `-${name}`) return false;
  }
  return null;
}

/** The Storage= journald uses: the last one in its configuration (drop-ins included), `auto` when none sets it. */
export function journalStorage(config: string): string {
  let section = "";
  let storage = "auto";
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) section = header[1]!;
    else if (section === "Journal") {
      const value = /^Storage\s*=\s*(.*)$/.exec(line)?.[1];
      // An empty assignment resets it to the default.
      if (value !== undefined) storage = value.trim().toLowerCase() || "auto";
    }
  }
  return storage;
}

function runCommand(argv: string[], timeoutMs = 15_000): CommandResult | null {
  try {
    const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: PATH_ENV, timeout: timeoutMs });
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  } catch {
    return null;
  }
}

const machine: DoctorHooks = {
  command: runCommand,
  file: (path) => {
    try {
      const st = lstatSync(path);
      return { type: st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other", uid: st.uid, gid: st.gid, mode: st.mode & 0o7777, size: st.size, blocks: Number(st.blocks), mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  },
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  diskUsage: statDisk,
  sandboxProbe: runSandboxProbe,
};

/** The last non-empty line of command output, safe to print. */
function lastLine(text: string): string {
  return printable(text.trim().split("\n").filter(Boolean).at(-1) ?? "", 300);
}

// ---- the sandbox probe ----------------------------------------------------------

/** The probe, as `nobody`: one JSON line saying what it could do. */
export const PROBE_SCRIPT = `const fs = require("node:fs");
const [port, marker] = process.argv.slice(2);
const out = {};
const code = (e) => "error " + (e && (e.code || e.message));
try { const s = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } }); s.stop(true); out.bind = "bound"; } catch (e) { out.bind = code(e); }
out.proc = fs.existsSync("/proc/1/cmdline") ? "visible" : "hidden";
try { fs.writeFileSync(marker, "1"); out.write = "written"; } catch (e) { out.write = code(e); }
out.connect = await new Promise((done) => {
  const t = setTimeout(() => done("timeout"), 2000);
  Bun.connect({ hostname: "127.0.0.1", port: Number(port), socket: { open(s) { clearTimeout(t); s.end(); done("open"); }, data() {}, connectError(_s, e) { clearTimeout(t); done(code(e)); } } })
    .catch((e) => { clearTimeout(t); done(code(e)); });
});
console.log("PROBE " + JSON.stringify(out));
process.exit(0);
`;

/** What the probe printed, as the four directives. */
export function readProbe(stdout: string): SandboxProbe {
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE "));
  if (!line) return { ran: false, reason: `the probe printed nothing${stdout.trim() ? ` (${lastLine(stdout)})` : ""}` };
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(line.slice(6));
  } catch {
    return { ran: false, reason: "the probe printed something unreadable" };
  }
  const text = (key: string) => printable(String(out[key] ?? "?"), 120);
  return {
    ran: true,
    directives: {
      SocketBindDeny: { effective: text("bind").startsWith("error"), detail: `listening on 0.0.0.0: ${text("bind")}` },
      ProtectProc: { effective: text("proc") === "hidden", detail: `root's /proc/1 is ${text("proc")}` },
      IPAddressDeny: { effective: text("connect") !== "open", detail: `connecting to 127.0.0.1: ${text("connect")}` },
      ProtectSystem: { effective: /^error E(ROFS|ACCES|PERM)/.test(text("write")), detail: `writing /var/tmp: ${text("write")}` },
    },
  };
}

/** The runtime the probe runs with: this version if installed, else the newest. */
function probeRuntime(ctx: OpsContext): string | null {
  const versions = ctx.sys.readdir(ctx.layout.runtimeRoot).filter((v) => RUNTIME_VERSION_REGEX.test(v));
  const usable = versions.filter((v) => {
    const info = ctx.sys.lstat(ctx.layout.runtimeBinary(v));
    return info?.type === "file" && info.uid === 0 && (info.mode & 0o022) === 0 && (info.mode & 0o005) === 0o005;
  });
  const pick = usable.includes(VERSION) ? VERSION : usable.sort(Bun.semver.order).at(-1);
  return pick ? ctx.layout.runtimeBinary(pick) : null;
}

/**
 * Runs PROBE_SCRIPT in `<prefix>-doctor-<n>.service` as nobody, with the
 * branch sandbox's network, bind, /proc and file-system directives, and a
 * listener of ours on 127.0.0.1 for it to try.
 */
export async function runSandboxProbe(ctx: OpsContext): Promise<SandboxProbe> {
  const runtime = probeRuntime(ctx);
  if (!runtime) return { ran: false, reason: `no runtime is installed under ${ctx.layout.runtimeRoot} to run it with` };
  const nobody = ctx.sys.getpwnam("nobody");
  if (!nobody) return { ran: false, reason: "there is no user nobody to run it as" };
  const n = (ctx.now ?? Date.now)();
  const unit = checkUnitName(`${ctx.layout.units.prefix}-doctor-${n}.service`);
  const dir = `/run/${ctx.layout.units.prefix}-doctor-${n}`;
  const script = `${dir}/probe.js`;
  const marker = `/var/tmp/${ctx.layout.units.prefix}-doctor-${n}`;
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (s) => void s.end(), data() {} } });
  try {
    ctx.sys.mkdir(dir, 0o755);
    ctx.sys.writeFile(script, PROBE_SCRIPT, { uid: 0, gid: 0, mode: 0o644 });
    const argv = [
      "systemd-run",
      `--unit=${unit}`,
      "--collect",
      "--wait",
      "--pipe",
      "--quiet",
      "--service-type=exec",
      `--property=User=${nobody.uid}`,
      `--property=Group=${nobody.gid}`,
      "--property=SocketBindDeny=any",
      "--property=ProtectProc=invisible",
      "--property=IPAddressDeny=localhost",
      "--property=ProtectSystem=strict",
      "--property=NoNewPrivileges=yes",
      "--property=RuntimeMaxSec=20",
      "--setenv=BUN_BE_BUN=1",
      "--setenv=NO_COLOR=1",
      "--setenv=HOME=/nonexistent",
      "--",
      runtime,
      script,
      String(listener.port),
      marker,
    ];
    for (const arg of argv) if (!/^[A-Za-z0-9_./:=@,+-]+$/.test(arg)) throw new Error(`Refusing to pass ${JSON.stringify(arg)} to systemd-run`);
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: PATH_ENV });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    const probe = readProbe(stdout);
    if (!probe.ran && stderr.trim()) return { ran: false, reason: `${probe.reason}; systemd-run: ${lastLine(stderr)}` };
    return probe;
  } catch (err) {
    return { ran: false, reason: printable((err as Error).message, 300) };
  } finally {
    listener.stop(true);
    ctx.sys.remove(dir);
    ctx.sys.remove(marker);
  }
}

// ---- the checks -------------------------------------------------------------------

/** Every check, in the order they are printed. */
export async function runDoctor(ctx: DoctorContext): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const hooks: DoctorHooks = { ...machine, ...ctx.doctor };
  const { layout, registry, sys } = ctx;
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorStatus, detail: string) => void checks.push({ name, status, detail });
  const problems = (name: string, found: string[], okDetail: string) =>
    found.length ? add(name, "FAIL", found.slice(0, 5).join("; ") + (found.length > 5 ? `; and ${found.length - 5} more` : "")) : add(name, "OK", okDetail);

  // systemd and the kernel
  const version = hooks.command(["systemctl", "--version"]);
  const bpfFramework = version ? systemdFeature(version.stdout, "BPF_FRAMEWORK") : null;
  const systemd = version ? Number(/^systemd (\d+)/.exec(version.stdout)?.[1]) : NaN;
  if (!version) add("systemd", "FAIL", "systemctl is not installed");
  else if (!Number.isInteger(systemd)) add("systemd", "FAIL", `cannot read the version from ${JSON.stringify(lastLine(version.stdout))}`);
  else add("systemd", systemd >= MIN_SYSTEMD ? "OK" : "FAIL", `systemd ${systemd}${systemd >= MIN_SYSTEMD ? "" : `; incibase needs ${MIN_SYSTEMD} or newer`}`);
  add(
    "cgroup v2",
    hooks.file("/sys/fs/cgroup/cgroup.controllers") ? "OK" : "FAIL",
    hooks.file("/sys/fs/cgroup/cgroup.controllers") ? "unified hierarchy" : "/sys/fs/cgroup is not cgroup v2: memory and task limits do not apply",
  );
  const virt = hooks.command(["systemd-detect-virt", "--container"]);
  const container = virt && virt.exitCode === 0 && virt.stdout.trim() && virt.stdout.trim() !== "none" ? printable(virt.stdout.trim(), 40) : null;
  if (!virt) add("virtualization", "WARN", "systemd-detect-virt is not installed");
  else if (container) add("virtualization", "WARN", `a container (${container}): it may switch sandbox directives off; production wants a KVM VM`);
  else add("virtualization", "OK", "not a container");

  // the sandbox, as this machine applies it
  const probe = await hooks.sandboxProbe(ctx);
  if (!probe.ran) add("sandbox probe", "WARN", `skipped: ${probe.reason}`);
  else {
    for (const directive of PROBED_DIRECTIVES) {
      const { effective, detail } = probe.directives[directive];
      if (effective) add(`sandbox ${directive}`, "OK", detail);
      else if (directive === "SocketBindDeny" && bpfFramework === false) {
        // Not the container: this systemd cannot apply it anywhere. IPAddressDeny still drops local and private peers.
        add(
          `sandbox ${directive}`,
          "WARN",
          `unsupported by this systemd build (-BPF_FRAMEWORK): a branch can listen on TCP; IPAddressDeny keeps local and private peers out, so the firewall must keep every port but 22, 80 and 443 closed: ${detail}`,
        );
      } else add(`sandbox ${directive}`, container ? "WARN" : "FAIL", `not effective${container ? ` in this container (${container})` : ""}: ${detail}`);
    }
  }

  // the proxy
  const nginx = hooks.command(["nginx", "-t"]);
  if (!nginx) add("nginx", "FAIL", "nginx is not installed");
  else add("nginx", nginx.exitCode === 0 ? "OK" : "FAIL", nginx.exitCode === 0 ? "nginx -t: the configuration is valid" : `nginx -t: ${lastLine(nginx.stderr || nginx.stdout)}`);
  const proxy = sys.getgrnam(layout.groups.proxy);
  const www = sys.getpwnam("www-data");
  if (!proxy) add("proxy group", "FAIL", `the group ${layout.groups.proxy} does not exist`);
  else if (proxy.members.includes("www-data") || www?.gid === proxy.gid) add("proxy group", "OK", `www-data is in ${layout.groups.proxy}`);
  else add("proxy group", "FAIL", `www-data is not in ${layout.groups.proxy}, so nginx cannot reach the branch sockets (usermod -aG ${layout.groups.proxy} www-data)`);

  // the host's files
  problems("host tree", verifyHostTree(ctx), `${layout.root}: owners and modes as expected`);
  const privateFile = (path: string, found: string[]) => {
    const info = sys.lstat(path);
    if (!info) return;
    if (info.type !== "file") found.push(`${path}: is a ${info.type}`);
    else if (info.uid !== 0 || info.gid !== 0 || info.mode !== 0o600) found.push(`${path}: ${info.uid}:${info.gid} mode ${info.mode.toString(8)}, expected 0:0 600`);
  };
  const registryProblems: string[] = [];
  if (!sys.lstat(layout.registry)) registryProblems.push(`${layout.registry}: missing`);
  for (const suffix of ["", "-wal", "-shm"]) privateFile(`${layout.registry}${suffix}`, registryProblems);
  privateFile(layout.checkState, registryProblems);
  privateFile(layout.checkLock, registryProblems);
  problems("registry", registryProblems, "registry.db and its -wal and -shm are root 0600");
  const ready = registry.listBranches({ phase: "ready" });
  const envProblems: string[] = [];
  for (const name of sys.readdir(layout.envDir)) privateFile(`${layout.envDir}/${name}`, envProblems);
  for (const branch of ready) if (!sys.lstat(layout.branch(branch.id).envFile)) envProblems.push(`${layout.branch(branch.id).envFile}: missing`);
  problems("env files", envProblems, `${ready.length} env file(s), all root 0600`);
  const proxyGid = proxy?.gid ?? -1;
  const adminGid = sys.getgrnam(layout.groups.admin)?.gid ?? -1;
  for (const branch of ready) {
    const found = verifyBranch(ctx, branch);
    const paths = layout.branch(branch.id);
    const running = ctx.driver.isActive(layout.units.branch(branch.id));
    if (running) {
      for (const [socket, gid] of [
        [paths.httpSock, proxyGid],
        [paths.adminSock, adminGid],
      ] as const) {
        const info = sys.lstat(socket);
        if (!info) found.push(`${socket}: missing although the branch runs`);
        else if (info.type !== "other" || info.uid !== branch.os_uid || info.gid !== gid || info.mode !== 0o770) {
          found.push(`${socket}: a ${info.type} ${info.uid}:${info.gid} mode ${info.mode.toString(8)}, expected a socket ${branch.os_uid}:${gid} mode 770`);
        }
      }
    }
    problems(`branch ${branchRef(branch.project, branch.name)}`, found, running ? "directories, files, links and sockets as expected" : "directories, files and links as expected (not running)");
  }

  // logs, the tunnel, time, disk
  const catConfig = hooks.command(["systemd-analyze", "cat-config", "systemd/journald.conf"]);
  const storage = journalStorage(catConfig?.exitCode === 0 ? catConfig.stdout : (hooks.readText("/etc/systemd/journald.conf") ?? ""));
  const machineId = hooks.readText("/etc/machine-id")?.trim() ?? "";
  const journalDir = /^[0-9a-f]{32}$/.test(machineId) ? `/var/log/journal/${machineId}` : null;
  if (storage === "volatile" || storage === "none") {
    add("journald", "WARN", `Storage=${storage}: branch logs are lost at reboot (set Storage=persistent in /etc/systemd/journald.conf.d/)`);
  } else if (storage !== "auto" && storage !== "persistent") {
    add("journald", "WARN", `Storage=${printable(storage, 40)} is not a value journald knows`);
  } else if (storage === "auto" && hooks.file("/var/log/journal")?.type !== "dir") {
    add("journald", "WARN", "the journal is kept in memory only, so branch logs are lost at reboot (mkdir /var/log/journal)");
  } else if (journalDir && hooks.file(journalDir)?.type !== "dir") {
    add("journald", "WARN", `Storage=${storage}, but journald has not written to ${journalDir} yet (journalctl --flush)`);
  } else add("journald", "OK", `persistent storage (Storage=${storage}, /var/log/journal)`);
  const sshd = hooks.command(["sshd", "-T"]);
  if (!sshd) add("sshd", "WARN", "sshd is not installed: incibase tunnel needs it");
  else if (sshd.exitCode !== 0) add("sshd", "WARN", `sshd -T: ${lastLine(sshd.stderr || sshd.stdout)}`);
  else {
    const option = (name: string) => new RegExp(`^${name}\\s+(\\S+)`, "mi").exec(sshd.stdout)?.[1]?.toLowerCase() ?? null;
    const streamlocal = option("allowstreamlocalforwarding");
    const disabled = option("disableforwarding");
    if (disabled === "yes") add("sshd", "FAIL", "DisableForwarding yes: incibase tunnel cannot forward the admin sockets");
    else if (streamlocal !== null && !["yes", "all", "local"].includes(streamlocal)) add("sshd", "FAIL", `AllowStreamLocalForwarding ${streamlocal}: incibase tunnel needs yes or local`);
    else add("sshd", "OK", `AllowStreamLocalForwarding ${streamlocal ?? "yes"}, DisableForwarding ${disabled ?? "no"}`);
  }
  const zone = registry.getSetting("timezone") ?? "UTC";
  const time = hooks.command(["timedatectl", "show", "--property=Timezone", "--property=NTPSynchronized"]);
  if (!time || time.exitCode !== 0) add("time", "WARN", `branches use ${zone}; timedatectl could not tell the machine's time zone or clock sync`);
  else {
    const machineZone = /^Timezone=(.*)$/m.exec(time.stdout)?.[1] ?? "?";
    const synced = /^NTPSynchronized=yes$/m.test(time.stdout);
    add("time", synced ? "OK" : "WARN", `branches use ${zone}, the machine ${printable(machineZone, 60)}; the clock is ${synced ? "" : "not "}NTP-synchronized`);
  }
  try {
    const disk = hooks.diskUsage(layout.root);
    const free = `${100 - disk.usedPercent}% free (${(disk.availableBytes / 1024 ** 3).toFixed(1)} GiB) on the file system of ${layout.root}`;
    add("disk", disk.usedPercent >= 95 ? "FAIL" : disk.usedPercent >= 90 ? "WARN" : "OK", free);
  } catch (err) {
    add("disk", "WARN", `cannot read the free space: ${printable((err as Error).message, 200)}`);
  }

  // the check and its alerts
  const at = (ctx.now ?? Date.now)();
  const checkState = readCheckState(ctx);
  const { checkService, checkTimer } = layout.units;
  const ago = (t: number) => `${Math.max(0, Math.round((at - t) / 1000))} s ago`;
  if (registry.getSetting("check_timer") === "off") add("check timer", "WARN", "turned off (check_timer = off): nothing kills a stalled branch or raises alerts");
  else if (!ctx.driver.isActive(checkTimer)) add("check timer", "WARN", `${checkTimer} is not running (incibase host render starts it)`);
  else {
    const service = ctx.driver.show(checkService);
    const last = checkState.lastRunAt;
    if (service.activeState === "failed") {
      add("check timer", "FAIL", `the last run of ${checkService} failed (${printable(service.result || "failed", 40)}): nothing kills a stalled branch or raises alerts (journalctl -u ${checkService})`);
    } else if (last === undefined) add("check timer", "WARN", `${checkTimer} runs, but no check has completed yet`);
    else if (at - last > CHECK_STALE_MS) add("check timer", "FAIL", `the last check completed ${ago(last)}: ${checkService} does not complete (journalctl -u ${checkService})`);
    else add("check timer", "OK", `${checkTimer} runs the check every 30 s; the last one completed ${ago(last)}`);
  }
  const webhook = registry.getSetting(ALERT_WEBHOOK);
  let webhookHost: string | null = null;
  try {
    webhookHost = webhook ? new URL(webhook).host : null;
  } catch {
    // Reported below as not set.
  }
  if (!webhookHost) add("alerts", "WARN", "no alert_webhook: alerts only show in incibase host status (incibase host set alert_webhook https://ntfy.sh/<topic>)");
  else {
    const delivery = checkState.delivery;
    const lastError = delivery && !delivery.ok && !delivery.unconfigured ? printable(delivery.error ?? "failed", 300) : null;
    // Due: an open not sent yet, or a resolve not sent yet; `since` is when it opened or resolved.
    const waiting = registry
      .listAlerts()
      .filter((a) => ((a.state === "firing" && a.notified_at === null) || (a.state === "resolved" && a.notified_at !== null)) && at - a.since > ALERT_DELIVERY_GRACE_MS);
    if (waiting.length) {
      const oldest = Math.min(...waiting.map((a) => a.since));
      add(
        "alerts",
        "FAIL",
        `${waiting.length} alert(s) waiting to reach ${webhookHost}, the oldest since ${ago(oldest)}${lastError ? `; the last delivery failed: ${lastError}` : ""} (${waiting
          .slice(0, 3)
          .map((a) => printable(a.key, 40))
          .join(", ")})`,
      );
    } else if (lastError) add("alerts", "WARN", `alerts go to ${webhookHost}, but the last delivery ${ago(delivery!.at)} failed: ${lastError}`);
    else add("alerts", "OK", `alerts go to ${webhookHost}`);
  }

  return { ok: !checks.some((c) => c.status === "FAIL"), checks };
}

/** `incibase host doctor`. */
export async function doctor(ctx: DoctorContext, input: Record<string, never> = {}) {
  if (Object.keys(input ?? {}).length) throw new OpError("INVALID", "doctor takes no input");
  return runDoctor(ctx);
}

/** The report as the CLI prints it. */
export function formatDoctor(report: { checks: DoctorCheck[] }): string {
  return report.checks.map((c) => `${c.status.padEnd(4)} ${c.name}: ${c.detail}`).join("\n");
}
