// `host check` (design section 9) on a fake host with a fake clock: the
// three-failure kill, the startup-slow path, failed units and their one
// retry, disk alerts, the state file; the admin-socket probe against real
// unix sockets; and alert delivery to a local HTTP server standing in for
// ntfy.sh (dedupe, resolve, timeout, no secrets); the check timer's units.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAlertWebhook, deliverAlerts, redact, setSetting } from "../src/host/alerts.ts";
import { DataDirLock } from "../src/engine/store.ts";
import {
  check,
  KILL_AFTER_FAILURES,
  RESTART_ALERT_COUNT,
  RESTART_WINDOW_MS,
  probeAdminSocket,
  readCheckState,
  RETRY_AFTER_MS,
  runCheck,
  STARTUP_SLOW_MS,
  type CheckContext,
  type DiskUsage,
  type ProbeResult,
} from "../src/host/check.ts";
import { CLD_EXITED, CLD_KILLED, type UnitStatus } from "../src/host/driver.ts";
import { FakeSystem } from "../src/host/fake-system.ts";
import * as ops from "../src/host/ops.ts";
import { checkServiceUnit, checkTimerUnit } from "../src/host/render.ts";
import type { BranchRow } from "../src/host/registry.ts";
import { closeOpsHosts, fakeBundle, fakeOpsHost, type OpsTestHost } from "./host-helpers.ts";

afterEach(closeOpsHosts);

interface CheckHost extends OpsTestHost, Pick<CheckContext, "probe" | "diskUsage"> {
  clock: { t: number };
  /** What the probe answers per admin socket; default: ok while the fake process serves, down otherwise. */
  answers: Map<string, ProbeResult>;
  disk: DiskUsage;
}

/** A host with shop/prod and shop/dev live on release 1, a clock that only moves when told, and a scripted probe. */
async function checkHost(branches = ["prod", "dev"]): Promise<CheckHost> {
  const host = (await fakeOpsHost()) as CheckHost;
  await ops.createProject(host, { slug: "shop", branches });
  for (const name of branches) await ops.addRelease(host, { project: "shop", branch: name, file: fakeBundle(host.dir, `${name}-v1`) });
  host.clock = { t: 1_900_000_000_000 };
  host.now = () => host.clock.t;
  host.answers = new Map();
  host.disk = { usedPercent: 40, availableBytes: 60 * 1024 ** 3 };
  host.diskUsage = () => host.disk;
  host.probe = async (socket) => host.answers.get(socket) ?? ((await host.driver.health(socket)) ? { kind: "ok" } : { kind: "down", detail: "no admin socket yet" });
  return host;
}

const branchOf = (host: OpsTestHost, name: string) => host.registry.findBranch("shop", name)!;
const unitOf = (host: OpsTestHost, b: BranchRow) => host.layout.units.branch(b.id);
const sockOf = (host: OpsTestHost, b: BranchRow) => host.layout.branch(b.id).adminSock;
const firing = (host: OpsTestHost) => host.registry.listAlerts("firing").map((a) => a.key);
const outcome = (report: Awaited<ReturnType<typeof runCheck>>, b: BranchRow) => report.branches.find((x) => x.id === b.id)!;
const kills = (host: OpsTestHost) => host.driver.calls.filter((c) => c.startsWith("kill "));

/** Advances the clock by one timer period and runs the check. */
async function tick(host: CheckHost, ms = 30_000) {
  host.clock.t += ms;
  return runCheck(host);
}

/** Makes `show` of a unit report this, as systemd would after the process ended. */
function setUnitStatus(host: OpsTestHost, b: BranchRow, patch: Partial<UnitStatus>) {
  const units = (host.driver as unknown as { units: Map<string, { status: UnitStatus; healthy: boolean }> }).units;
  const unit = units.get(unitOf(host, b))!;
  unit.status = { ...unit.status, ...patch };
  if (patch.activeState && patch.activeState !== "active") unit.healthy = false;
}

describe("a stalled branch", () => {
  test("is killed after 3 failed probes in a row, once; systemd starts it again and the alert resolves", async () => {
    const host = await checkHost();
    const prod = branchOf(host, "prod");
    const dev = branchOf(host, "dev");
    expect(outcome(await tick(host), prod)).toMatchObject({ outcome: "ok" });
    const before = host.driver.show(unitOf(host, prod));

    host.answers.set(sockOf(host, prod), { kind: "fail", detail: "no answer within 5 s" });
    for (let i = 1; i < KILL_AFTER_FAILURES; i++) {
      expect(outcome(await tick(host), prod)).toMatchObject({ outcome: "failing", detail: `no answer within 5 s (${i} of 3)` });
      expect(kills(host)).toEqual([]);
      expect(firing(host)).toEqual([]);
    }
    const third = await tick(host);
    expect(outcome(third, prod)).toMatchObject({ outcome: "killed" });
    // The other branch is untouched.
    expect(outcome(third, dev)).toMatchObject({ outcome: "ok" });
    expect(kills(host)).toEqual([`kill SIGKILL ${unitOf(host, prod)}`]);
    const after = host.driver.show(unitOf(host, prod));
    expect(after.invocationId).not.toBe(before.invocationId);
    expect(after.nRestarts).toBe(before.nRestarts + 1);
    const alert = host.registry.listAlerts("firing").find((a) => a.key === `health:${prod.id}`)!;
    expect(alert.message).toContain("shop/prod failed 3 health checks in a row (last: no answer within 5 s)");
    expect(alert.message).toContain("SIGKILL");
    expect(host.registry.listAudit(prod.id).at(-1)).toMatchObject({ action: "check.kill", ok: 1 });

    // The new process answers: the alert resolves; no second kill.
    host.answers.delete(sockOf(host, prod));
    expect(outcome(await tick(host), prod)).toMatchObject({ outcome: "ok" });
    expect(firing(host)).toEqual([]);
    expect(host.registry.listAlerts().find((a) => a.key === `health:${prod.id}`)).toMatchObject({ state: "closed" });
    expect(kills(host)).toHaveLength(1);
  });

  test("a probe that succeeds in between, or a new process, starts the count over", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    const fail: ProbeResult = { kind: "fail", detail: "/api/health answered HTTP 503" };
    host.answers.set(sockOf(host, prod), fail);
    await tick(host);
    await tick(host);
    host.answers.delete(sockOf(host, prod));
    await tick(host);
    host.answers.set(sockOf(host, prod), fail);
    await tick(host);
    await tick(host);
    expect(kills(host)).toEqual([]);
    expect(readCheckState(host).branches[prod.id]).toMatchObject({ failures: 2 });
    // systemd restarted it meanwhile (another invocation): the failures belonged to the old process.
    host.driver.restart(unitOf(host, prod));
    expect(outcome(await tick(host), prod)).toMatchObject({ outcome: "failing", detail: expect.stringContaining("(1 of 3)") });
    expect(kills(host)).toEqual([]);
  });

  test("the counters live in a root 0600 file across runs; a broken file starts over", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    host.answers.set(sockOf(host, prod), { kind: "fail", detail: "no answer within 5 s" });
    await tick(host);
    const info = host.sys.lstat(host.layout.checkState)!;
    expect({ uid: info.uid, gid: info.gid, mode: info.mode }).toEqual({ uid: 0, gid: 0, mode: 0o600 });
    const saved = JSON.parse(readFileSync(host.layout.checkState, "utf8"));
    expect(saved.branches[prod.id]).toMatchObject({ failures: 1, invocation: host.driver.show(unitOf(host, prod)).invocationId });
    writeFileSync(host.layout.checkState, "{ not json");
    expect(readCheckState(host)).toEqual({ version: 1, branches: {} });
    writeFileSync(host.layout.checkState, JSON.stringify({ version: 1, branches: { "../x": {} } }));
    expect(readCheckState(host)).toEqual({ version: 1, branches: {} });
    await tick(host);
    expect(readCheckState(host).branches[prod.id]).toMatchObject({ failures: 1 });
  });
});

describe("a kill that would hit another process", () => {
  test("is dropped when the unit restarted while the third probe was waiting; the new process counts from zero", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    const unit = unitOf(host, prod);
    let n = 0;
    host.probe = async (): Promise<ProbeResult> => {
      // An owner's branch restart, or a crash and Restart=, during the 5 s probe.
      if (++n === KILL_AFTER_FAILURES) host.driver.restart(unit);
      return { kind: "fail", detail: "no answer within 5 s" };
    };
    for (let i = 1; i < KILL_AFTER_FAILURES; i++) await tick(host);
    const restarted = host.driver.show(unit).invocationId;
    const third = outcome(await tick(host), prod);
    expect(host.driver.show(unit).invocationId).not.toBe(restarted);
    expect(third).toMatchObject({ outcome: "transition", detail: "restarted while it was probed (active); not killed" });
    expect(kills(host)).toEqual([]);
    expect(firing(host)).toEqual([]);
    expect(host.registry.listAudit(prod.id).some((a) => a.action === "check.kill")).toBe(false);
    // The new process fails on its own: it is killed only after its own three failures.
    for (let i = 1; i < KILL_AFTER_FAILURES; i++) expect(outcome(await tick(host), prod).outcome).toBe("failing");
    expect(outcome(await tick(host), prod).outcome).toBe("killed");
    expect(kills(host)).toHaveLength(1);
  });

  test("a stopped unit is not killed either", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    let n = 0;
    host.probe = async (): Promise<ProbeResult> => {
      if (++n === KILL_AFTER_FAILURES) host.driver.stop(unitOf(host, prod));
      return { kind: "fail", detail: "no answer within 5 s" };
    };
    for (let i = 0; i < KILL_AFTER_FAILURES; i++) await tick(host);
    expect(kills(host)).toEqual([]);
  });
});

describe("runs of the check", () => {
  test("never overlap: one that finds control/check.lock held does nothing", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    host.answers.set(sockOf(host, prod), { kind: "fail", detail: "no answer within 5 s" });
    const held = new DataDirLock(host.layout.control, undefined, "check.lock");
    try {
      for (let i = 0; i < KILL_AFTER_FAILURES + 1; i++) expect(await tick(host)).toMatchObject({ skipped: "another check is running", branches: [] });
      expect(readCheckState(host).branches).toEqual({});
    } finally {
      held.release();
    }
    // Two at once (the timer's and a manual one): one of them runs.
    host.answers.delete(sockOf(host, prod));
    const both = await Promise.all([runCheck(host), runCheck(host)]);
    expect(both.filter((r) => r.skipped)).toHaveLength(1);
    expect(both.find((r) => !r.skipped)!.branches).toHaveLength(1);
    expect(host.sys.lstat(host.layout.checkLock)).toMatchObject({ type: "file", mode: 0o600 });
  });

  test("record when one last completed and how its delivery went, for doctor", async () => {
    const host = await checkHost([]);
    await tick(host);
    expect(readCheckState(host)).toMatchObject({ lastRunAt: host.clock.t, delivery: { at: host.clock.t, ok: true, error: null, unconfigured: true } });
    await host.registry.withLock(() => host.registry.setSetting("alert_webhook", "http://127.0.0.1:1/incibase-topic-secret"));
    await host.registry.withLock(() => host.registry.raiseAlert("disk:90", "91% full", host.clock.t));
    host.disk = { usedPercent: 91, availableBytes: 1024 ** 3 };
    await tick(host);
    const state = readCheckState(host);
    expect(state.delivery).toMatchObject({ ok: false, unconfigured: false, error: expect.stringMatching(/^disk:80: /) });
    expect(JSON.stringify(state)).not.toContain("incibase-topic-secret");
  });
});

describe("a slow crash loop", () => {
  /** What systemd's Restart= does after a crash: a new process, NRestarts one higher. */
  const crash = (host: CheckHost, b: BranchRow) => host.driver.killMain(unitOf(host, b), "SIGKILL");

  test("5 restarts by systemd within 10 minutes raise an alert, which resolves after 10 minutes without one", async () => {
    const host = await checkHost(["prod", "dev"]);
    const prod = branchOf(host, "prod");
    await tick(host);
    // A crash every 30 s never reaches the start limit (8 in 120 s): the unit never fails, each run sees a fresh process.
    for (let i = 1; i < RESTART_ALERT_COUNT; i++) {
      crash(host, prod);
      expect(outcome(await tick(host), prod).outcome).toBe("ok");
    }
    expect(firing(host)).toEqual([]);
    crash(host, prod);
    await tick(host);
    expect(firing(host)).toEqual([`restarts:${prod.id}`]);
    expect(host.registry.listAlerts("firing")[0]!.message).toBe(
      `shop/prod was restarted by systemd ${RESTART_ALERT_COUNT} times in the last 10 min (a crash loop slower than the start limit); see incibase logs`,
    );
    // It stays open while restarts keep coming, and while some are still in the window.
    crash(host, prod);
    await tick(host, 60_000);
    for (let t = 60_000; t < RESTART_WINDOW_MS; t += 60_000) await tick(host, 60_000);
    expect(firing(host)).toEqual([`restarts:${prod.id}`]);
    await tick(host, 60_000);
    expect(firing(host)).toEqual([]);
  });

  test("restarts spread over more than 10 minutes, or a manual start resetting NRestarts, raise nothing", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    await tick(host);
    for (let i = 0; i < 3 * RESTART_ALERT_COUNT; i++) {
      crash(host, prod);
      await tick(host, 3 * 60_000);
    }
    // An owner's restart: NRestarts starts over at 0 and is the new baseline.
    host.driver.restart(unitOf(host, prod));
    await tick(host);
    expect(firing(host)).toEqual([]);
    expect(readCheckState(host).branches[prod.id]).toMatchObject({ nRestarts: 0 });
  });
});

describe("a branch that is still starting", () => {
  test("is never killed; past 2 minutes it raises 'startup slow', which resolves once it answers", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    host.answers.set(sockOf(host, prod), { kind: "down", detail: "nothing listens on the admin socket (ECONNREFUSED)" });
    let waited = 0;
    while (waited + 30_000 < STARTUP_SLOW_MS) {
      expect(outcome(await tick(host), prod)).toMatchObject({ outcome: "starting" });
      waited += 30_000;
    }
    expect(firing(host)).toEqual([]);
    for (let i = 0; i < 10; i++) await tick(host);
    expect(kills(host)).toEqual([]);
    const alert = host.registry.listAlerts("firing").find((a) => a.key === `startup:${prod.id}`)!;
    expect(alert.message).toMatch(/^shop\/prod has been starting for \d+ s without answering on its admin socket .*a long migration\? It is not killed$/);
    host.answers.delete(sockOf(host, prod));
    await tick(host);
    expect(firing(host)).toEqual([]);
  });

  test("systemd's activating state counts as starting, without a probe", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    setUnitStatus(host, prod, { activeState: "activating", subState: "auto-restart" });
    let probes = 0;
    host.probe = async () => (probes++, { kind: "ok" });
    expect(outcome(await tick(host), prod)).toMatchObject({ outcome: "starting", detail: "auto-restart" });
    expect(probes).toBe(0);
  });
});

describe("a failed unit", () => {
  test("raises an alert; after exit 1 it gets one reset-failed and start 10 minutes in, not more", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    const unit = unitOf(host, prod);
    setUnitStatus(host, prod, { activeState: "failed", subState: "failed", result: "start-limit-hit", execMainCode: CLD_EXITED, execMainStatus: 1 });
    const first = outcome(await tick(host), prod);
    expect(first).toMatchObject({ outcome: "failed", detail: "start-limit-hit, exit 1" });
    expect(host.registry.listAlerts("firing").find((a) => a.key === `unit:${prod.id}`)!.message).toContain("check retries it once 10 min from now");
    // Not before 10 minutes.
    for (let t = 60_000; t < RETRY_AFTER_MS; t += 60_000) await tick(host, 60_000);
    expect(host.driver.calls.filter((c) => c === `start ${unit}`)).toHaveLength(0);
    host.driver.behavior = () => ({ exit: 1 });
    const retried = outcome(await tick(host, 60_000), prod);
    expect(retried).toMatchObject({ outcome: "retried" });
    expect(host.driver.calls.slice(-2)).toEqual([`reset-failed ${unit}`, `start ${unit}`]);
    expect(host.registry.listAudit(prod.id).at(-1)).toMatchObject({ action: "check.retry", ok: 1 });
    // It failed again: no second retry in this episode, however long it stays failed.
    for (let i = 0; i < 30; i++) await tick(host, 60_000);
    expect(host.driver.calls.filter((c) => c === `start ${unit}`)).toHaveLength(1);
    expect(host.registry.listAlerts("firing").find((a) => a.key === `unit:${prod.id}`)!.message).toContain("retried once and failed again");
    // Healthy again ends the episode: a later failure gets its own retry.
    host.driver.behavior = () => ({});
    host.driver.resetFailed(unit);
    host.driver.start(unit);
    await tick(host);
    expect(firing(host)).toEqual([]);
    expect(readCheckState(host).branches[prod.id]).toMatchObject({ retried: false, failedSince: null });
  });

  test("SIGKILL (the OOM killer, 137) is retried; a definition error (78) or a refused migration (65) is not", async () => {
    const host = await checkHost(["prod", "dev", "preview"]);
    const [prod, dev, preview] = ["prod", "dev", "preview"].map((n) => branchOf(host, n)) as [BranchRow, BranchRow, BranchRow];
    setUnitStatus(host, prod, { activeState: "failed", result: "oom-kill", execMainCode: CLD_KILLED, execMainStatus: 9 });
    setUnitStatus(host, dev, { activeState: "failed", result: "exit-code", execMainCode: CLD_EXITED, execMainStatus: 78 });
    setUnitStatus(host, preview, { activeState: "failed", result: "exit-code", execMainCode: CLD_EXITED, execMainStatus: 65 });
    await tick(host);
    const report = await tick(host, RETRY_AFTER_MS);
    expect(outcome(report, prod).outcome).toBe("retried");
    expect(outcome(report, dev)).toMatchObject({ outcome: "failed", detail: "exit-code, exit 78" });
    expect(outcome(report, preview).outcome).toBe("failed");
    expect(host.registry.listAlerts("firing").find((a) => a.key === `unit:${dev.id}`)!.message).toContain("it is not retried");
  });

  test("an inactive unit that should run raises an alert; stopped, busy and release-less branches are left alone", async () => {
    const host = await checkHost(["prod", "dev"]);
    await ops.createBranch(host, { project: "shop", name: "empty" });
    const prod = branchOf(host, "prod");
    const dev = branchOf(host, "dev");
    host.driver.stop(unitOf(host, prod));
    const report = await tick(host);
    expect(outcome(report, prod)).toMatchObject({ outcome: "inactive" });
    expect(outcome(report, branchOf(host, "empty"))).toMatchObject({ outcome: "skipped", detail: "no release" });
    expect(firing(host)).toEqual([`unit:${prod.id}`]);
    // Stopping it on purpose resolves the alert.
    await ops.stop(host, { project: "shop", branch: "prod", confirm: "prod--shop.incibase.example.net" });
    expect(outcome(await tick(host), prod)).toMatchObject({ outcome: "skipped", detail: "stopped" });
    expect(firing(host)).toEqual([]);
    // A job owns a busy branch: no probe, no kill, its alerts stay.
    host.answers.set(sockOf(host, dev), { kind: "fail", detail: "x" });
    await host.registry.withLock(() => host.registry.claimBusy(dev.id, "incibase-release-x.service", 1));
    for (let i = 0; i < 5; i++) expect(outcome(await tick(host), dev).outcome).toBe("skipped");
    expect(kills(host)).toEqual([]);
  });
});

describe("the disk", () => {
  test("alerts at 80 % and 90 % use and resolves below", async () => {
    const host = await checkHost([]);
    host.disk = { usedPercent: 85, availableBytes: 15 * 1024 ** 3 };
    expect((await tick(host)).disk).toMatchObject({ usedPercent: 85, path: host.layout.root });
    expect(firing(host)).toEqual(["disk:80"]);
    expect(host.registry.listAlerts("firing")[0]!.message).toBe(`The file system of ${host.layout.root} is 85% full (15.0 GiB free)`);
    host.disk = { usedPercent: 93, availableBytes: 7 * 1024 ** 3 };
    await tick(host);
    expect(firing(host)).toEqual(["disk:80", "disk:90"]);
    host.disk = { usedPercent: 50, availableBytes: 50 * 1024 ** 3 };
    await tick(host);
    expect(firing(host)).toEqual([]);
  });

  test("use hovering at a threshold notifies once, not every tick: it resolves only 3 points below", async () => {
    const host = await checkHost([]);
    const hook = webhookServer();
    try {
      await useWebhook(host, hook.url);
      for (let i = 0; i < 10; i++) {
        host.disk = { usedPercent: i % 2 ? 79 : 80, availableBytes: 1024 ** 3 };
        await tick(host);
      }
      expect(hook.received.map((r) => r.title)).toEqual(["incibase disk 80% full"]);
      host.disk = { usedPercent: 78, availableBytes: 1024 ** 3 };
      await tick(host);
      expect(firing(host)).toEqual(["disk:80"]);
      host.disk = { usedPercent: 77, availableBytes: 1024 ** 3 };
      await tick(host);
      expect(firing(host)).toEqual([]);
      expect(hook.received.map((r) => r.title)).toEqual(["incibase disk 80% full", "incibase resolved: disk 80% full"]);
    } finally {
      hook.server.stop(true);
    }
  });
});

// ---- the probe on real sockets ---------------------------------------------------------

describe("the admin socket probe", () => {
  let dir = "";
  const sys = { sys: new FakeSystem() } as unknown as CheckContext;
  let stalled: Server;

  beforeAll(async () => {
    // Short: unix socket paths are limited to about 100 bytes.
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ibc-")));
    stalled = createServer(() => {});
    await new Promise<void>((resolve) => stalled.listen(join(dir, "stalled.sock"), resolve));
  });
  afterAll(() => {
    stalled.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("tells a healthy, a stalled, an erroring and a not-yet-listening process apart", async () => {
    const ok = Bun.serve({ unix: join(dir, "ok.sock"), fetch: (req) => (new URL(req.url).pathname === "/api/health" ? Response.json({ ok: true }) : new Response("", { status: 404 })) });
    const sick = Bun.serve({ unix: join(dir, "sick.sock"), fetch: () => new Response("busy", { status: 503 }) });
    writeFileSync(join(dir, "stale.sock"), "");
    symlinkSync(join(dir, "ok.sock"), join(dir, "link.sock"));
    try {
      expect(await probeAdminSocket(sys, join(dir, "ok.sock"), 1000)).toEqual({ kind: "ok" });
      expect(await probeAdminSocket(sys, join(dir, "sick.sock"), 1000)).toEqual({ kind: "fail", detail: "/api/health answered HTTP 503" });
      const started = performance.now();
      expect(await probeAdminSocket(sys, join(dir, "stalled.sock"), 300)).toEqual({ kind: "fail", detail: "no answer within 0.3 s" });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(await probeAdminSocket(sys, join(dir, "missing.sock"), 1000)).toEqual({ kind: "down", detail: "no admin socket yet" });
      // What a previous process left behind until serve binds again after its migration.
      expect(await probeAdminSocket(sys, join(dir, "stale.sock"), 1000)).toMatchObject({ kind: "down" });
      expect(await probeAdminSocket(sys, join(dir, "link.sock"), 1000)).toEqual({ kind: "fail", detail: "admin.sock is a symlink" });
    } finally {
      ok.stop(true);
      sick.stop(true);
    }
  });
});

// ---- alerts -------------------------------------------------------------------------------

interface Received {
  title: string | null;
  priority: string | null;
  tags: string | null;
  type: string | null;
  body: string;
}

/** A stand-in for ntfy.sh: records each POST; `mode` decides the answer. */
function webhookServer() {
  const received: Received[] = [];
  const state = { mode: "ok" as "ok" | "error" | "hang" };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (state.mode === "hang") return new Promise<Response>(() => {});
      received.push({ title: req.headers.get("title"), priority: req.headers.get("priority"), tags: req.headers.get("tags"), type: req.headers.get("content-type"), body: await req.text() });
      return state.mode === "error" ? new Response("no", { status: 500 }) : Response.json({ id: "x" });
    },
  });
  return { received, state, server, url: `http://127.0.0.1:${server.port}/incibase-topic-secret` };
}

/** Points the host at a local webhook (the op takes https only, so the setting is written directly). */
async function useWebhook(host: OpsTestHost, url: string) {
  await host.registry.withLock(() => host.registry.setSetting("alert_webhook", url));
}

describe("alert delivery", () => {
  test("tells the owner once when an alert opens and once when it resolves, as ntfy expects it", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    const hook = webhookServer();
    try {
      await useWebhook(host, hook.url);
      host.answers.set(sockOf(host, prod), { kind: "fail", detail: "no answer within 5 s" });
      await tick(host);
      await tick(host);
      expect(hook.received).toEqual([]);
      const killed = await tick(host);
      expect(killed.notifications).toEqual({ sent: 1, closed: 0, error: null, unconfigured: false });
      expect(hook.received).toHaveLength(1);
      expect(hook.received[0]).toMatchObject({
        title: "incibase shop/prod branch killed after failed health checks",
        priority: "high",
        tags: "warning",
        type: "text/plain; charset=utf-8",
      });
      expect(hook.received[0]!.body).toContain("shop/prod failed 3 health checks in a row");
      expect(hook.received[0]!.body).toContain(`(alert health:${prod.id})`);
      expect(hook.received[0]!.body).toContain("on incibase.example.net");
      // The process answers again; meanwhile ticks send nothing new.
      host.answers.delete(sockOf(host, prod));
      const resolved = await tick(host);
      expect(resolved.notifications.sent).toBe(1);
      expect(hook.received[1]).toMatchObject({ title: "incibase resolved: shop/prod branch killed after failed health checks", priority: "low", tags: "white_check_mark" });
      expect(hook.received[1]!.body).toMatch(/^Resolved after about 30 s: shop\/prod failed 3 health checks/);
      for (let i = 0; i < 5; i++) await tick(host);
      expect(hook.received).toHaveLength(2);
      // A new episode of the same key is news again.
      host.disk = { usedPercent: 81, availableBytes: 1024 ** 3 };
      await tick(host);
      await tick(host);
      expect(hook.received.map((r) => r.title)).toEqual([
        "incibase shop/prod branch killed after failed health checks",
        "incibase resolved: shop/prod branch killed after failed health checks",
        "incibase disk 80% full",
      ]);
      expect(hook.received[2]!.priority).toBe("default");
    } finally {
      hook.server.stop(true);
    }
  });

  test("a webhook that times out or fails keeps the alert pending for the next run; the error never shows the URL", async () => {
    const host = await checkHost([]);
    const hook = webhookServer();
    try {
      await useWebhook(host, hook.url);
      await host.registry.withLock(() => {
        host.registry.raiseAlert("disk:80", "The file system is 81% full", host.clock.t);
        host.registry.raiseAlert("disk:90", "The file system is 91% full", host.clock.t);
      });
      hook.state.mode = "hang";
      const started = performance.now();
      const slow = await deliverAlerts(host, { timeoutMs: 200 });
      expect(performance.now() - started).toBeLessThan(2000);
      // It stopped at the first: the second would wait just as long.
      expect(slow).toEqual({ sent: 0, closed: 0, error: "disk:80: no answer within 0.2 s", unconfigured: false });
      hook.state.mode = "error";
      const failed = await deliverAlerts(host, { timeoutMs: 1000 });
      expect(failed.error).toBe("disk:80: HTTP 500");
      expect(JSON.stringify([slow, failed])).not.toContain("incibase-topic-secret");
      expect(host.registry.listAlerts("firing").map((a) => a.notified_at)).toEqual([null, null]);
      hook.state.mode = "ok";
      expect(await deliverAlerts(host)).toMatchObject({ sent: 2, error: null });
      expect(await deliverAlerts(host)).toMatchObject({ sent: 0 });
    } finally {
      hook.server.stop(true);
    }
  });

  test("an alert that resolves while its open is being POSTed still gets its resolve", async () => {
    const host = await checkHost([]);
    let first = true;
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        received.push(req.headers.get("title") ?? "");
        // A job, or another writer, resolves it during the POST.
        if (first) {
          first = false;
          await host.registry.withLock(() => host.registry.resolveAlert(`release:b0000001`, host.clock.t + 5));
        }
        return Response.json({});
      },
    });
    try {
      await useWebhook(host, `http://127.0.0.1:${server.port}/topic`);
      await host.registry.withLock(() => host.registry.raiseAlert(`release:b0000001`, "release 2 failed its gate", host.clock.t));
      expect(await deliverAlerts(host)).toMatchObject({ sent: 1, closed: 0 });
      expect(host.registry.listAlerts()[0]).toMatchObject({ state: "resolved", notified_at: host.clock.t });
      expect(await deliverAlerts(host)).toMatchObject({ sent: 1, closed: 0 });
      expect(received).toEqual(["incibase release problem", "incibase resolved: release problem"]);
      expect(host.registry.listAlerts()[0]).toMatchObject({ state: "closed" });
      // Re-raised during the POST (a new episode): its own open goes out next.
      first = true;
      await host.registry.withLock(() => host.registry.raiseAlert(`release:b0000001`, "again", host.clock.t + 10));
      const server2 = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          received.push(req.headers.get("title") ?? "");
          if (first) {
            first = false;
            await host.registry.withLock(() => {
              host.registry.resolveAlert(`release:b0000001`, host.clock.t + 11);
              host.registry.raiseAlert(`release:b0000001`, "third", host.clock.t + 12);
            });
          }
          return Response.json({});
        },
      });
      try {
        await useWebhook(host, `http://127.0.0.1:${server2.port}/topic`);
        await deliverAlerts(host);
        expect(host.registry.listAlerts()[0]).toMatchObject({ state: "firing", notified_at: null, message: "third" });
        expect((await deliverAlerts(host)).sent).toBe(1);
      } finally {
        server2.stop(true);
      }
    } finally {
      server.stop(true);
    }
  });

  test("an alert resolved before its open was sent closes without a message; without a webhook alerts wait", async () => {
    const host = await checkHost([]);
    await host.registry.withLock(() => host.registry.raiseAlert("disk:80", "81% full", host.clock.t));
    expect(await deliverAlerts(host)).toEqual({ sent: 0, closed: 0, error: null, unconfigured: true });
    expect(host.registry.listAlerts("firing")).toHaveLength(1);
    await host.registry.withLock(() => host.registry.resolveAlert("disk:80", host.clock.t + 1));
    const hook = webhookServer();
    try {
      await useWebhook(host, hook.url);
      expect(await deliverAlerts(host)).toMatchObject({ sent: 0, closed: 1 });
      expect(hook.received).toEqual([]);
      expect(host.registry.listAlerts()[0]).toMatchObject({ key: "disk:80", state: "closed" });
    } finally {
      hook.server.stop(true);
    }
  });

  test("no secret leaves the machine: keys, env values and the webhook itself are redacted", async () => {
    const host = await checkHost(["prod"]);
    const prod = branchOf(host, "prod");
    await ops.envSet(host, { project: "shop", branch: "prod", vars: { STRIPE_KEY: "sk_live_abcdefgh123", SHORT: "on" } });
    const adminKey = host.registry.getEnv(prod.id, "INCIBASE_ADMIN_KEY")!.value;
    const storage = host.registry.getEnv(prod.id, "INCIBASE_STORAGE_SECRET")?.value ?? "";
    const hook = webhookServer();
    try {
      await useWebhook(host, hook.url);
      const leak = `boom with ${adminKey} and sk_live_abcdefgh123 and ik_svc_k123456789_zzzzzz and ${storage} posted to ${hook.url}`;
      await host.registry.withLock(() => host.registry.raiseAlert(`release:${prod.id}`, leak, host.clock.t));
      expect((await deliverAlerts(host)).sent).toBe(1);
      const sent = JSON.stringify(hook.received);
      for (const secret of [adminKey, "sk_live_abcdefgh123", "ik_svc_k123456789", "incibase-topic-secret", ...(storage ? [storage] : [])]) expect(sent).not.toContain(secret);
      expect(hook.received[0]!.body).toContain("boom with [redacted] and [redacted] and ik_[redacted]");
      expect(hook.received[0]!.title).toBe("incibase shop/prod release problem");
      expect(redact(host, "SHORT=on")).toBe("SHORT=on");
    } finally {
      hook.server.stop(true);
    }
  });

  test("host set alert_webhook takes https URLs only and audits the host, not the URL", async () => {
    const host = await checkHost([]);
    for (const bad of ["http://ntfy.sh/topic", "https://user:pw@ntfy.sh/topic", "https://ntfy.sh/topic#x", "https://ntfy.sh/a b", "ntfy.sh/topic", "file:///etc/passwd", "https://ntfy.sh/\ntopic", ""]) {
      expect(() => checkAlertWebhook(bad)).toThrow(ops.OpError);
    }
    await expect(setSetting(host, { key: "alert_webhook", value: "http://ntfy.sh/topic" })).rejects.toMatchObject({ code: "INVALID" });
    await expect(setSetting(host, { key: "domain" as never, value: "x" })).rejects.toMatchObject({ code: "INVALID" });
    expect(await setSetting(host, { key: "alert_webhook", value: "https://ntfy.sh/incibase-Xk3q9" })).toEqual({ key: "alert_webhook", set: true, host: "ntfy.sh", tested: null });
    expect(host.registry.getSetting("alert_webhook")).toBe("https://ntfy.sh/incibase-Xk3q9");
    const row = host.registry.listAudit().at(-1)!;
    expect(row).toMatchObject({ action: "host.set", ok: 1 });
    expect(row.detail_json).toBe(JSON.stringify({ key: "alert_webhook", host: "ntfy.sh" }));
    // A test notification that cannot be delivered is an error that names the host only.
    const err = await setSetting(host, { key: "alert_webhook", value: "https://127.0.0.1:1/incibase-topic-secret", test: true }).then(() => null, (e) => e);
    expect(err).toMatchObject({ code: "FAILED" });
    expect(err.message).toContain("127.0.0.1:1");
    expect(err.message).not.toContain("incibase-topic-secret");
    expect(await ops.OPS.setSetting(host, { key: "alert_webhook", value: null })).toMatchObject({ set: false });
    expect(host.registry.getSetting("alert_webhook")).toBeNull();
    expect(JSON.stringify(host.registry.listAudit())).not.toContain("Xk3q9");
  });
});

// ---- the timer ------------------------------------------------------------------------------

describe("the check timer", () => {
  test("its service and timer are rendered with the host's units, enabled and started", async () => {
    const host = await fakeOpsHost({ unitPrefix: "incibase-c13" });
    const service = readFileSync(host.layout.unitFile("incibase-c13-check.service"), "utf8");
    expect(service).toContain(`ExecStart=/usr/local/bin/incibase host check --root ${host.layout.root}\n`);
    expect(service).toContain("Type=oneshot\n");
    const timer = readFileSync(host.layout.unitFile("incibase-c13-check.timer"), "utf8");
    expect(timer).toContain("OnUnitActiveSec=30s\n");
    expect(timer).toContain("Unit=incibase-c13-check.service\n");
    expect(host.sys.readlink(host.layout.timerWantsLink().path)).toBe(host.layout.unitFile("incibase-c13-check.timer"));
    expect(host.driver.calls).toContain("start incibase-c13-check.timer");
    expect(host.driver.isActive("incibase-c13-check.timer")).toBe(true);
    // A value that would split or expand in a unit file is refused.
    expect(() => checkServiceUnit(host.layout, ["/opt/my incibase"])).toThrow(/Refusing/);
    expect(() => checkServiceUnit(host.layout, ["/opt/$HOME/incibase"])).toThrow(/Refusing/);
    expect(checkTimerUnit(host.layout)).toContain("WantedBy=timers.target");
  });

  test("checkTimer: false keeps it stopped and unlinked; render follows the setting", async () => {
    const host = await fakeOpsHost();
    await ops.initHost(host, { domain: "incibase.example.net", checkTimer: false });
    expect(host.registry.getSetting("check_timer")).toBe("off");
    expect(host.driver.isActive(host.layout.units.checkTimer)).toBe(false);
    expect(host.sys.lstat(host.layout.timerWantsLink().path)).toBeNull();
    await ops.initHost(host, { domain: "incibase.example.net", checkTimer: true });
    expect(host.driver.isActive(host.layout.units.checkTimer)).toBe(true);
    expect(host.sys.readlink(host.layout.timerWantsLink().path)).toBe(host.layout.timerWantsLink().target);
    await ops.render(host);
    expect(host.driver.isActive(host.layout.units.checkTimer)).toBe(true);
  });

  test("the check op takes no input", async () => {
    const host = await checkHost([]);
    await expect(check(host, { x: 1 } as never)).rejects.toMatchObject({ code: "INVALID" });
    expect((await ops.OPS.check(host, {})).branches).toEqual([]);
  });
});
