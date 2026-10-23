// `incibase host check` (design section 9): what `<prefix>-check.timer` runs
// every 30 s through `<prefix>-check.service`. For every ready branch that
// should run a release:
//
//   - its unit is active and the admin socket answers /api/health within 5 s:
//     healthy, its counters and alerts are cleared;
//   - nothing listens on the admin socket yet (missing, or the previous
//     process's file, which serve only replaces once it has migrated): the
//     branch is starting. Past 2 minutes that is a "startup slow" alert, never
//     a kill: a long migration must be allowed to finish;
//   - it listens but does not answer (a stalled event loop, SIGSTOP), or
//     answers with an error: one failure. After 3 in a row, all in the same
//     process, the main process gets SIGKILL (systemd's Restart= starts it
//     again) and an alert;
//   - the unit is failed: an alert. When it ended with exit 1 or SIGKILL/137
//     (a crash or the OOM killer), one `reset-failed` and start, 10 minutes
//     into the episode; the episode ends when the branch is healthy again;
//   - the unit is inactive although it should run: an alert.
//
// Then the file system of the host root: alerts at 80 % and 90 % use. Last,
// due alerts go to the owner (alerts.ts).
//
// The counters live in `control/check-state.json` (root 0600), not in memory:
// every run is a new process. Registry changes and the state file are
// written under control/LOCK in one short section; probes, kills and the
// webhook happen outside it.
import { statfsSync } from "node:fs";
import { z } from "zod";
import { deliverAlerts, type DeliveryReport } from "./alerts.ts";
import type { OpsContext } from "./context.ts";
import { CLD_DUMPED, CLD_EXITED, CLD_KILLED, printable, type UnitStatus } from "./driver.ts";
import { branchRef } from "./names.ts";
import { OpError } from "./ops.ts";
import { currentActor, type BranchRow } from "./registry.ts";

/** How long one health probe may take. */
export const PROBE_TIMEOUT_MS = 5000;
/** Consecutive failed probes (30 s apart) before the process is killed: a stall is ended within about 90 s. */
export const KILL_AFTER_FAILURES = 3;
/** How long a unit may run without listening before "startup slow". */
export const STARTUP_SLOW_MS = 120_000;
/** How long a failed unit waits for its one automatic retry. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** Use of the root's file system that raises an alert, in percent. */
export const DISK_ALERT_PERCENTS = [80, 90] as const;

/** What one probe of a branch's admin socket found. */
export type ProbeResult =
  | { kind: "ok" }
  /** Nothing listens: the process has not bound its socket yet (or not since its restart). */
  | { kind: "down"; detail: string }
  /** Something listens but does not answer in time, or answers with an error. */
  | { kind: "fail"; detail: string };

export interface DiskUsage {
  /** Percent of the file system in use, as df counts it (blocks reserved for root count as unavailable). */
  usedPercent: number;
  /** Bytes an unprivileged writer can still use. */
  availableBytes: number;
}

/** What a check runs with; tests replace the probe, the disk and the clock. */
export interface CheckContext extends OpsContext {
  probe?: (socket: string, timeoutMs: number) => Promise<ProbeResult>;
  diskUsage?: (path: string) => DiskUsage;
}

const now = (ctx: OpsContext) => (ctx.now ?? Date.now)();
const actor = (ctx: OpsContext) => ctx.actor ?? currentActor();

/** Error codes that mean nothing is listening on the socket (yet). */
const NOT_LISTENING = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "ConnectionRefused", "FailedToOpenSocket"]);

/**
 * GET /api/health on an admin socket, as root. Only the status is read; the
 * answer comes from tenant code. A symlink in the socket's place is refused:
 * the branch's user owns the directory.
 */
export async function probeAdminSocket(ctx: OpsContext, socket: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const info = ctx.sys.lstat(socket);
  if (!info) return { kind: "down", detail: "no admin socket yet" };
  if (info.type === "symlink") return { kind: "fail", detail: "admin.sock is a symlink" };
  try {
    const res = await fetch("http://localhost/api/health", { unix: socket, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
    await res.body?.cancel().catch(() => {});
    return res.status === 200 ? { kind: "ok" } : { kind: "fail", detail: `/api/health answered HTTP ${res.status}` };
  } catch (err) {
    const { name, code } = err as { name?: string; code?: string };
    if (name === "TimeoutError" || name === "AbortError") return { kind: "fail", detail: `no answer within ${timeoutMs / 1000} s` };
    if (code && NOT_LISTENING.has(code)) return { kind: "down", detail: `nothing listens on the admin socket (${code})` };
    return { kind: "fail", detail: `probe failed (${code ?? name ?? "error"})` };
  }
}

/** The file system holding `path`, as df shows it. */
export function statDisk(path: string): DiskUsage {
  const st = statfsSync(path);
  const used = (Number(st.blocks) - Number(st.bfree)) * Number(st.bsize);
  const available = Number(st.bavail) * Number(st.bsize);
  return { usedPercent: used + available > 0 ? Math.ceil((used / (used + available)) * 100) : 0, availableBytes: available };
}

// ---- state ---------------------------------------------------------------------

const branchStateSchema = z.strictObject({
  /** The systemd invocation the counters below belong to. */
  invocation: z.string().max(64),
  failures: z.number().int().min(0).max(1000),
  /** When this invocation was first seen not listening. */
  downSince: z.number().int().nullable(),
  /** A failure episode: from the first failed sighting until the branch is healthy again. */
  failedSince: z.number().int().nullable(),
  retried: z.boolean(),
});
export type BranchCheckState = z.infer<typeof branchStateSchema>;

const stateSchema = z.strictObject({ version: z.literal(1), branches: z.record(z.string().regex(/^b[0-9a-z]{7}$/), branchStateSchema) });
export type CheckState = z.infer<typeof stateSchema>;

const fresh = (invocation: string): BranchCheckState => ({ invocation, failures: 0, downSince: null, failedSince: null, retried: false });

/** The saved counters; a missing, unreadable or hand-broken file starts over (it only delays a kill or a retry). */
export function readCheckState(ctx: OpsContext): CheckState {
  try {
    const text = ctx.sys.readFile(ctx.layout.checkState);
    if (text !== null) {
      const parsed = stateSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    }
  } catch {
    // Starts over.
  }
  return { version: 1, branches: {} };
}

function writeCheckState(ctx: OpsContext, state: CheckState) {
  ctx.sys.writeFile(ctx.layout.checkState, `${JSON.stringify(state, null, 2)}\n`, { uid: 0, gid: 0, mode: 0o600 });
}

// ---- deciding ------------------------------------------------------------------------

export type BranchOutcome = "ok" | "starting" | "failing" | "killed" | "failed" | "retried" | "inactive" | "transition";

export interface Assessment {
  outcome: BranchOutcome;
  detail: string;
  state: BranchCheckState;
  raise: { key: string; message: string }[];
  resolve: string[];
  action: "kill" | "retry" | null;
}

export const alertKeys = (id: string) => ({ health: `health:${id}`, startup: `startup:${id}`, unit: `unit:${id}` });

/** How a main process ended, for people: `exit 1`, `signal 9`. */
function ended(status: UnitStatus): string {
  if (status.execMainCode === CLD_EXITED) return `exit ${status.execMainStatus}`;
  if (status.execMainCode === CLD_KILLED || status.execMainCode === CLD_DUMPED) return `signal ${status.execMainStatus}`;
  return "no exit status";
}

/** A crash or the OOM killer: worth one more start later. 64, 65 and 78 (definition errors) are not. */
export function retryable(status: UnitStatus): boolean {
  if (status.execMainCode === CLD_EXITED) return status.execMainStatus === 1 || status.execMainStatus === 137;
  return (status.execMainCode === CLD_KILLED || status.execMainCode === CLD_DUMPED) && status.execMainStatus === 9;
}

/**
 * What to do about one branch, from what systemd and the probe say and the
 * counters of the previous run. Pure: the caller acts on it.
 */
export function assess(branch: BranchRow, status: UnitStatus, probe: ProbeResult | null, previous: BranchCheckState | undefined, at: number): Assessment {
  const ref = branchRef(branch.project, branch.name);
  const keys = alertKeys(branch.id);
  // A new process starts its counters over; a failure episode spans processes.
  const state: BranchCheckState =
    previous && previous.invocation === status.invocationId ? { ...previous } : { ...fresh(status.invocationId), failedSince: previous?.failedSince ?? null, retried: previous?.retried ?? false };
  const result = (outcome: BranchOutcome, detail: string, extra: Partial<Assessment> = {}): Assessment => ({ outcome, detail, state, raise: [], resolve: [], action: null, ...extra });

  if (status.activeState === "failed") {
    state.failures = 0;
    state.downSince = null;
    state.failedSince ??= at;
    const how = `${status.result || "failed"}, ${ended(status)}`;
    if (retryable(status) && !state.retried && at - state.failedSince >= RETRY_AFTER_MS) {
      state.retried = true;
      return result("retried", how, {
        action: "retry",
        raise: [{ key: keys.unit, message: `${ref} failed (${how}); check ran reset-failed and started it once, ${Math.round((at - state.failedSince) / 60_000)} min after it failed` }],
        resolve: [keys.startup],
      });
    }
    const next = !retryable(status)
      ? "it is not retried: see incibase logs"
      : state.retried
        ? "it was retried once and failed again: see incibase logs"
        : `check retries it once ${Math.ceil((state.failedSince + RETRY_AFTER_MS - at) / 60_000)} min from now`;
    return result("failed", how, { raise: [{ key: keys.unit, message: `${ref} failed (${how}) and systemd stopped restarting it; ${next}` }], resolve: [keys.startup] });
  }
  if (status.activeState === "inactive" || status.loadState === "not-found") {
    state.failures = 0;
    state.downSince = null;
    return result("inactive", status.activeState, { raise: [{ key: keys.unit, message: `${ref} should run, but its unit is ${status.activeState || status.loadState}` }], resolve: [keys.startup] });
  }
  // activating (including systemd's auto-restart wait) counts as starting; deactivating and reloading pass.
  if (status.activeState !== "active" && status.activeState !== "activating") {
    return result("transition", status.activeState);
  }
  if (status.activeState === "activating" || !probe || probe.kind === "down") {
    state.failures = 0;
    state.downSince ??= at;
    const waited = at - state.downSince;
    const detail = probe?.kind === "down" ? probe.detail : status.subState || status.activeState;
    if (waited >= STARTUP_SLOW_MS) {
      return result("starting", detail, {
        raise: [{ key: keys.startup, message: `${ref} has been starting for ${Math.round(waited / 1000)} s without answering on its admin socket (${detail}); a long migration? It is not killed` }],
        resolve: [keys.unit],
      });
    }
    return result("starting", detail, { resolve: [keys.unit] });
  }
  if (probe.kind === "ok") {
    return result("ok", "healthy", { state: { ...fresh(status.invocationId) }, resolve: [keys.health, keys.startup, keys.unit] });
  }
  state.downSince = null;
  state.failures++;
  if (state.failures >= KILL_AFTER_FAILURES) {
    const failures = state.failures;
    state.failures = 0;
    return result("killed", probe.detail, {
      action: "kill",
      raise: [
        {
          key: keys.health,
          message: `${ref} failed ${failures} health checks in a row (last: ${probe.detail}); check killed its process (SIGKILL) and systemd starts it again`,
        },
      ],
      resolve: [keys.startup, keys.unit],
    });
  }
  return result("failing", `${probe.detail} (${state.failures} of ${KILL_AFTER_FAILURES})`, { resolve: [keys.unit] });
}

// ---- running -------------------------------------------------------------------------

export interface BranchCheck {
  ref: string;
  id: string;
  outcome: BranchOutcome | "skipped";
  detail: string;
}

export interface CheckReport {
  at: number;
  branches: BranchCheck[];
  disk: (DiskUsage & { path: string }) | null;
  notifications: DeliveryReport;
}

/** Whether `host check` looks after this branch: ready, asked to run, with a release, and no job busy on it. */
function watched(branch: BranchRow): boolean {
  return branch.phase === "ready" && branch.desired_state === "running" && branch.release_seq !== null && branch.busy_unit === null;
}

/** One run of the check: branches, disk, then the notifications that are due. */
export async function runCheck(ctx: CheckContext): Promise<CheckReport> {
  const { registry, layout, driver } = ctx;
  const at = now(ctx);
  const probe = ctx.probe ?? ((socket: string, timeoutMs: number) => probeAdminSocket(ctx, socket, timeoutMs));
  const previous = readCheckState(ctx);
  const state: CheckState = { version: 1, branches: {} };
  const branches = registry.listBranches({ phase: ["provisioning", "ready", "deleting"] });

  // Probes in parallel: one stuck branch must not delay the others.
  const assessed = await Promise.all(
    branches.filter(watched).map(async (branch) => {
      const status = driver.show(layout.units.branch(branch.id));
      const result = status.activeState === "active" ? await probe(layout.branch(branch.id).adminSock, PROBE_TIMEOUT_MS) : null;
      return { branch, assessment: assess(branch, status, result, previous.branches[branch.id], at) };
    }),
  );

  // Act first, so the alert says what happened.
  for (const { branch, assessment } of assessed) {
    const unit = layout.units.branch(branch.id);
    try {
      if (assessment.action === "kill") driver.killMain(unit, "SIGKILL");
      if (assessment.action === "retry") {
        driver.resetFailed(unit);
        driver.start(unit);
      }
    } catch (err) {
      const message = printable((err as Error).message, 300);
      for (const r of assessment.raise) r.message += ` (but ${assessment.action === "kill" ? "the kill" : "the start"} failed: ${message})`;
      assessment.detail += `; ${assessment.action} failed: ${message}`;
    }
    state.branches[branch.id] = assessment.state;
  }

  const disk = (() => {
    try {
      return { path: layout.root, ...(ctx.diskUsage ?? statDisk)(layout.root) };
    } catch {
      return null;
    }
  })();

  await registry.withLock(() => {
    registry.tx(() => {
      const keep = new Set<string>();
      for (const { branch, assessment } of assessed) {
        for (const { key, message } of assessment.raise) {
          registry.raiseAlert(key, message, at);
          keep.add(key);
        }
        for (const key of assessment.resolve) registry.resolveAlert(key, at);
        if (assessment.action) {
          registry.audit(
            { actor: actor(ctx), action: `check.${assessment.action}`, branchId: branch.id, detail: { outcome: assessment.outcome, detail: assessment.detail }, ok: true },
            at,
          );
        }
      }
      // Branches the check no longer looks after (stopped, deleted, without a release) have nothing to alert about;
      // one a job is busy with keeps its alerts until the job is done.
      const busy = new Set(branches.filter((b) => b.busy_unit !== null).map((b) => b.id));
      for (const alert of registry.listAlerts("firing")) {
        const match = /^(health|startup|unit):(b[0-9a-z]{7})$/.exec(alert.key);
        if (match && !keep.has(alert.key) && !busy.has(match[2]!) && !assessed.some((a) => a.branch.id === match[2])) registry.resolveAlert(alert.key, at);
      }
      if (disk) {
        for (const percent of DISK_ALERT_PERCENTS) {
          const key = `disk:${percent}`;
          if (disk.usedPercent >= percent) {
            const gib = (disk.availableBytes / 1024 ** 3).toFixed(1);
            registry.raiseAlert(key, `The file system of ${layout.root} is ${disk.usedPercent}% full (${gib} GiB free)`, at);
          } else registry.resolveAlert(key, at);
        }
      }
    });
    writeCheckState(ctx, state);
  });

  const report: CheckReport = {
    at,
    branches: branches.map((branch) => {
      const a = assessed.find((x) => x.branch.id === branch.id)?.assessment;
      return {
        ref: branchRef(branch.project, branch.name),
        id: branch.id,
        outcome: a?.outcome ?? "skipped",
        detail: a?.detail ?? (branch.busy_unit ? `busy (${branch.busy_unit})` : branch.phase !== "ready" ? branch.phase : branch.release_seq === null ? "no release" : "stopped"),
      };
    }),
    disk,
    notifications: await deliverAlerts(ctx),
  };
  return report;
}

/** `incibase host check`: one run; the timer calls it every 30 s. */
export async function check(ctx: CheckContext, input: Record<string, never> = {}) {
  if (Object.keys(input ?? {}).length) throw new OpError("INVALID", "check takes no input");
  return runCheck(ctx);
}

/**
 * Starts the check timer unless the host turned it off (check_timer = off),
 * and stops it when it did. After its units were rendered and loaded.
 */
export function ensureCheckTimer(ctx: OpsContext): "started" | "running" | "stopped" | "off" {
  const timer = ctx.layout.units.checkTimer;
  if (ctx.registry.getSetting("check_timer") === "off") {
    if (!ctx.driver.isActive(timer)) return "off";
    ctx.driver.stop(timer);
    return "stopped";
  }
  if (ctx.driver.isActive(timer)) return "running";
  ctx.driver.start(timer);
  return "started";
}
