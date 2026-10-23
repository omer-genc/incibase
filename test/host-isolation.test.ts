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
// Skipped unless INCIBASE_TEST_HOST=1 on Linux as root; needs
// INCIBASE_TEST_BINARY, a standalone incibase for this machine
// (`bun scripts/build-binary.ts`). Uses its own host root
// (INCIBASE_TEST_HOST_ROOT, default /var/lib/incibase-iso15), uid base
// (INCIBASE_TEST_UID_BASE, default 82000), unit prefix, groups and runtime
// root named after the root, and removes everything it created.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VERSION } from "../src/engine/version.ts";
import { openHost, type OpsContext } from "../src/host/context.ts";
import { runDoctor, systemdFeature } from "../src/host/doctor.ts";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { Registry, type BranchRow } from "../src/host/registry.ts";
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

const sys = new LinuxSystem();
let ctx: OpsContext;

function run(command: string[], options: { ok?: number[] } = {}) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const code = result.exitCode ?? -1;
  if (!(options.ok ?? [0]).includes(code)) throw new Error(`${command.join(" ")} exited ${code}: ${result.stderr.toString()}${result.stdout.toString()}`);
  return { code, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Removes every unit, user, group and directory this test host made. */
function cleanup() {
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
    // The network: local and private peers are dropped, the DNS stub is reachable, names resolve.
    out.loopback = await connect({ hostname: "127.0.0.1", port: 22 });
    out.metadata = await connect({ hostname: "169.254.169.254", port: 80 });
    out.privateV4 = await connect({ hostname: "10.0.0.1", port: 80 });
    out.ulaV6 = await connect({ hostname: "fd00::1", port: 80 });
    out.stub = await connect({ hostname: "127.0.0.53", port: 53 });
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
    ctx?.registry.close();
    if (enabled) cleanup();
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
    };
    const res = await call(paths(beta).httpSock, "/probe", { body });
    expect(res.status).toBe(200);
    // The probe's JSON blob: each field is a string ("ok …" / "error …" / "timeout" / "open"), except uid.
    const out = res.json.out as Record<string, string> & { uid: number };
    const field = (key: string): string => String(out[key] ?? "");
    expect(out.uid).toBe(beta.os_uid);

    // alpha keeps serving: nothing the probe did touched it.
    expect((await health(alpha)).json).toMatchObject({ ok: true, generation: alpha.generation });
    expect(show(alpha).mainPid).toBe(alphaBefore.mainPid);

    // Each probe: what must hold everywhere, and the directives a platform may switch off.
    const table: { probe: string; verdict: string; detail: string }[] = [];
    const violations: string[] = [];
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
    // The network filter (cgroup BPF: effective on a VM and in a container).
    required("TCP to 127.0.0.1 (another branch)", field("loopback") === "timeout", field("loopback"));
    required("TCP to 169.254.169.254 (metadata)", field("metadata") === "timeout", field("metadata"));
    required("TCP to 10.0.0.1 (private)", field("privateV4") === "timeout", field("privateV4"));
    required("TCP to an IPv6 ULA", field("ulaV6") === "timeout", field("ulaV6"));
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
    if (REQUIRE_SANDBOX) {
      // On a VM every directive takes effect except SocketBindDeny where this systemd cannot apply it.
      const allowed = noBpf() ? ["SocketBindDeny (bind a listener)"] : [];
      expect(table.filter((r) => r.verdict.startsWith("NOT ENFORCED")).map((r) => r.probe)).toEqual(allowed);
    }
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
