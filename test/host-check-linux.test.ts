// `host check`, its timer and `host doctor` on a real Linux machine with
// systemd, as root: the check's units load and run, a branch stopped with
// SIGSTOP is killed within 3 runs and restarted by systemd (with the alert
// sent to a local webhook and resolved), and doctor's sandbox probe reports
// what this machine applies. Skipped unless INCIBASE_TEST_HOST=1 on Linux as
// root; needs INCIBASE_TEST_BINARY (`bun scripts/build-binary.ts`). Uses its
// own host root (INCIBASE_TEST_HOST_ROOT, default /var/lib/incibase-check-test)
// and uid base (INCIBASE_TEST_UID_BASE, default 73000), with a unit prefix,
// groups, runtime root and CLI link named after the root (never the
// machine's own /usr/local/bin/incibase), and removes all it created.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DataDirLock } from "../src/engine/store.ts";
import { VERSION } from "../src/engine/version.ts";
import { runCheck } from "../src/host/check.ts";
import { openHost, type OpsContext } from "../src/host/context.ts";
import { runDoctor, systemdFeature } from "../src/host/doctor.ts";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { Registry, type BranchRow } from "../src/host/registry.ts";
import { LinuxSystem } from "../src/host/system.ts";

const enabled = process.env.INCIBASE_TEST_HOST === "1" && process.platform === "linux" && process.getuid?.() === 0;
const ROOT = process.env.INCIBASE_TEST_HOST_ROOT ?? "/var/lib/incibase-check-test";
const UID_BASE = Number(process.env.INCIBASE_TEST_UID_BASE ?? 73000);
const BINARY = process.env.INCIBASE_TEST_BINARY ?? "";
const REQUIRE_SANDBOX = process.env.INCIBASE_TEST_REQUIRE_SANDBOX === "1";
const MARKER = ".incibase-test-root";
const LABEL = basename(ROOT).slice(0, 24);
const APPS = `/tmp/${LABEL}-apps`;
const LAYOUT = {
  unitPrefix: LABEL,
  groups: { proxy: `${LABEL}-proxy`, admin: `${LABEL}-admin` },
  runtimeRoot: `/usr/local/lib/${LABEL}`,
  systemdDir: "/etc/systemd/system",
  cliLink: `${APPS}/bin/incibase`,
};
const SLOW = 240_000;

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
  // Timers first, so none starts a check while the rest goes.
  for (const unit of [...units.filter((u) => u.endsWith(".timer")), ...units.filter((u) => !u.endsWith(".timer")), `${prefix}.slice`]) {
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
      for (const pid of sys.processesOf(branch.os_uid)) {
        process.kill(pid, "SIGCONT");
        process.kill(pid, "SIGKILL");
      }
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

/** The example app bundled as `nobody` with the standalone binary (bundling runs its top-level code; root never does). */
function bundleExample(): string {
  const dir = join(APPS, "v1");
  cpSync(join(import.meta.dir, "..", "example"), dir, { recursive: true });
  run(["chown", "-R", "nobody:nogroup", dir]);
  run(["setpriv", "--reuid=nobody", "--regid=nogroup", "--clear-groups", "--", "env", `HOME=${dir}`, join(APPS, "incibase"), "bundle", "--dir", join(dir, "incibase"), "--out", join(dir, "app.ib")]);
  return join(dir, "app.ib");
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

const verifyUnit = (unit: string) => {
  const { stderr, code } = run(["systemd-analyze", "verify", join(LAYOUT.systemdDir, unit)], { ok: [0, 1] });
  return { code, ours: stderr.split("\n").filter((l) => l.includes(LABEL)) };
};

describe.skipIf(!enabled)("host check and doctor on systemd", () => {
  const dev = () => ctx.registry.findBranch("shop", "dev")!;
  const unitOf = (b: BranchRow) => ctx.layout.units.branch(b.id);
  const received: { title: string | null; body: string }[] = [];
  let webhook: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(async () => {
    if (ROOT === DEFAULT_ROOT) throw new Error(`Refusing to test on ${DEFAULT_ROOT}`);
    if (!BINARY || !existsSync(BINARY)) throw new Error("Set INCIBASE_TEST_BINARY to a standalone incibase for this machine (bun scripts/build-binary.ts)");
    if (existsSync(ROOT) && !existsSync(join(ROOT, MARKER))) throw new Error(`${ROOT} exists and is not a test root; remove it or pick another INCIBASE_TEST_HOST_ROOT`);
    cleanup();
    mkdirSync(ROOT, { mode: 0o755 });
    writeFileSync(join(ROOT, MARKER), "");
    mkdirSync(APPS, { mode: 0o755 });
    mkdirSync(join(APPS, "bin"), { mode: 0o755 });
    cpSync(BINARY, join(APPS, "incibase"));
    chmodSync(join(APPS, "incibase"), 0o755);
    ctx = openHost({ root: ROOT, layout: LAYOUT });
    ctx.actor = "root:test";
    ctx.log = (line) => console.log(`  | ${line}`);
    await ops.initHost(ctx, { domain: "incibase.example.net", timezone: "Europe/Istanbul", uidBase: UID_BASE, sliceMemoryMax: 2 * 1024 ** 3, checkTimer: false });
    await ops.installRuntime(ctx, { binary: BINARY, version: VERSION, sha256: new Bun.CryptoHasher("sha256").update(readFileSync(BINARY)).digest("hex") });
    // The check service runs the CLI link.
    await ops.useCli(ctx, { version: VERSION });
    await ops.createProject(ctx, { slug: "shop", branches: ["dev"] });
    const { release } = await ops.addRelease(ctx, { project: "shop", branch: "dev", file: bundleExample() });
    expect(release.status).toBe("live");
    webhook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        received.push({ title: req.headers.get("title"), body: await req.text() });
        return new Response("ok");
      },
    });
    // The op takes https only; a local stand-in for ntfy.sh is written directly.
    await ctx.registry.withLock(() => ctx.registry.setSetting("alert_webhook", `http://127.0.0.1:${webhook!.port}/c13-topic`));
  }, SLOW);

  afterAll(() => {
    webhook?.stop(true);
    ctx?.registry.close();
    if (enabled) cleanup();
  });

  test("the check's service and timer load, the service runs a check as root through the CLI link, and the timer fires it", async () => {
    const { checkService, checkTimer } = ctx.layout.units;
    // The link's own path, never the command that ran host init (here bun with src/cli.ts).
    expect(readFileSync(ctx.layout.unitFile(checkService), "utf8")).toContain(`\nExecStart=${ctx.layout.cliLink} host check --root ${ROOT}\n`);
    expect(verifyUnit(checkService)).toEqual({ code: 0, ours: [] });
    expect(verifyUnit(checkTimer)).toEqual({ code: 0, ours: [] });
    // Earlier runs of this test used the same unit name: only lines from here on count.
    const cursor = ctx.driver.journalCursor();
    run(["systemctl", "start", checkService]);
    // A finished oneshot shows Result=success but no exec status or invocation any more (systemd 255).
    expect(ctx.driver.show(checkService)).toMatchObject({ result: "success", activeState: "inactive" });
    const checks = () => ctx.driver.journal({ unit: checkService, ...(cursor ? { afterCursor: cursor } : {}) }).filter((e) => /^ok +shop\/dev: healthy$/.test(e.message)).length;
    expect(checks()).toBe(1);

    await ops.initHost(ctx, { domain: "incibase.example.net", checkTimer: true });
    expect(ctx.driver.isActive(checkTimer)).toBe(true);
    expect(existsSync(ctx.layout.timerWantsLink().path)).toBe(true);
    // OnActiveSec=10s: the timer runs the service by itself.
    await waitFor("the timer to run the check", () => checks() >= 2, 45_000);
    expect(ctx.driver.show(checkService).result).toBe("success");
    const quick = { ...ctx, doctor: { sandboxProbe: async () => ({ ran: false as const, reason: "not needed here" }) } };
    const timerVerdict = async () => (await runDoctor(quick)).checks.find((c) => c.name === "check timer")!;
    expect(await timerVerdict()).toMatchObject({ status: "OK", detail: expect.stringContaining("the last one completed") });
    // A run that fails (here: ExecStart replaced by /bin/false) leaves the timer active and the service failed: doctor FAILs.
    const dropIn = join(LAYOUT.systemdDir, `${checkService}.d`);
    mkdirSync(dropIn, { recursive: true });
    writeFileSync(join(dropIn, "zz-test-fail.conf"), "[Service]\nExecStart=\nExecStart=/bin/false\n");
    try {
      run(["systemctl", "daemon-reload"]);
      run(["systemctl", "start", checkService], { ok: [0, 1] });
      expect(ctx.driver.isActive(checkTimer)).toBe(true);
      expect(ctx.driver.show(checkService).activeState).toBe("failed");
      expect(await timerVerdict()).toMatchObject({ status: "FAIL", detail: expect.stringContaining(`the last run of ${checkService} failed (exit-code)`) });
    } finally {
      rmSync(dropIn, { recursive: true, force: true });
      run(["systemctl", "daemon-reload"]);
      run(["systemctl", "reset-failed", checkService], { ok: [0, 1, 5] });
    }
    // A manual run while another one holds control/check.lock does nothing.
    // (The timer may be running one right now: wait for it.)
    const held = await waitFor("control/check.lock", () => {
      try {
        return new DataDirLock(ctx.layout.control, undefined, "check.lock");
      } catch {
        return null;
      }
    });
    try {
      const cli = run([join(APPS, "incibase"), "host", "check", "--root", ROOT]);
      expect(cli.stdout.trim()).toBe("skipped    another check is running");
    } finally {
      held.release();
    }
    await ops.initHost(ctx, { domain: "incibase.example.net", checkTimer: false });
    expect(ctx.driver.isActive(checkTimer)).toBe(false);
    expect(existsSync(ctx.layout.timerWantsLink().path)).toBe(false);
    // The run above may have left an alert pending for nobody: start from a clean slate.
    received.length = 0;
  }, SLOW);

  test("a branch stopped with SIGSTOP is killed by the third check; systemd restarts it; the alert opens and resolves once", async () => {
    const b = dev();
    expect((await runCheck(ctx)).branches.find((x) => x.id === b.id)).toMatchObject({ outcome: "ok" });
    const before = ctx.driver.show(unitOf(b));
    process.kill(before.mainPid, "SIGSTOP");
    const started = Date.now();
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const report = await runCheck(ctx);
      outcomes.push(report.branches.find((x) => x.id === b.id)!.outcome);
    }
    expect(outcomes).toEqual(["failing", "failing", "killed"]);
    // Three 5 s probes, run back to back here (the timer spaces them 30 s apart: killed within about 90 s).
    expect(Date.now() - started).toBeLessThan(30_000);
    const after = await waitFor("systemd to start it again", () => {
      const now = ctx.driver.show(unitOf(b));
      return now.mainPid && now.mainPid !== before.mainPid && now.activeState === "active" ? now : null;
    });
    expect(after.nRestarts).toBeGreaterThan(before.nRestarts);
    expect(existsSync(`/proc/${before.mainPid}`)).toBe(false);
    expect(ctx.registry.listAlerts("firing").map((a) => a.key)).toEqual([`health:${b.id}`]);
    expect(received.map((r) => r.title)).toEqual(["incibase shop/dev branch killed after failed health checks"]);
    expect(received[0]!.body).toContain("failed 3 health checks in a row (last: no answer within 5 s)");
    // The new process serves (its admin socket answers); the next check resolves it.
    const report = await waitFor("a healthy check", async () => {
      const r = await runCheck(ctx);
      return r.branches.find((x) => x.id === b.id)!.outcome === "ok" ? r : null;
    });
    expect(report.notifications.sent).toBe(1);
    expect(ctx.registry.listAlerts("firing")).toEqual([]);
    expect(received.map((r) => r.title)).toEqual([
      "incibase shop/dev branch killed after failed health checks",
      "incibase resolved: shop/dev branch killed after failed health checks",
    ]);
    expect(ctx.registry.listAudit(b.id).some((a) => a.action === "check.kill" && a.ok === 1)).toBe(true);
  }, SLOW);

  test("doctor runs, and its sandbox probe reports what this machine applies", async () => {
    const report = await runDoctor(ctx);
    for (const c of report.checks) console.log(`  doctor: ${c.status.padEnd(4)} ${c.name}: ${c.detail}`);
    const by = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    expect(by.systemd!.status).toBe("OK");
    expect(by["cgroup v2"]!.status).toBe("OK");
    expect(by["host tree"]!.status).toBe("OK");
    expect(by.registry!.status).toBe("OK");
    expect(by["env files"]!.status).toBe("OK");
    expect(by["branch shop/dev"]).toMatchObject({ status: "OK", detail: "directories, files, links and sockets as expected" });
    // The probe ran: each directive has a verdict.
    for (const name of ["SocketBindDeny", "ProtectProc", "IPAddressDeny", "ProtectSystem"]) expect(by[`sandbox ${name}`]).toBeDefined();
    // The network filter is cgroup BPF: it works in a container too.
    expect(by["sandbox IPAddressDeny"]!.status).toBe("OK");
    const virt = run(["systemd-detect-virt", "--container"], { ok: [0, 1] });
    const container = virt.code === 0 ? virt.stdout.trim() : null;
    if (container) {
      expect(by.virtualization).toMatchObject({ status: "WARN" });
      expect(by.virtualization!.detail).toContain(container);
      // A container that switches directives off gets WARNs, never FAILs.
      for (const c of report.checks.filter((x) => x.name.startsWith("sandbox "))) expect(c.status).not.toBe("FAIL");
      // OrbStack's LXC: zzz-lxc-service.conf turns ProtectProc off.
      if (existsSync("/run/systemd/system/service.d/zzz-lxc-service.conf")) {
        expect(by["sandbox ProtectProc"]!.status).toBe("WARN");
        expect(by["sandbox ProtectProc"]!.detail).toContain(`not effective in this container (${container})`);
      }
    } else expect(by.virtualization!.status).toBe("OK");
    // SocketBindDeny needs systemd's BPF framework; Ubuntu 24.04 builds it without (VM or container): a WARN naming the build.
    const noBpf = systemdFeature(run(["systemctl", "--version"]).stdout, "BPF_FRAMEWORK") === false;
    if (noBpf) {
      const bind = by["sandbox SocketBindDeny"]!;
      expect(bind.status).toBe("WARN");
      expect(bind.detail).toStartWith("unsupported by this systemd build (-BPF_FRAMEWORK)");
      expect(bind.detail).toEndWith("listening on 0.0.0.0: bound");
    }
    // journald's effective Storage= (Ubuntu: auto, with /var/log/journal/<machine-id> written).
    expect(by.journald).toMatchObject({ status: "OK", detail: "persistent storage (Storage=auto, /var/log/journal)" });
    // On a VM every directive takes effect but SocketBindDeny where this systemd cannot apply it (the WARN above).
    if (REQUIRE_SANDBOX) {
      for (const c of report.checks.filter((x) => x.name.startsWith("sandbox ") && !(noBpf && x.name === "sandbox SocketBindDeny"))) expect(c).toMatchObject({ status: "OK" });
    }
    // The probe cleaned up after itself.
    expect(readdirSync("/run").filter((n) => n.startsWith(`${LABEL}-doctor-`))).toEqual([]);
    expect(readdirSync("/var/tmp").filter((n) => n.startsWith(`${LABEL}-doctor-`))).toEqual([]);
    expect(run(["systemctl", "list-units", "--all", "--plain", "--no-legend", `${LABEL}-doctor-*`]).stdout.trim()).toBe("");
    // The CLI exits 1 exactly when something FAILs.
    const cli = run([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "host", "doctor", "--root", ROOT], { ok: [0, 1] });
    expect(cli.code).toBe(report.ok ? 0 : 1);
    expect(cli.stdout).toContain("OK   systemd: systemd ");
  }, SLOW);
});
