// Isolation end to end on a real Linux machine with systemd, as root (design
// section 4.1, the threat table): two projects (alpha, beta) each with prod
// and dev, the example app on alpha/prod and alpha/dev, and a deliberately
// hostile app on beta/dev. The hostile app's OWN function code — an
// httpAction, i.e. running as the tenant inside its sandbox, exactly like
// real tenant code — attempts to reach across the isolation boundary and
// reports what it could do; this test turns each attempt into one line of a
// table and fails only when a protection that must hold here was VIOLATED.
//
// Each probe is classified ENFORCED / NOT ENFORCED (expected on this
// platform) / VIOLATED. The platform expectations are explicit:
//   - a KVM VM (REQUIRE_SANDBOX=1): everything is enforced except
//     SocketBindDeny, which needs systemd's BPF framework that Ubuntu 24.04
//     builds without; host doctor reports that, which this test asserts
//     instead of asserting the bind fails.
//   - the OrbStack LXC container: /run/systemd/system/service.d/
//     zzz-lxc-service.conf also turns ProtectSystem, ProtectProc and
//     NoNewPrivileges off, so those are NOT ENFORCED there too.
// The cgroup network filter (IPAddressDeny/Allow), the private /tmp, the
// InaccessiblePaths, the empty capability set, the file owners and modes and
// the per-branch keys hold on both and are always required.
//
// The network probes have positive controls: a timeout is also what a probe
// gets when nothing is there and no filter exists, so it proves nothing on
// its own. For each IPAddressDeny entry root listens on an address in it
// (127.0.0.1 and ::1, the rest on a dummy interface), the branch's own uid
// connects from outside the sandbox before and after, and only then does the
// branch's failure to connect count as ENFORCED; a target the control cannot
// reach is INCONCLUSIVE (a failure on a VM). The connects go through libc, so
// the result is the kernel's errno: Bun.connect reports ENETUNREACH as
// ECONNREFUSED, which would read as a peer answering.
//
// Skipped unless INCIBASE_TEST_HOST=1 on Linux as root; needs
// INCIBASE_TEST_BINARY, a standalone incibase for this machine
// (`bun scripts/build-binary.ts`). Uses its own host root
// (INCIBASE_TEST_HOST_ROOT, default /var/lib/incibase-iso15), uid base
// (INCIBASE_TEST_UID_BASE, default 82000), unit prefix, groups, runtime root
// and dummy interface named after the root and uid base, and removes
// everything it created.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VERSION } from "../src/engine/version.ts";
import { openHost, type OpsContext } from "../src/host/context.ts";
import { runDoctor, systemdFeature } from "../src/host/doctor.ts";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { Registry, type BranchRow } from "../src/host/registry.ts";
import { IP_ADDRESS_DENY } from "../src/host/render.ts";
import { LinuxSystem } from "../src/host/system.ts";

const enabled = process.env.INCIBASE_TEST_HOST === "1" && process.platform === "linux" && process.getuid?.() === 0;
const ROOT = process.env.INCIBASE_TEST_HOST_ROOT ?? "/var/lib/incibase-iso15";
const UID_BASE = Number(process.env.INCIBASE_TEST_UID_BASE ?? 82000);
const BINARY = process.env.INCIBASE_TEST_BINARY ?? "";
const REQUIRE_SANDBOX = process.env.INCIBASE_TEST_REQUIRE_SANDBOX === "1";
const MARKER = ".incibase-test-root";
const LABEL = basename(ROOT).slice(0, 24);
const LAYOUT = {
  unitPrefix: LABEL,
  groups: { proxy: `${LABEL}-proxy`, admin: `${LABEL}-admin` },
  runtimeRoot: `/usr/local/lib/${LABEL}`,
  systemdDir: "/etc/systemd/system",
};
const APPS = `/tmp/${LABEL}-apps`;
const DOMAIN = "incibase.example.net";
const SLOW = 300_000;
/** zzz-lxc-service.conf turns ProtectSystem/ProtectProc/NoNewPrivileges off; on a VM it is absent. */
const LXC_OVERRIDE = "/run/systemd/system/service.d/zzz-lxc-service.conf";

/**
 * The network probes' targets, one or more per IPAddressDeny entry (`range`).
 * The ones with a `cidr` go on a dummy interface named and numbered after the
 * uid base, so two test hosts on one machine do not collide; each is a /32 or
 * /128 (the IPv6 link-local a /64 on the dummy alone), so no route the
 * machine uses changes. 169.254.250.x stands in for the metadata address.
 */
const NET_IF = `ibnet${UID_BASE}`.slice(0, 15);
const NET_N = Math.floor(UID_BASE / 1000) % 256;
const NET_HEX = NET_N.toString(16);
const NET_TARGETS: { key: string; range: string; host: string; cidr?: string }[] = [
  { key: "loopback4", range: "localhost", host: "127.0.0.1" },
  { key: "loopback6", range: "localhost", host: "::1" },
  { key: "private10", range: "10.0.0.0/8", host: `10.250.${NET_N}.1`, cidr: `10.250.${NET_N}.1/32` },
  { key: "private172", range: "172.16.0.0/12", host: `172.31.250.${NET_N}`, cidr: `172.31.250.${NET_N}/32` },
  { key: "private192", range: "192.168.0.0/16", host: `192.168.250.${NET_N}`, cidr: `192.168.250.${NET_N}/32` },
  { key: "cgnat", range: "100.64.0.0/10", host: `100.127.${NET_N}.1`, cidr: `100.127.${NET_N}.1/32` },
  { key: "linkLocal4", range: "169.254.0.0/16", host: `169.254.250.${NET_N}`, cidr: `169.254.250.${NET_N}/32` },
  { key: "ula", range: "fc00::/7", host: `fd00:1b5e:${NET_HEX}::1`, cidr: `fd00:1b5e:${NET_HEX}::1/128` },
  { key: "linkLocal6", range: "fe80::/10", host: `fe80::1b5e:${NET_HEX}%${NET_IF}`, cidr: `fe80::1b5e:${NET_HEX}/64` },
];
/** How long a probe or control waits for a connect; a local listener answers in well under a millisecond. */
const CONNECT_MS = 2000;

/**
 * `tcpConnect(host, port, ms)` as plain JS, shared by the hostile app and the
 * positive control: a non-blocking connect through libc, polled, giving
 * "open", "timeout" or "error <the kernel's errno>". Bun.connect (and
 * node:net) report a connect that failed with ENETUNREACH as ECONNREFUSED
 * (errno -111, Bun 1.4.3), which reads as "a peer answered". The numbers
 * are Linux's generic ones, the same on x86-64 and arm64, both little-endian.
 */
const TCP_CONNECT_JS = `
import { dlopen, FFIType, read } from "bun:ffi";
const ERRNO = { 1: "EPERM", 13: "EACCES", 22: "EINVAL", 97: "EAFNOSUPPORT", 99: "EADDRNOTAVAIL", 101: "ENETUNREACH", 104: "ECONNRESET", 110: "ETIMEDOUT", 111: "ECONNREFUSED", 113: "EHOSTUNREACH" };
let libc;
async function tcpConnect(host, port, ms) {
  try {
    const T = FFIType;
    libc ??= dlopen("libc.so.6", {
      socket: { args: [T.i32, T.i32, T.i32], returns: T.i32 },
      connect: { args: [T.i32, T.ptr, T.u32], returns: T.i32 },
      poll: { args: [T.ptr, T.u64, T.i32], returns: T.i32 },
      getsockopt: { args: [T.i32, T.i32, T.i32, T.ptr, T.ptr], returns: T.i32 },
      close: { args: [T.i32], returns: T.i32 },
      inet_pton: { args: [T.i32, T.ptr, T.ptr], returns: T.i32 },
      if_nametoindex: { args: [T.ptr], returns: T.u32 },
      __errno_location: { args: [], returns: T.ptr },
    }).symbols;
    const errno = () => read.i32(libc.__errno_location(), 0);
    const name = (n) => ERRNO[n] || "errno " + n;
    const cstr = (s) => Buffer.concat([Buffer.from(s), Buffer.alloc(1)]);
    const [addr, scope] = String(host).split("%");
    const v6 = addr.includes(":");
    const family = v6 ? 10 : 2; // AF_INET6, AF_INET
    const sa = Buffer.alloc(v6 ? 28 : 16); // sockaddr_in6 { family, port, flowinfo, addr[16], scope_id }, sockaddr_in { family, port, addr[4], zero[8] }
    sa.writeUInt16LE(family, 0);
    sa.writeUInt16BE(port, 2);
    if (libc.inet_pton(family, cstr(addr), sa.subarray(v6 ? 8 : 4)) !== 1) return "error probe: bad address " + host;
    if (scope) {
      const index = libc.if_nametoindex(cstr(scope));
      if (!index) return "error probe: no interface " + scope;
      sa.writeUInt32LE(index, 24);
    }
    const fd = libc.socket(family, 1 | 0o4000 | 0o2000000, 0); // SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC
    if (fd < 0) return "error " + name(errno()) + " (socket)";
    try {
      if (libc.connect(fd, sa, sa.length) === 0) return "open";
      const e = errno();
      // Anything but EINPROGRESS failed at once: no route, refused on this host, or denied.
      if (e !== 115) return "error " + name(e);
      const pfd = Buffer.alloc(8); // struct pollfd { int fd; short events; short revents; }
      pfd.writeInt32LE(fd, 0);
      pfd.writeInt16LE(4, 4); // POLLOUT
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (libc.poll(pfd, 1, 0) > 0) {
          const err = new Int32Array(1);
          libc.getsockopt(fd, 1, 4, err, new Uint32Array([4])); // SOL_SOCKET, SO_ERROR
          return err[0] === 0 ? "open" : "error " + name(err[0]);
        }
        await Bun.sleep(20);
      }
      return "timeout";
    } finally {
      libc.close(fd);
    }
  } catch (e) {
    return "error probe: " + ((e && e.message) || e);
  }
}
`;

/** The positive control, run as the branch's uid outside the sandbox: `tcpConnect` on each target, one CONTROL line of JSON. */
const CONTROL_JS = `${TCP_CONNECT_JS}
const out = {};
await Promise.all(JSON.parse(process.argv[2]).map(async (t) => { out[t.key] = await tcpConnect(t.host, t.port, t.ms); }));
console.log("CONTROL " + JSON.stringify(out));
process.exit(0);
`;

/**
 * Run as root in a fresh network namespace (`unshare --net`, gone with the
 * process): loopback up and nothing else, then the kernel's errno and
 * Bun.connect's for a ULA with no route, and a closed loopback port.
 */
const ERRNO_JS = `${TCP_CONNECT_JS}
const lo = Bun.spawnSync(["ip", "link", "set", "lo", "up"], { stderr: "pipe" });
if (lo.exitCode !== 0) throw new Error("ip link set lo up: " + lo.stderr);
const viaBun = (host, port) => new Promise((done) => {
  const t = setTimeout(() => done("timeout"), 2000);
  Bun.connect({ hostname: host, port, socket: { open(s) { clearTimeout(t); s.end(); done("open"); }, data() {}, connectError(_s, e) { clearTimeout(t); done("error " + (e.code || e.message)); } } })
    .catch((e) => { clearTimeout(t); done("error " + (e.code || e.message)); });
});
const out = { ula: await tcpConnect("fd00::1", 80, 2000), ulaBun: await viaBun("fd00::1", 80), closed: await tcpConnect("127.0.0.1", 1, 2000) };
console.log("ERRNO " + JSON.stringify(out));
process.exit(0);
`;

type NetVerdict = "ENFORCED" | "VIOLATED" | "INCONCLUSIVE (no positive control)" | "INCONCLUSIVE (unexplained)";

/**
 * One controlled network probe. `setup` is why its listener could not be
 * set up (null when it was); `control` what the branch's own uid got from
 * outside the sandbox just before and just after the probe; `sandboxed` what
 * the hostile branch got; `accepted` how many connections the listener took
 * while the branch probed. Results are "open", "timeout" or "error <errno>".
 * A connection or a peer's answer is a violation whatever the control says;
 * a block counts only when the control reached the same listener.
 */
function netVerdict(p: { setup: string | null; control: string[]; sandboxed: string; accepted: number }): { verdict: NetVerdict; why: string } {
  if (p.accepted > 0) return { verdict: "VIOLATED", why: `the listener took ${p.accepted} connection(s) while the branch probed` };
  if (p.sandboxed === "open") return { verdict: "VIOLATED", why: "the sandboxed connect succeeded" };
  if (p.sandboxed.startsWith("error ECONNREFUSED")) return { verdict: "VIOLATED", why: "a peer answered (ECONNREFUSED): the SYN left the sandbox" };
  if (p.setup !== null) return { verdict: "INCONCLUSIVE (no positive control)", why: `the target could not be set up: ${p.setup}` };
  if (p.control.length === 0 || p.control.some((c) => c !== "open")) {
    return {
      verdict: "INCONCLUSIVE (no positive control)",
      why: `outside the sandbox the branch's uid did not reach it either (${p.control.join(", ") || "no control ran"}), so a failure inside proves nothing`,
    };
  }
  if (p.sandboxed === "timeout" || /^error (EPERM|EACCES|ENETUNREACH)$/.test(p.sandboxed)) return { verdict: "ENFORCED", why: "reachable outside the sandbox, not from inside it" };
  return {
    verdict: "INCONCLUSIVE (unexplained)",
    why: `reachable outside the sandbox, but ${JSON.stringify(p.sandboxed)} from inside is neither a block (timeout, EPERM, EACCES, ENETUNREACH) nor a peer`,
  };
}

const sys = new LinuxSystem();
let ctx: OpsContext;

function run(command: string[], options: { ok?: number[] } = {}) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const code = result.exitCode ?? -1;
  if (!(options.ok ?? [0]).includes(code)) throw new Error(`${command.join(" ")} exited ${code}: ${result.stderr.toString()}${result.stdout.toString()}`);
  return { code, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Removes every unit, user, group, directory, listener and interface this test host made. */
function cleanup() {
  netDown();
  const prefix = LAYOUT.unitPrefix;
  const units = run(["systemctl", "list-units", "--all", "--plain", "--no-legend", `${prefix}-*`]).stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u): u is string => !!u && u.startsWith(`${prefix}-`));
  for (const unit of [...units, `${prefix}.slice`]) {
    run(["systemctl", "stop", unit], { ok: [0, 1, 5] });
    run(["systemctl", "reset-failed", unit], { ok: [0, 1, 5] });
  }
  for (const dir of [LAYOUT.systemdDir, join(LAYOUT.systemdDir, "multi-user.target.wants"), join(LAYOUT.systemdDir, "timers.target.wants")]) {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      if (name.startsWith(`${prefix}-`) || name === `${prefix}.slice`) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
  run(["systemctl", "daemon-reload"]);
  if (existsSync(join(ROOT, "control", "registry.db"))) {
    const registry = Registry.open(new HostLayout({ root: ROOT, ...LAYOUT }));
    for (const branch of registry.listBranches()) {
      for (const pid of sys.processesOf(branch.os_uid)) process.kill(pid, "SIGKILL");
      const user = sys.getpwnam(`ib-${branch.id}`);
      if (user && user.uid === branch.os_uid) sys.userdel(user.name);
      const group = sys.getgrnam(`ib-${branch.id}`);
      if (group && group.gid === branch.os_uid) sys.groupdel(group.name);
    }
    registry.close();
  }
  for (const group of [LAYOUT.groups.proxy, LAYOUT.groups.admin]) if (sys.getgrnam(group)) sys.groupdel(group);
  for (const dir of ["/run", "/var/tmp"]) for (const name of readdirSync(dir)) if (name.startsWith(`${prefix}-doctor-`)) rmSync(join(dir, name), { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(LAYOUT.runtimeRoot, { recursive: true, force: true });
  rmSync(APPS, { recursive: true, force: true });
}

// ---- the network probes' targets and controls ----------------------------------

interface NetTarget {
  key: string;
  /** The table row: address, port and the IPAddressDeny entry it is in. */
  probe: string;
  host: string;
  /** The listener's port; 0 when it could not be set up. */
  port: number;
  /** Why the target could not be set up, or null. */
  setup: string | null;
}

/** Root's listeners for the network probes, by target, each counting the connections it took. */
const listeners = new Map<string, { accepted: number; stop(): void }>();

/** Stops the probe listeners and removes the dummy interface. */
function netDown() {
  for (const listener of listeners.values()) listener.stop();
  listeners.clear();
  if (existsSync(`/sys/class/net/${NET_IF}`)) run(["ip", "link", "del", NET_IF]);
}

/**
 * Puts the targets up: the dummy interface and its addresses, and on each
 * target a listener of root's that counts what it accepts and closes it. A
 * target that cannot be set up keeps the reason; its probe is INCONCLUSIVE.
 */
function netUp(): NetTarget[] {
  netDown();
  const failure = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (err) {
      return (err as Error).message.trim().split("\n")[0]!;
    }
  };
  const link = failure(() => {
    run(["ip", "link", "add", NET_IF, "type", "dummy"]);
    // A machine may start new links with IPv6 off (net.ipv6.conf.default.disable_ipv6); only this one is switched on.
    const v6 = `/proc/sys/net/ipv6/conf/${NET_IF}/disable_ipv6`;
    if (existsSync(v6)) writeFileSync(v6, "0");
    run(["ip", "link", "set", NET_IF, "up"]);
  });
  return NET_TARGETS.map((t) => {
    let setup = t.cidr && link ? `the dummy interface ${NET_IF}: ${link}` : null;
    // nodad: an IPv6 address is usable at once instead of after duplicate address detection.
    if (t.cidr && !setup) setup = failure(() => run(["ip", "addr", "add", t.cidr!, "dev", NET_IF, ...(t.cidr!.includes(":") ? ["nodad"] : [])]));
    let port = 0;
    if (!setup) {
      setup = failure(() => {
        const entry = { accepted: 0, stop: () => {} };
        const listener = Bun.listen({
          hostname: t.host,
          port: 0,
          socket: {
            open(socket) {
              entry.accepted++;
              socket.end();
            },
            data() {},
          },
        });
        entry.stop = () => listener.stop(true);
        listeners.set(t.key, entry);
        port = listener.port;
      });
    }
    const where = port === 0 ? t.host : t.host.includes(":") ? `[${t.host}]:${port}` : `${t.host}:${port}`;
    return { key: t.key, probe: `TCP to ${where} (${t.range})`, host: t.host, port, setup };
  });
}

const accepted = () => new Map([...listeners].map(([key, l]) => [key, l.accepted]));

/**
 * The positive control: CONTROL_JS with the installed runtime as the
 * branch's own uid and group, outside any sandbox; what it got per target.
 * Returns once each listener has counted the connections the control made.
 */
async function netControl(b: BranchRow, targets: NetTarget[]): Promise<Record<string, string>> {
  const live = targets.filter((t) => t.port !== 0);
  const before = accepted();
  const file = join(APPS, "net-control.mjs");
  writeFileSync(file, CONTROL_JS, { mode: 0o644 });
  const argv = ["setpriv", `--reuid=${b.os_uid}`, `--regid=${b.os_uid}`, "--clear-groups", "--", ctx.layout.runtimeBinary(VERSION), file];
  argv.push(JSON.stringify(live.map((t) => ({ key: t.key, host: t.host, port: t.port, ms: CONNECT_MS }))));
  const env = { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/nonexistent", NO_COLOR: "1", BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const line = stdout.split("\n").find((l) => l.startsWith("CONTROL "));
  if (!line) {
    const why = (stderr.trim() || stdout.trim() || `exit ${proc.exitCode}`).split("\n").at(-1);
    return Object.fromEntries(live.map((t) => [t.key, `error control did not run: ${why}`]));
  }
  const got = JSON.parse(line.slice("CONTROL ".length)) as Record<string, string>;
  // Each "open" is one connection its listener accepts; wait for those so none is counted as the branch's later.
  await waitFor(
    "the listeners to count the control's connections",
    () => live.every((t) => (accepted().get(t.key) ?? 0) >= (before.get(t.key) ?? 0) + (got[t.key] === "open" ? 1 : 0)),
    5000,
  );
  return got;
}

/** What explains a network verdict in a CI log: the branch's filter as systemd parsed it, and this machine's IPv6 addresses and routes. */
function netDiagnostics(unit: string) {
  const lines = ["", "  network diagnostics:"];
  for (const argv of [
    ["systemctl", "show", "-p", "IPAddressDeny", "-p", "IPAddressAllow", unit],
    ["ip", "-6", "addr"],
    ["ip", "-6", "route"],
    ["ip", "-6", "route", "get", "fd00::1"],
  ]) {
    let text: string;
    try {
      const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
      text = `${result.stdout.toString()}${result.stderr.toString()}`.trimEnd() + (result.exitCode ? ` (exit ${result.exitCode})` : "");
    } catch (err) {
      text = `(cannot run: ${(err as Error).message})`;
    }
    lines.push(`    $ ${argv.join(" ")}`, ...text.split("\n").map((l) => `      ${l}`));
  }
  console.log(lines.join("\n"));
}

/**
 * The hostile app: the example app plus two httpActions. `/probe` runs, as
 * the beta/dev tenant, every attempt in the threat table against alpha's
 * files, sockets, process and the network, and returns one JSON object of
 * what it got. `/oom` allocates without bound so the cgroup OOM killer takes
 * the branch (and only it). Both run tenant code; root runs neither.
 */
const PROBE_ROUTES = `
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { lookup } from "node:dns";
${TCP_CONNECT_JS}
const code = (e: any) => "error " + ((e && (e.code || e.message)) || "unknown");
const attempt = (fn: () => unknown) => { try { const r = fn(); return "ok" + (r === undefined ? "" : " " + String(r)); } catch (e) { return code(e); } };
const connect = (opts: any) => new Promise<string>((done) => {
  const t = setTimeout(() => done("timeout"), 1500);
  try {
    Bun.connect({ ...opts, socket: { open(s: any) { clearTimeout(t); s.end(); done("open"); }, data() {}, connectError(_s: any, e: any) { clearTimeout(t); done("error " + (e.code || e.message)); } } })
      .catch((e: any) => { clearTimeout(t); done("error " + (e.code || e.message)); });
  } catch (e) { clearTimeout(t); done(code(e)); }
});

http.route({
  path: "/probe",
  method: "POST",
  handler: httpAction(async (_ctx, req) => {
    const t = (await req.json()) as any;
    const a = t.alpha;
    const out: Record<string, unknown> = {};
    out.uid = process.getuid?.();
    // Another branch's data, storage, env file and the control plane.
    out.alphaDataDir = attempt(() => readdirSync(a.dataDir).length);
    out.alphaDb = attempt(() => readFileSync(a.dataDb).length);
    out.alphaStorage = attempt(() => readdirSync(a.storageDir).length);
    out.alphaEnv = attempt(() => readFileSync(a.envFile).length);
    out.control = attempt(() => readdirSync(t.control).length);
    // Another branch's sockets.
    out.httpSock = await connect({ unix: a.httpSock });
    out.adminSock = await connect({ unix: a.adminSock });
    // Another branch's process.
    out.procCmdline = attempt(() => readFileSync("/proc/" + a.pid + "/cmdline", "utf8").length);
    out.procEnviron = attempt(() => readFileSync("/proc/" + a.pid + "/environ").length);
    out.procVisible = attempt(() => (readdirSync("/proc").includes(String(a.pid)) ? "yes" : "no"));
    out.kill = attempt(() => { process.kill(a.pid, "SIGKILL"); return "killed"; });
    // Its own cwd, the root filesystem, its preflight dir, and its own data dir.
    out.cwdWrite = attempt(() => writeFileSync(".incibase-probe", "x"));
    out.rootWrite = attempt(() => writeFileSync("/incibase-probe", "x"));
    out.preflightWrite = attempt(() => writeFileSync(t.selfPreflight + "/probe", "x"));
    out.ownData = attempt(() => { writeFileSync(t.selfData + "/probe", "x"); return "wrote"; });
    // The /tmp size limit.
    out.tmpLimit = attempt(() => {
      const fd = openSync("/tmp/incibase-probe-big", "w");
      try { const buf = Buffer.alloc(1024 * 1024, 7); for (let i = 0; i < 128; i++) writeSync(fd, buf); } finally { closeSync(fd); }
      return "wrote 128M";
    });
    // The network: root's listeners on loopback, private, CGNAT, link-local and IPv6 addresses (t.net) are not
    // reachable, the DNS stub is, names resolve. All at once: each waits up to its own timeout.
    const net = await Promise.all(t.net.map(async (n: any) => [n.key, await tcpConnect(n.host, n.port, n.ms)]));
    out.net = Object.fromEntries(net);
    // Addresses nothing of ours listens on (no positive control); Bun.connect's view kept beside the kernel's.
    const bare = await Promise.all(
      [["metadata", "169.254.169.254"], ["privateV4", "10.0.0.1"], ["ulaV6", "fd00::1"]].map(async ([key, host]) => {
        const [libc, bun] = await Promise.all([tcpConnect(host, 80, 1500), connect({ hostname: host, port: 80 })]);
        return [key, { libc, bun }];
      }),
    );
    out.noControl = Object.fromEntries(bare);
    out.stub = await tcpConnect("127.0.0.53", 53, 1500);
    out.resolve = await new Promise<string>((done) => { const to = setTimeout(() => done("timeout"), 5000); try { lookup("example.com", (e, addr) => { clearTimeout(to); done(e ? code(e) : "ok " + addr); }); } catch (e) { clearTimeout(to); done(code(e)); } });
    // A TCP listener (SocketBindDeny).
    out.bind = attempt(() => { const s = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } }); const p = s.port; s.stop(true); return "bound:" + p; });
    // Privilege escalation: the capability set is empty and NoNewPrivileges is set.
    const status = readFileSync("/proc/self/status", "utf8");
    out.capEff = /^CapEff:\\s+(\\S+)/m.exec(status)?.[1];
    out.noNewPrivs = /^NoNewPrivs:\\s+(\\d)/m.exec(status)?.[1];
    return Response.json({ ran: true, out });
  }),
});

const hog: unknown[] = [];
http.route({
  path: "/oom",
  method: "GET",
  handler: httpAction(async () => {
    for (;;) { hog.push(Buffer.alloc(8 * 1024 * 1024, 1)); await Bun.sleep(0); }
    return Response.json({ ok: true });
  }),
});

export default http;`;

/** Bundled as `nobody` with the standalone binary; bundling runs the app's top-level code, which root never does. */
function bundleApp(name: string, hostile = false): string {
  const dir = join(APPS, name);
  cpSync(join(import.meta.dir, "..", "example"), dir, { recursive: true });
  if (hostile) {
    const http = join(dir, "incibase", "http.ts");
    writeFileSync(http, readFileSync(http, "utf8").replace("export default http;", PROBE_ROUTES.trimStart()));
  }
  run(["chown", "-R", "nobody:nogroup", dir]);
  run(["setpriv", "--reuid=nobody", "--regid=nogroup", "--clear-groups", "--", "env", `HOME=${dir}`, join(APPS, "incibase"), "bundle", "--dir", join(dir, "incibase"), "--out", join(dir, "app.ib")]);
  return join(dir, "app.ib");
}

const paths = (b: BranchRow) => ctx.layout.branch(b.id);
const unitOf = (b: BranchRow) => ctx.layout.units.branch(b.id);
const branch = (project: string, name: string) => ctx.registry.findBranch(project, name)!;
const show = (b: BranchRow) => ctx.driver.show(unitOf(b));

async function call(socket: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  let res: Response;
  try {
    res = await fetch(`http://localhost${path}`, {
      unix: socket,
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    } as RequestInit);
  } catch (err) {
    // The socket file is there but nothing listens (the branch is stopped, killed or restarting): not an answer.
    return { status: 0, json: null as any, error: (err as Error).message };
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, error: undefined as string | undefined };
}

const health = (b: BranchRow) => call(paths(b).adminSock, "/api/health");

async function signUp(b: BranchRow, email: string) {
  const res = await call(paths(b).httpSock, "/api/auth/signup", { body: { email, password: "correct horse battery staple" } });
  expect(res.status).toBe(200);
  return res.json.token as string;
}

async function waitFor<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 60_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
}

describe.skipIf(!enabled)("isolation between branches", () => {
  const noBpf = () => systemdFeature(run(["systemctl", "--version"]).stdout, "BPF_FRAMEWORK") === false;
  const lxcOverride = () => existsSync(LXC_OVERRIDE);

  beforeAll(async () => {
    if (ROOT === DEFAULT_ROOT) throw new Error(`Refusing to test on ${DEFAULT_ROOT}`);
    if (!BINARY || !existsSync(BINARY)) throw new Error("Set INCIBASE_TEST_BINARY to a standalone incibase for this machine (bun scripts/build-binary.ts)");
    if (existsSync(ROOT) && !existsSync(join(ROOT, MARKER))) throw new Error(`${ROOT} exists and is not a test root; remove it or pick another INCIBASE_TEST_HOST_ROOT`);
    cleanup();
    mkdirSync(ROOT, { mode: 0o755 });
    writeFileSync(join(ROOT, MARKER), "");
    mkdirSync(APPS, { mode: 0o755 });
    cpSync(BINARY, join(APPS, "incibase"));
    chmodSync(join(APPS, "incibase"), 0o755);
    ctx = openHost({ root: ROOT, layout: LAYOUT });
    ctx.actor = "root:test";
    ctx.log = (line) => console.log(`  | ${line}`);
    // The check timer stays off: its own health check would race these tests (test/host-check-linux.test.ts runs it).
    await ops.initHost(ctx, { domain: DOMAIN, timezone: "Europe/Istanbul", uidBase: UID_BASE, sliceMemoryMax: 2 * 1024 ** 3, checkTimer: false });
    await ops.installRuntime(ctx, { binary: BINARY, version: VERSION, sha256: new Bun.CryptoHasher("sha256").update(readFileSync(BINARY)).digest("hex") });
    await ops.createProject(ctx, { slug: "alpha", branches: ["prod", "dev"] });
    await ops.createProject(ctx, { slug: "beta", branches: ["prod", "dev"] });
    const example = bundleApp("example");
    for (const name of ["prod", "dev"]) expect((await ops.addRelease(ctx, { project: "alpha", branch: name, file: example })).release.status).toBe("live");
    expect((await ops.addRelease(ctx, { project: "beta", branch: "dev", file: bundleApp("hostile", true) })).release.status).toBe("live");
  }, SLOW);

  afterAll(() => {
    try {
      ctx?.registry.close();
    } finally {
      // The listeners and the dummy interface go too, whatever failed before.
      if (enabled) cleanup();
    }
  });

  test("a hostile branch cannot cross into another branch, the host, or the network (the threat table)", async () => {
    const alpha = branch("alpha", "prod");
    const beta = branch("beta", "dev");
    // Give alpha data to steal, and give its process a key in its environ to read.
    await signUp(alpha, "owner@alpha.example");
    const alphaBefore = show(alpha);
    const aPaths = paths(alpha);
    const body = {
      alpha: {
        dataDir: aPaths.data,
        dataDb: join(aPaths.data, "data.db"),
        storageDir: join(aPaths.data, "storage"),
        envFile: aPaths.envFile,
        httpSock: aPaths.httpSock,
        adminSock: aPaths.adminSock,
        pid: alphaBefore.mainPid,
      },
      control: ctx.layout.control,
      selfPreflight: paths(beta).preflight,
      selfData: paths(beta).data,
      net: [] as { key: string; host: string; port: number; ms: number }[],
    };
    // The network targets, each reached by beta's uid from outside the sandbox just before and just after the probe.
    netDiagnostics(unitOf(beta));
    const targets = netUp();
    body.net = targets.filter((t) => t.port !== 0).map((t) => ({ key: t.key, host: t.host, port: t.port, ms: CONNECT_MS }));
    const controlBefore = await netControl(beta, targets);
    const acceptedBefore = accepted();
    const res = await call(paths(beta).httpSock, "/probe", { body });
    // A connection the probe made reaches the listener's callback on a later tick.
    await Bun.sleep(250);
    const acceptedDuring = accepted();
    const controlAfter = await netControl(beta, targets);
    expect(res.status).toBe(200);
    // The probe's JSON blob: each field is a string ("ok …" / "error …" / "timeout" / "open"), except uid and the network results.
    const out = res.json.out as Record<string, unknown> & { uid: number; net: Record<string, string>; noControl: Record<string, { libc: string; bun: string }> };
    const field = (key: string): string => String(out[key] ?? "");
    expect(out.uid).toBe(beta.os_uid);

    // alpha keeps serving: nothing the probe did touched it.
    expect((await health(alpha)).json).toMatchObject({ ok: true, generation: alpha.generation });
    expect(show(alpha).mainPid).toBe(alphaBefore.mainPid);

    // Each probe: what must hold everywhere, and the directives a platform may switch off.
    const table: { probe: string; verdict: string; detail: string }[] = [];
    const violations: string[] = [];
    const undecided: string[] = [];
    const isError = (v: string) => v.startsWith("error");
    const required = (probe: string, ok: boolean, detail: string) => {
      table.push({ probe, verdict: ok ? "ENFORCED" : "VIOLATED", detail });
      if (!ok) violations.push(`${probe}: ${detail}`);
    };
    const directive = (probe: string, effective: boolean, expected: boolean, detail: string) => {
      const verdict = effective ? "ENFORCED" : expected ? "VIOLATED" : "NOT ENFORCED (expected on this platform)";
      table.push({ probe, verdict, detail });
      if (!effective && expected) violations.push(`${probe}: ${detail}`);
    };

    // Another branch's data, env and the control plane: unreadable.
    required("read alpha data dir", isError(field("alphaDataDir")), field("alphaDataDir"));
    required("read alpha data.db", isError(field("alphaDb")), field("alphaDb"));
    required("read alpha storage", isError(field("alphaStorage")), field("alphaStorage"));
    required("read alpha env file", isError(field("alphaEnv")), field("alphaEnv"));
    required("read control registry", isError(field("control")), field("control"));
    // Another branch's sockets: no permission to connect.
    required("connect alpha http.sock", isError(field("httpSock")), field("httpSock"));
    required("connect alpha admin.sock", isError(field("adminSock")), field("adminSock"));
    // Another branch's process: its environ holds the other branch's keys (kernel-enforced), and it cannot be killed.
    required("read alpha /proc environ", isError(field("procEnviron")), field("procEnviron"));
    required("kill alpha process", isError(field("kill")), field("kill"));
    // The branch may write only its own data dir.
    required("write own cwd (read-only)", isError(field("cwdWrite")), field("cwdWrite"));
    required("write own data dir", field("ownData").startsWith("ok"), field("ownData"));
    // The /tmp size limit.
    required("exceed /tmp size limit", field("tmpLimit").includes("ENOSPC"), field("tmpLimit"));
    // The network filter (cgroup BPF: effective on a VM and in a container), against root's listeners. A target the
    // control could not reach is INCONCLUSIVE: a failure where every directive must hold (a VM), reported elsewhere;
    // a sandboxed result that is neither a block nor a peer although the control got through fails everywhere.
    for (const t of targets) {
      const control = t.port === 0 ? [] : [controlBefore[t.key] ?? "missing", controlAfter[t.key] ?? "missing"];
      const sandboxed = out.net?.[t.key] ?? (t.port === 0 ? "not probed" : "missing");
      const took = (acceptedDuring.get(t.key) ?? 0) - (acceptedBefore.get(t.key) ?? 0);
      const { verdict, why } = netVerdict({ setup: t.setup, control, sandboxed, accepted: took });
      const detail = `${why}; sandboxed: ${sandboxed}; outside, before and after: ${control.join(", ") || "-"}; listener took ${took} while probed`;
      table.push({ probe: t.probe, verdict, detail });
      if (verdict === "VIOLATED") violations.push(`${t.probe}: ${detail}`);
      else if (verdict === "INCONCLUSIVE (unexplained)" || (verdict !== "ENFORCED" && REQUIRE_SANDBOX)) undecided.push(`${t.probe}: ${verdict}: ${detail}`);
    }
    // Nothing of ours listens on these, so a timeout is also what no filter gives: shown, never a verdict.
    for (const [key, probe] of [["metadata", "169.254.169.254:80 (metadata)"], ["privateV4", "10.0.0.1:80"], ["ulaV6", "[fd00::1]:80"]] as const) {
      const got = out.noControl?.[key];
      table.push({ probe: `TCP to ${probe}`, verdict: "INFO (no control)", detail: `kernel: ${got?.libc ?? "missing"}; Bun.connect: ${got?.bun ?? "missing"}` });
    }
    required("TCP to 127.0.0.53 (DNS stub, allowed)", field("stub") !== "timeout", field("stub"));
    required("resolve a name (allowed)", field("resolve").startsWith("ok"), field("resolve"));
    // No capabilities at all.
    required("no capabilities", field("capEff") === "0000000000000000", `CapEff ${field("capEff")}`);

    // Directives a container may switch off; on a VM (REQUIRE_SANDBOX) they must hold.
    const lxc = lxcOverride();
    directive("ProtectSystem (/ read-only)", field("rootWrite").startsWith("error EROFS"), !lxc, `writing /: ${field("rootWrite")}, preflight/: ${field("preflightWrite")}`);
    directive("ProtectProc (alpha /proc hidden)", isError(field("procCmdline")), !lxc, `alpha /proc/<pid>/cmdline: ${field("procCmdline")}, in /proc listing: ${field("procVisible")}`);
    directive("NoNewPrivileges", field("noNewPrivs") === "1", !lxc, `NoNewPrivs ${field("noNewPrivs")}`);
    // SocketBindDeny needs the BPF framework; Ubuntu 24.04 builds systemd without it (VM too). doctor reports it (asserted below).
    // "error …" means the bind was denied; "ok bound:<port>" means it was allowed (the directive had no effect).
    directive("SocketBindDeny (bind a listener)", field("bind").startsWith("error"), !noBpf(), `listening on 0.0.0.0: ${field("bind")}`);

    console.log(`\n  isolation probes (uid ${out.uid}, platform ${lxc ? "LXC container" : "VM"}${noBpf() ? ", -BPF_FRAMEWORK" : ""}):`);
    for (const row of table) console.log(`    ${row.verdict.padEnd(40)} ${row.probe}: ${row.detail}`);

    expect(violations).toEqual([]);
    expect(undecided).toEqual([]);
    if (REQUIRE_SANDBOX) {
      // On a VM every directive takes effect except SocketBindDeny where this systemd cannot apply it.
      const allowed = noBpf() ? ["SocketBindDeny (bind a listener)"] : [];
      expect(table.filter((r) => r.verdict.startsWith("NOT ENFORCED")).map((r) => r.probe)).toEqual(allowed);
    }
  }, SLOW);

  test("the probes' connect reports the kernel's errno, where Bun.connect calls no route a refusal", () => {
    // Only loopback up, so no route to an IPv6 ULA: what a machine without IPv6 routing (a CI runner) gives for fd00::1.
    const file = join(APPS, "net-errno.mjs");
    writeFileSync(file, ERRNO_JS, { mode: 0o644 });
    const { stdout } = run(["unshare", "--net", "--", "env", "BUN_BE_BUN=1", "HOME=/nonexistent", "NO_COLOR=1", ctx.layout.runtimeBinary(VERSION), file]);
    const got = JSON.parse(stdout.split("\n").find((l) => l.startsWith("ERRNO "))?.slice("ERRNO ".length) ?? "null") as Record<string, string>;
    console.log(`  no route to [fd00::1]:80: kernel ${got.ula}, Bun.connect ${got.ulaBun}; closed 127.0.0.1:1: kernel ${got.closed}`);
    expect(got.ula).toBe("error ENETUNREACH");
    expect(got.closed).toBe("error ECONNREFUSED");
  }, SLOW);

  test("host doctor reports whether SocketBindDeny is in force", async () => {
    const report = await runDoctor(ctx);
    const bind = report.checks.find((c) => c.name === "sandbox SocketBindDeny")!;
    console.log(`  doctor: ${bind.status.padEnd(4)} ${bind.name}: ${bind.detail}`);
    if (noBpf()) {
      expect(bind.status).toBe("WARN");
      expect(bind.detail).toStartWith("unsupported by this systemd build (-BPF_FRAMEWORK)");
    } else {
      // A build with the BPF framework: on a VM it is OK, in a container that drops it a WARN, never a silent pass.
      expect(["OK", "WARN"]).toContain(bind.status);
      if (REQUIRE_SANDBOX) expect(bind.status).toBe("OK");
    }
    // The network filter works even in a container: always OK.
    expect(report.checks.find((c) => c.name === "sandbox IPAddressDeny")!.status).toBe("OK");
  }, SLOW);

  test("keys and group memberships do not cross branches, and a branch's files are its own", async () => {
    const alphaProd = branch("alpha", "prod");
    const alphaDev = branch("alpha", "dev");
    const beta = branch("beta", "dev");

    // A dev branch's admin key does not open prod's admin socket.
    const devKey = (await ops.adminKey(ctx, { project: "alpha", branch: "dev" })).key;
    const prodKey = (await ops.adminKey(ctx, { project: "alpha", branch: "prod" })).key;
    const overview = (b: BranchRow, token: string) => call(paths(b).adminSock, "/api/admin/admin_overview", { body: {}, token });
    expect((await overview(alphaProd, prodKey)).status).toBe(200);
    expect([401, 403]).toContain((await overview(alphaProd, devKey)).status);
    expect((await overview(alphaDev, devKey)).status).toBe(200);

    // A service key of beta is unknown to alpha: alpha runs no internal function for it.
    const svc = await ops.serviceKeyCreate(ctx, { project: "beta", branch: "dev", label: "cross" });
    const bump = (b: BranchRow, token: string) => call(paths(b).httpSock, "/api/mutation", { body: { path: "messages:bumpCount", args: { key: "svc" } }, token });
    expect((await bump(beta, svc.key)).status).toBe(200);
    expect((await bump(alphaDev, svc.key)).status).not.toBe(200);

    // A branch's files are its own: data dir 0700, data.db 0600, both owned by its uid, and the proxy group cannot read them.
    await signUp(beta, "owner@beta.example");
    const proxyGid = sys.getgrnam(LAYOUT.groups.proxy)!.gid;
    const data = statSync(paths(beta).data);
    expect({ uid: data.uid, gid: data.gid, mode: data.mode & 0o777 }).toEqual({ uid: beta.os_uid, gid: beta.os_uid, mode: 0o700 });
    expect(data.gid).not.toBe(proxyGid);
    const db = statSync(join(paths(beta).data, "data.db"));
    expect({ uid: db.uid, mode: db.mode & 0o777 }).toEqual({ uid: beta.os_uid, mode: 0o600 });
    // The socket the proxy group does reach is the run dir, not the data: 2750, group proxy.
    const http = statSync(paths(beta).httpSock);
    expect({ uid: http.uid, gid: http.gid, mode: http.mode & 0o777 }).toEqual({ uid: beta.os_uid, gid: proxyGid, mode: 0o770 });
  }, SLOW);

  test("a branch that exhausts memory is OOM-killed in its own cgroup while another branch keeps serving", async () => {
    const alpha = branch("alpha", "prod");
    const beta = branch("beta", "dev");
    const before = show(beta);
    expect((await health(alpha)).json).toMatchObject({ ok: true });
    // The hostile /oom allocates without bound; the request never returns, because the process dies under it.
    await call(paths(beta).httpSock, "/oom", { method: "GET" }).catch(() => null);
    // beta's process is gone (cgroup OOM), then systemd starts it again (Restart=on-failure).
    const after = await waitFor(
      "beta to be restarted after the OOM kill",
      () => {
        const now = show(beta);
        return now.mainPid !== before.mainPid && now.mainPid !== 0 ? now : null;
      },
      120_000,
    );
    expect(after.mainPid).not.toBe(before.mainPid);
    expect(existsSync(`/proc/${before.mainPid}`)).toBe(false);
    // alpha never stopped serving: the OOM stayed inside beta's cgroup.
    expect((await health(alpha)).json).toMatchObject({ ok: true, generation: alpha.generation });
    expect(show(alpha).mainPid).toBeGreaterThan(0);
    // beta serves again once it comes back.
    expect((await waitFor("beta healthy again", async () => ((await health(beta)).json?.ok ? true : null), 60_000))).toBe(true);
  }, SLOW);
});

// How a controlled network probe is judged; runs everywhere.
describe("network probe verdicts", () => {
  const open = ["open", "open"];
  const verdict = (sandboxed: string, control = open, accepted = 0, setup: string | null = null) => netVerdict({ setup, control, sandboxed, accepted }).verdict;

  test("every IPAddressDeny entry has a target with a listener", () => {
    expect([...new Set(NET_TARGETS.map((t) => t.range))].sort()).toEqual(IP_ADDRESS_DENY.split(" ").sort());
    expect(NET_IF.length).toBeLessThanOrEqual(15);
    expect(new Set(NET_TARGETS.map((t) => t.host)).size).toBe(NET_TARGETS.length);
  });

  test("a block counts only when the branch's uid reached the listener outside the sandbox", () => {
    for (const blocked of ["timeout", "error EPERM", "error EACCES", "error ENETUNREACH"]) expect(verdict(blocked)).toBe("ENFORCED");
    expect(verdict("timeout", ["open", "timeout"])).toBe("INCONCLUSIVE (no positive control)");
    expect(verdict("timeout", ["error ENETUNREACH", "open"])).toBe("INCONCLUSIVE (no positive control)");
    expect(verdict("timeout", [])).toBe("INCONCLUSIVE (no positive control)");
    expect(verdict("not probed", [], 0, "RTNETLINK answers: Permission denied")).toBe("INCONCLUSIVE (no positive control)");
  });

  test("a connection, a peer's answer, or a connection the listener saw is a violation whatever the control says", () => {
    expect(verdict("open")).toBe("VIOLATED");
    expect(verdict("open", ["timeout", "timeout"])).toBe("VIOLATED");
    expect(verdict("error ECONNREFUSED")).toBe("VIOLATED");
    expect(verdict("error ECONNREFUSED", [], 0, "no dummy interface")).toBe("VIOLATED");
    // The probe said timeout, but the listener took a connection while it ran.
    expect(verdict("timeout", open, 1)).toBe("VIOLATED");
  });

  test("anything else from inside, with the control through, is unexplained rather than a pass", () => {
    for (const odd of ["error EHOSTUNREACH", "error EADDRNOTAVAIL", "error probe: dlopen failed", "missing", ""]) {
      expect(verdict(odd)).toBe("INCONCLUSIVE (unexplained)");
    }
  });
});
