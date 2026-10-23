// Releases (design section 3.2 D.2-D.3). `stageRelease` runs in the CLI:
// root checks the bundle's manifest and sha256 (reading it, never importing
// it), stores it as releases/<seq>/app.ib (root:ib-<id> 0640, 'staged') and
// starts the rest as a transient unit, `incibase-release-<id>-<seq>`, so an
// SSH drop does not stop it. The job (`runReleaseJob`) then:
//
//   1. snapshot (production): `incibase-snapshot@<id>` VACUUMs the database
//      INTO the branch's staging dir as the branch, while it keeps running,
//      and root takes that file in by fd as backups/<id>/pre-<seq>.db
//      (snapshot.ts);
//   2. preflight (production by default, opt-in elsewhere): a copy of the
//      snapshot is renamed into preflight/ and `incibase-preflight@<id>` runs
//      `serve --migrate-only` with the new bundle as the branch's uid, in the
//      branch's sandbox and memory limit. 64, 65, 78 or an OOM fail the
//      release; the live branch is not touched;
//   3. switch: the drop-in names the new bundle and INCIBASE_GENERATION =
//      <seq>.<nonce>, then a restart;
//   4. gate: /api/health on the admin socket must report exactly that
//      generation (and keep it for a moment) before the deadline, which grows
//      with the preflight's duration;
//   5. success: 'live', older releases beyond the last 5 lose their files.
//      Failure: unless the new process logged `migration_committed`, the
//      previous release comes back (restart and gate); if it did commit, the
//      release stays, an alert is raised and `rollback --restore` is the way
//      back.
//
// The same deploy runs for a runtime upgrade (a new runtime_version) and,
// without the preflight, for a rollback. Every registry change is a short
// transaction under control/LOCK; files are rendered after it commits.
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describeExit, ExitCode } from "../engine/exit-codes.ts";
import { readManifest, sha256Hex, verifyBundle } from "../engine/manifest.ts";
import { MiB, parseConfig } from "./config.ts";
import { defaults, type OpsContext } from "./context.ts";
import { CLD_EXITED, printable, ranToSuccess, settled, unitJournalTail, type UnitStatus } from "./driver.ts";
import { branchRef, checkBranchId } from "./names.ts";
import { currentActor, RegistryError, type BranchRow, type ReleaseRow } from "./registry.ts";
import { renderBranchFiles } from "./provision.ts";
import { renderPreflightUnit } from "./render.ts";
import { cleanupSnapshot, emptyDir, hasDatabase, placeCopy, pruneSnapshots, restoreDatabase, snapshotDatabase, SnapshotError } from "./snapshot.ts";

/** Bundles above this are refused before they are read whole. */
export const MAX_BUNDLE_BYTES = 64 * MiB;
/** Releases that keep their files. */
export const KEEP_RELEASES = 5;
/** What the preflight unit allows (RuntimeMaxSec=900) and a little more. */
const PREFLIGHT_WAIT_MS = 960_000;
/** The longest a gate waits, whatever the preflight took. */
const GATE_CAP_MS = 30 * 60_000;
/** The JSON line serve logs once a migration committed (migrate.ts). */
const MIGRATION_COMMITTED = '"ev":"migration_committed"';

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

const actor = (ctx: OpsContext) => ctx.actor ?? currentActor();
const now = (ctx: OpsContext) => (ctx.now ?? Date.now)();
const ref = (b: BranchRow) => branchRef(b.project, b.name);

/** `<seq>.<nonce>`: what a process reports as its generation; a new nonce for every start the host asks for. */
export function newGeneration(seq: number, random: (n: number) => Uint8Array = (n) => new Uint8Array(nodeRandomBytes(n))): string {
  return `${seq}.${Buffer.from(random(6)).toString("hex")}`;
}

/** How long the gate waits: twice what the preflight took plus 30 s, never less than the floor. */
export function gateTimeout(ctx: OpsContext, preflightMs: number | null): number {
  return Math.min(GATE_CAP_MS, Math.max(defaults.gateFloorMs(ctx), preflightMs === null ? 0 : 2 * preflightMs + 30_000));
}

async function locked<T>(ctx: OpsContext, fn: () => T | Promise<T>): Promise<T> {
  return ctx.registry.withLock(fn);
}

/**
 * A job's own bookkeeping (claiming, reverting, releasing busy_unit) must not
 * be abandoned because another short-lived command holds control/LOCK, so it
 * waits much longer than an owner op before giving up.
 */
export const JOB_LOCK_TIMEOUT_MS = 10 * 60_000;

async function jobLocked<T>(ctx: OpsContext, fn: () => T | Promise<T>): Promise<T> {
  return ctx.registry.withLock(fn, { timeoutMs: Math.max(JOB_LOCK_TIMEOUT_MS, ctx.registry.lockTimeoutMs) });
}

function branchOf(ctx: OpsContext, id: string): BranchRow {
  const branch = ctx.registry.getBranch(id);
  if (!branch) throw new RegistryError(`No branch ${id}`);
  return branch;
}

/** Renders a branch's files from what the registry says now; daemon-reload when a unit changed. */
function render(ctx: OpsContext, id: string) {
  renderBranchFiles(ctx, branchOf(ctx, id));
}

// ---- the gate --------------------------------------------------------------

export type GateResult = { ok: true; ms: number } | { ok: false; reason: "stopped" | "timeout"; status: UnitStatus; ms: number };

/**
 * Waits until the branch's admin socket reports `generation`, twice, at
 * least `settleMs` apart and without a restart in between. Gives up when
 * the unit stops (it failed, hit its start limit, or exited) or at the deadline.
 */
export async function gateBranch(ctx: OpsContext, id: string, generation: string, timeoutMs: number): Promise<GateResult> {
  const { layout, driver } = ctx;
  const unit = layout.units.branch(id);
  const socket = layout.branch(id).adminSock;
  const sleep = defaults.sleep(ctx);
  const health = defaults.health(ctx);
  const settleMs = defaults.settleMs(ctx);
  const started = performance.now();
  let matched: { at: number; restarts: number } | null = null;
  for (;;) {
    const status = driver.show(unit);
    const elapsed = performance.now() - started;
    if (status.activeState === "failed" || status.activeState === "inactive") return { ok: false, reason: "stopped", status, ms: elapsed };
    const reply = status.activeState === "active" ? await health(socket) : null;
    if (reply?.generation === generation) {
      if (!matched || status.nRestarts !== matched.restarts) matched = { at: performance.now(), restarts: status.nRestarts };
      else if (performance.now() - matched.at >= settleMs) return { ok: true, ms: performance.now() - started };
    } else matched = null;
    if (elapsed > timeoutMs) return { ok: false, reason: "timeout", status, ms: elapsed };
    await sleep(defaults.pollMs(ctx));
  }
}

/** What a stopped or failed unit's main process did, in words, and its exit code (128 + signal when killed). */
export function describeStatus(status: UnitStatus): { exitCode: number | null; text: string } {
  if (status.result === "oom-kill") return { exitCode: 137, text: "it ran out of memory (killed by the OOM killer)" };
  if (status.result === "timeout") return { exitCode: null, text: "it ran past its time limit" };
  if (status.execMainCode === CLD_EXITED) {
    const code = status.execMainStatus;
    const limit =
      status.nRestarts > 0 && (status.activeState === "failed" || status.result === "start-limit-hit")
        ? `; systemd restarted it ${status.nRestarts} times and then gave up (start limit)`
        : "";
    return { exitCode: code, text: `it exited with ${code} (${describeExit(code)})${limit}` };
  }
  if (status.execMainCode > CLD_EXITED) return { exitCode: 128 + status.execMainStatus, text: `it was killed by signal ${status.execMainStatus}` };
  return { exitCode: null, text: `the unit is ${status.activeState}/${status.subState} (${status.result || "no result"})` };
}

/** The last lines `unit` logged after `cursor`, cleaned for root's terminal. */
function journalTail(ctx: OpsContext, unit: string, cursor: string | null, lines = 15): string {
  return unitJournalTail(ctx.driver, unit, cursor, lines);
}

/**
 * Whether the unit's process logged `{"ev":"migration_committed"}` after
 * `cursor`. Only lines its process wrote count, parsed as JSON with that
 * event at the top level: an app's console output is wrapped in
 * `{"ev":"console"}` and does not match.
 */
export function migrationCommittedSince(ctx: OpsContext, unit: string, cursor: string | null): boolean {
  const entries = ctx.driver.journal({ unit, ...(cursor ? { afterCursor: cursor } : {}), grep: MIGRATION_COMMITTED });
  return entries.some((e) => {
    if (!e.invocationId) return false;
    try {
      const line = JSON.parse(e.message) as { ev?: unknown } | null;
      return typeof line === "object" && line !== null && line.ev === "migration_committed";
    } catch {
      return false;
    }
  });
}

// ---- staging (in the CLI) ----------------------------------------------------

export interface StageOptions {
  /** Run a preflight; default: the branch's setting, else on for production. */
  preflight?: boolean;
  allowFieldRemoval?: boolean;
  /** Where the bundle came from, e.g. `cli:/home/omer/app.ib`. */
  origin: string;
}

/**
 * Checks `file` (manifest and sha256, without running it), stores it as
 * the branch's next release and starts the release job. The branch is busy
 * until the job ends. Returns the release row and the job's unit.
 */
export async function stageRelease(ctx: OpsContext, id: string, file: string, options: StageOptions): Promise<{ release: ReleaseRow; unit: string }> {
  const { registry, sys, layout, driver } = ctx;
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new ReleaseError(`${file} is not a file`);
  const size = stat.size;
  if (size > MAX_BUNDLE_BYTES) throw new ReleaseError(`${file} is ${Math.ceil(size / MiB)} MiB; a release bundle may be at most ${MAX_BUNDLE_BYTES / MiB} MiB`);
  // The first line alone first, so a file that is not a bundle is refused without reading it whole.
  readManifest(file);
  const { manifest, source } = verifyBundle(file);
  const sha256 = sha256Hex(source);
  const bytes = Buffer.byteLength(source);

  return locked(ctx, async () => {
    const branch = branchOf(ctx, id);
    if (branch.phase !== "ready") throw new ReleaseError(`${ref(branch)} is ${branch.phase}`);
    if (branch.busy_unit) throw new ReleaseError(`${ref(branch)} is busy (${branch.busy_unit}); try again when it has finished`);
    const runtime = layout.runtimeBinary(branch.runtime_version);
    if (sys.lstat(runtime)?.type !== "file") {
      throw new ReleaseError(`The runtime ${branch.runtime_version} of ${ref(branch)} is not installed (${runtime}); install it first`);
    }
    const seq = registry.nextReleaseSeq(id);
    const unit = layout.units.job("release", id, seq);
    const config = parseConfig(branch.config_json);
    const preflight = options.preflight ?? config.preflight ?? branch.kind === "prod";
    const at = now(ctx);
    const release: ReleaseRow = {
      branch_id: id,
      seq,
      sha256,
      bytes,
      manifest_json: JSON.stringify(manifest),
      status: "staged",
      preflight: preflight ? 1 : 0,
      allow_field_removal: options.allowFieldRemoval ? 1 : 0,
      snapshot: null,
      generation: null,
      preflight_ms: null,
      migration_committed: null,
      exit_code: null,
      error: null,
      origin: options.origin,
      created_at: at,
      finished_at: null,
      pruned_at: null,
    };
    registry.tx(() => {
      registry.insertRelease(release);
      if (!registry.claimBusy(id, unit, at)) throw new ReleaseError(`${ref(branch)} became busy`);
      registry.audit(
        {
          actor: actor(ctx),
          action: "release.add",
          branchId: id,
          detail: { seq, sha256, bytes, origin: options.origin, incibaseVersion: manifest.incibaseVersion, preflight },
          ok: true,
        },
        at,
      );
    });
    try {
      const dir = layout.releaseDir(id, seq);
      if (!sys.lstat(dir)) sys.mkdir(dir, 0o750);
      sys.chown(dir, 0, branch.os_uid);
      sys.chmod(dir, 0o750);
      sys.writeFile(layout.releaseFile(id, seq), source, { uid: 0, gid: branch.os_uid, mode: 0o640 });
      // Still under the lock: `host render` must not take the job for one that died.
      driver.runTransient({ unit, argv: jobArgv(ctx, "release", id, seq), description: `incibase release ${ref(branch)} ${seq}` });
    } catch (err) {
      registry.tx(() => {
        registry.updateRelease(id, seq, { status: "failed", error: `staging failed: ${(err as Error).message}`, finished_at: now(ctx) });
        registry.releaseBusy(id, unit, now(ctx));
      });
      throw err;
    }
    return { release: registry.getRelease(id, seq)!, unit };
  });
}

// ---- jobs --------------------------------------------------------------------

export type JobKind = "release" | "rollback" | "upgrade";

/** The command of a transient job: `<self> host _job --root <root> <kind> <id> <n> [args]`. */
export function jobArgv(ctx: OpsContext, kind: JobKind, id: string, n: number, ...args: string[]): string[] {
  return [...ctx.self, "host", "_job", "--root", ctx.layout.root, kind, id, String(n), ...args];
}

/** Starts a job unit for a branch the caller marked busy with it (under the lock). */
export function startJob(ctx: OpsContext, kind: JobKind, branch: BranchRow, n: number, args: string[], description: string): string {
  const unit = ctx.layout.units.job(kind, branch.id, n);
  ctx.driver.runTransient({ unit, argv: jobArgv(ctx, kind, branch.id, n, ...args), description });
  return unit;
}

/**
 * Prints what a job unit logs until it ends (with --collect, a finished unit
 * is gone). The job runs on if this process dies; its result is in the registry.
 */
export async function followJob(ctx: OpsContext, unit: string, print: (line: string) => void = defaults.log(ctx)) {
  const { driver } = ctx;
  const sleep = defaults.sleep(ctx);
  let cursor: string | undefined;
  const drain = () => {
    for (const entry of driver.journal({ unit, ...(cursor ? { afterCursor: cursor } : { lines: 1000 }) })) {
      cursor = entry.cursor;
      if (entry.invocationId) print(printable(entry.message));
    }
  };
  for (;;) {
    const done = settled(driver.show(unit)) && !driver.isActive(unit);
    drain();
    if (done) return;
    await sleep(defaults.pollMs(ctx));
  }
}

/** `host _job` arguments after `--root <root>`: runs the job, in the transient unit. */
export async function runJob(ctx: OpsContext, args: string[]): Promise<void> {
  const [kind, id, nText, ...rest] = args;
  checkBranchId(id);
  const n = Number(nText);
  if (!Number.isSafeInteger(n) || n < 0) throw new ReleaseError(`Invalid job number ${JSON.stringify(nText)}`);
  if (kind === "release" && rest.length === 0) return void (await runReleaseJob(ctx, id!, n));
  if (kind === "rollback" && rest.length === 2) {
    const to = Number(rest[0]);
    if (!Number.isSafeInteger(to) || to < 1) throw new ReleaseError(`Invalid release ${rest[0]}`);
    return void (await runRollbackJob(ctx, id!, n, to, rest[1] === "-" ? null : rest[1]!));
  }
  if (kind === "upgrade" && rest.length === 1) return void (await runUpgradeJob(ctx, id!, n, rest[0]!));
  throw new ReleaseError(`Unknown job ${JSON.stringify(args)}`);
}

/** Takes the branch for a job: it must be busy with exactly this job's unit. */
async function claimJob(ctx: OpsContext, id: string, unit: string): Promise<BranchRow> {
  return jobLocked(ctx, () => {
    const branch = branchOf(ctx, id);
    if (branch.busy_unit !== unit) throw new ReleaseError(`${ref(branch)} is not busy with ${unit} (busy: ${branch.busy_unit ?? "no"}); not running it`);
    return branch;
  });
}

async function finishJob(ctx: OpsContext, id: string, unit: string) {
  // Always clear busy_unit, even if another command is holding the lock right now.
  await jobLocked(ctx, () => ctx.registry.releaseBusy(id, unit, now(ctx)));
}

// ---- deploy ------------------------------------------------------------------

interface DeployTarget {
  seq: number;
  runtime: string;
  allowFieldRemoval: boolean;
}

interface DeployInput {
  target: DeployTarget;
  preflight: boolean;
  /** Snapshot name to take first (production), e.g. `pre-7`; null for none. */
  snapshotName: string | null;
  /** For log lines: `release shop/prod#7`. */
  what: string;
  /** Called in the transaction that switches the branch to the target. */
  onSwitch?: (generation: string) => void;
  onPreflight?: () => void;
  onSnapshot?: (path: string) => void;
}

export type DeployResult =
  | { ok: true; generation: string; snapshot: string | null; preflightMs: number | null }
  | {
      ok: false;
      stage: "snapshot" | "preflight" | "gate";
      error: string;
      exitCode: number | null;
      migrationCommitted: boolean;
      /** What the branch runs now: the previous release again, nothing (stopped), or still the target. */
      reverted: "previous" | "stopped" | null;
      /** After a revert to the previous release: whether it passed its gate. */
      revertHealthy: boolean | null;
      snapshot: string | null;
      preflightMs: number | null;
    };

async function deploy(ctx: OpsContext, id: string, input: DeployInput): Promise<DeployResult> {
  const { layout, sys, driver, registry } = ctx;
  const log = defaults.log(ctx);
  const before = branchOf(ctx, id);
  const prev = { seq: before.release_seq, runtime: before.runtime_version, desired: before.desired_state };
  const unit = layout.units.branch(id);
  const hasData = hasDatabase(ctx, before);
  let snapshot: string | null = null;
  let preflightMs: number | null = null;
  const fail = (stage: "snapshot" | "preflight", error: string, exitCode: number | null = null): DeployResult => ({
    ok: false,
    stage,
    error,
    exitCode,
    migrationCommitted: false,
    reverted: null,
    revertHealthy: null,
    snapshot,
    preflightMs,
  });

  if (input.snapshotName && hasData) {
    const dir = layout.branch(id).backups;
    if (!sys.lstat(dir)) sys.mkdir(dir, 0o700);
    sys.chown(dir, 0, 0);
    sys.chmod(dir, 0o700);
    snapshot = layout.snapshot(id, input.snapshotName);
    log(`${input.what}: snapshot ${snapshot}`);
    try {
      await snapshotDatabase(ctx, before, snapshot, { uid: 0, gid: 0, mode: 0o600 });
    } catch (err) {
      if (!(err instanceof SnapshotError)) throw err;
      snapshot = null;
      return fail("snapshot", err.message);
    }
    const path = snapshot;
    await locked(ctx, () => registry.tx(() => input.onSnapshot?.(path)));
    pruneSnapshots(ctx, before);
  }

  if (input.preflight) {
    await locked(ctx, () => registry.tx(() => input.onPreflight?.()));
    log(`${input.what}: preflight (serve --migrate-only on ${hasData ? "a copy of the data" : "an empty data dir"})`);
    const result = await preflight(ctx, before, input.target, hasData, snapshot);
    preflightMs = Math.round(result.ms);
    if (!result.ok) return fail("preflight", result.error, result.exitCode);
    log(`${input.what}: preflight passed in ${Math.round(result.ms)} ms`);
  }

  // Switch: the registry first, then the drop-in, then the restart.
  const generation = newGeneration(input.target.seq, ctx.random);
  const cursor = driver.journalCursor();
  await locked(ctx, () => {
    registry.tx(() => {
      registry.updateBranch(id, { release_seq: input.target.seq, runtime_version: input.target.runtime, generation, desired_state: "running" }, now(ctx));
      input.onSwitch?.(generation);
    });
    render(ctx, id);
  });
  log(`${input.what}: starting generation ${generation}`);
  const timeout = gateTimeout(ctx, preflightMs);
  let gate: GateResult;
  try {
    driver.resetFailed(unit);
    driver.restart(unit);
    gate = await gateBranch(ctx, id, generation, timeout);
  } catch (err) {
    gate = { ok: false, reason: "stopped", status: driver.show(unit), ms: 0 };
    log(`${input.what}: restart failed: ${(err as Error).message}`);
  }
  if (gate.ok) {
    log(`${input.what}: healthy after ${Math.round(gate.ms)} ms`);
    return { ok: true, generation, snapshot, preflightMs };
  }

  // Stop the new process before deciding whether its migration committed. On a gate timeout it may still be
  // running, possibly mid-migration; a commit landing between the journal read and a later SIGTERM would be
  // misread as "not committed" and the host would revert over migrated data. Stop first (synchronous), let
  // journald catch up, and only then read the commit marker.
  try {
    driver.stop(unit);
  } catch (err) {
    log(`${input.what}: stopping the unhealthy start failed: ${(err as Error).message}`);
  }
  driver.syncJournal();
  const described = describeStatus(gate.status);
  const why = gate.reason === "timeout" ? `it did not report generation ${generation} within ${Math.round(timeout / 1000)} s` : described.text;
  const tail = journalTail(ctx, unit, cursor);
  const error = `${input.what} did not become healthy: ${why}${tail ? `\n${tail}` : ""}`;
  const committed = migrationCommittedSince(ctx, unit, cursor);
  log(`${input.what}: not healthy: ${why}`);
  if (committed) {
    log(`${input.what}: its migration committed, so it stays (the previous code may not read the migrated data)`);
    return { ok: false, stage: "gate", error, exitCode: described.exitCode, migrationCommitted: true, reverted: null, revertHealthy: null, snapshot, preflightMs };
  }
  const reverted = await revert(ctx, id, prev, input.what);
  return { ok: false, stage: "gate", error, exitCode: described.exitCode, migrationCommitted: false, ...reverted, snapshot, preflightMs };
}

/** Back to what the branch ran before: its previous release (restarted and gated), or stopped when there was none. */
async function revert(
  ctx: OpsContext,
  id: string,
  prev: { seq: number | null; runtime: string; desired: BranchRow["desired_state"] },
  what: string,
): Promise<{ reverted: "previous" | "stopped"; revertHealthy: boolean | null }> {
  const { registry, driver, layout, sys } = ctx;
  const log = defaults.log(ctx);
  const unit = layout.units.branch(id);
  if (prev.seq !== null && sys.lstat(layout.releaseFile(id, prev.seq))?.type === "file") {
    const generation = newGeneration(prev.seq, ctx.random);
    await locked(ctx, () => {
      registry.tx(() => {
        registry.updateBranch(id, { release_seq: prev.seq, runtime_version: prev.runtime, generation, desired_state: prev.desired }, now(ctx));
        registry.audit({ actor: actor(ctx), action: "release.revert", branchId: id, detail: { to: prev.seq, runtime: prev.runtime }, ok: true }, now(ctx));
      });
      render(ctx, id);
    });
    if (prev.desired !== "running") {
      driver.stop(unit);
      log(`${what}: reverted to release ${prev.seq} (stopped, as it was)`);
      return { reverted: "previous", revertHealthy: null };
    }
    log(`${what}: reverting to release ${prev.seq}`);
    driver.resetFailed(unit);
    let healthy = false;
    try {
      driver.restart(unit);
      healthy = (await gateBranch(ctx, id, generation, defaults.gateFloorMs(ctx))).ok;
    } catch (err) {
      log(`${what}: restart of release ${prev.seq} failed: ${(err as Error).message}`);
    }
    log(`${what}: release ${prev.seq} is ${healthy ? "healthy again" : "NOT healthy"}`);
    if (!healthy) {
      await locked(ctx, () =>
        registry.raiseAlert(`branch:${id}`, `${what} failed and the previous release ${prev.seq} did not come back healthy`, now(ctx)),
      );
    }
    return { reverted: "previous", revertHealthy: healthy };
  }
  await locked(ctx, () => {
    registry.tx(() => {
      registry.updateBranch(id, { release_seq: null, runtime_version: prev.runtime, generation: null, desired_state: "stopped" }, now(ctx));
      registry.audit({ actor: actor(ctx), action: "release.revert", branchId: id, detail: { to: null }, ok: true }, now(ctx));
    });
    render(ctx, id);
  });
  driver.stop(unit);
  driver.resetFailed(unit);
  log(`${what}: no earlier release to go back to; the branch is stopped`);
  return { reverted: "stopped", revertHealthy: null };
}

/**
 * Repairs a branch whose deploy job died after it had switched the branch to a
 * release but before the gate finished (the release is now 'interrupted' with a
 * generation recorded). If the branch is healthy on that generation it is
 * marked live; otherwise the branch goes back to the newest release that went
 * live or was superseded (restarted and gated). An alert fires either way, so
 * the owner learns the deploy did not complete.
 */
export async function recoverSwitchedBranch(ctx: OpsContext, id: string): Promise<{ reverted: boolean; healthy: boolean }> {
  const { registry, layout, sys } = ctx;
  const log = defaults.log(ctx);
  const branch = branchOf(ctx, id);
  if (branch.release_seq === null || !branch.generation) return { reverted: false, healthy: false };
  const seq = branch.release_seq;
  const what = `release ${ref(branch)}#${seq}`;
  const gate = branch.desired_state === "running" ? await gateBranch(ctx, id, branch.generation, defaults.gateFloorMs(ctx)) : { ok: false as const };
  if (gate.ok) {
    // The branch is actually serving the switched release; make the registry match and flag it for a look.
    await locked(ctx, () =>
      registry.tx(() => {
        registry.updateRelease(id, seq, { status: "live", finished_at: now(ctx) });
        supersedeOthers(ctx, id, seq);
        registry.audit({ actor: actor(ctx), action: "release.recovered", branchId: id, detail: { seq, healthy: true }, ok: true }, now(ctx));
        registry.raiseAlert(`release:${id}`, `${what}: its deploy job was interrupted but the branch is healthy on it; verify it and re-run the release if needed`, now(ctx));
      }),
    );
    log(`${what}: deploy job interrupted; the branch is healthy on it, kept and marked live (alert raised)`);
    return { reverted: false, healthy: true };
  }
  const back = registry
    .listReleases(id)
    .find((r) => r.seq !== seq && (r.status === "live" || r.status === "superseded") && r.pruned_at === null && sys.lstat(layout.releaseFile(id, r.seq))?.type === "file");
  const prev = back
    ? { seq: back.seq, runtime: branch.runtime_version, desired: "running" as const }
    : { seq: null, runtime: branch.runtime_version, desired: branch.desired_state };
  log(`${what}: deploy job interrupted and the branch is not healthy; reverting to release ${back?.seq ?? "none"}`);
  await revert(ctx, id, prev, what);
  await locked(ctx, () =>
    registry.tx(() => {
      registry.audit({ actor: actor(ctx), action: "release.recovered", branchId: id, detail: { seq, healthy: false, revertedTo: back?.seq ?? null }, ok: false }, now(ctx));
      registry.raiseAlert(`release:${id}`, `${what}: its deploy job was interrupted and the branch was not healthy; reverted to release ${back?.seq ?? "none"}`, now(ctx));
    }),
  );
  return { reverted: true, healthy: false };
}

/** Stops a branch's preflight unit if it is running and waits until it settles; true when it settled. */
async function stopPreflight(ctx: OpsContext, unit: string): Promise<boolean> {
  const { driver } = ctx;
  const sleep = defaults.sleep(ctx);
  if (!settled(driver.show(unit))) {
    driver.stop(unit);
    for (let i = 0; i < 300 && !settled(driver.show(unit)); i++) await sleep(100);
  }
  const ok = settled(driver.show(unit));
  if (ok) driver.resetFailed(unit);
  return ok;
}

/**
 * Stops a branch's preflight and snapshot units, empties preflight/ and the
 * snapshot staging dir and removes its ingest temps in backups/, so a killed
 * job leaves no orphan process or copy behind.
 */
export async function cleanupPreflight(ctx: OpsContext, branch: BranchRow): Promise<void> {
  await stopPreflight(ctx, ctx.layout.units.preflight(branch.id));
  emptyDir(ctx, ctx.layout.branch(branch.id).preflight);
  await cleanupSnapshot(ctx, branch);
}

/** `serve --migrate-only` with the target, as the branch, on a copy of its data (or none). */
async function preflight(
  ctx: OpsContext,
  branch: BranchRow,
  target: DeployTarget,
  hasData: boolean,
  snapshot: string | null,
): Promise<{ ok: true; ms: number } | { ok: false; ms: number; exitCode: number | null; error: string }> {
  const { layout, driver } = ctx;
  const unit = layout.units.preflight(branch.id);
  const dir = layout.branch(branch.id).preflight;
  const owner = { uid: branch.os_uid, gid: branch.os_uid, mode: 0o600 };
  const sleep = defaults.sleep(ctx);
  // An earlier preflight for this branch may still be running (its job was killed mid-run). `start` would be a
  // no-op on that active unit and the loop below would then wait for the OLD process finishing on the NEW copy,
  // and count its exit as this release's preflight. Stop any orphan and wait until it settles before starting ours.
  if (!(await stopPreflight(ctx, unit))) {
    return { ok: false, ms: 0, exitCode: null, error: `preflight: an earlier preflight (${unit}) is still running and would not stop` };
  }
  emptyDir(ctx, dir);
  if (hasData) {
    try {
      // Root's copy is made in backups/ and renamed in: nothing is written through a name the branch controls.
      if (snapshot) placeCopy(ctx, branch, snapshot, join(dir, "data.db"), owner);
      else await snapshotDatabase(ctx, branch, join(dir, "data.db"), owner);
    } catch (err) {
      emptyDir(ctx, dir);
      return { ok: false, ms: 0, exitCode: null, error: `preflight: copying the data failed: ${(err as Error).message}` };
    }
  }
  if (renderPreflightUnit(ctx, { branch, seq: target.seq, runtimeVersion: target.runtime, allowEmpty: !hasData, allowFieldRemoval: target.allowFieldRemoval })) {
    driver.daemonReload();
  }
  const cursor = driver.journalCursor();
  driver.resetFailed(unit);
  const started = performance.now();
  let status: UnitStatus;
  try {
    driver.start(unit);
    for (;;) {
      status = driver.show(unit);
      if (settled(status)) break;
      if (performance.now() - started > PREFLIGHT_WAIT_MS) {
        driver.stop(unit);
        status = driver.show(unit);
        break;
      }
      await sleep(defaults.pollMs(ctx));
    }
  } finally {
    // Never leave our preflight running: an orphan would be mistaken for the next release's preflight.
    if (!settled(driver.show(unit))) driver.stop(unit);
    emptyDir(ctx, dir);
  }
  const ms = performance.now() - started;
  driver.resetFailed(unit);
  if (ranToSuccess(status)) return { ok: true, ms };
  const { exitCode, text } = describeStatus(status);
  const tail = journalTail(ctx, unit, cursor);
  const hint =
    exitCode === ExitCode.MIGRATION_REFUSED
      ? " The migration was refused on a copy of the data; the live branch is untouched."
      : exitCode === ExitCode.DEFINITION
        ? " The app's definition is invalid."
        : exitCode === ExitCode.CONFIG
          ? " The configuration or data does not fit this release."
          : "";
  return { ok: false, ms, exitCode, error: `preflight failed: ${text}.${hint}${tail ? `\n${tail}` : ""}` };
}

/**
 * Removes release files the branch no longer needs: it keeps the newest
 * KEEP_RELEASES releases that went live or were superseded, always the branch's
 * current release and the newest usable release before it (a rollback target),
 * and prunes failed releases' files before successful ones. Rows stay.
 */
function pruneReleases(ctx: OpsContext, id: string): number[] {
  const { registry, layout, sys } = ctx;
  const branch = branchOf(ctx, id);
  const all = registry.listReleases(id); // newest first
  const succeeded = (r: ReleaseRow) => r.status === "live" || r.status === "superseded";
  const successful = all.filter(succeeded);
  const keep = new Set<number>(successful.slice(0, KEEP_RELEASES).map((r) => r.seq));
  if (branch.release_seq !== null) {
    keep.add(branch.release_seq);
    // Always keep a rollback target: the newest successful release before the current one.
    const target = successful.find((r) => r.seq < branch.release_seq!);
    if (target) keep.add(target.seq);
  }
  // Prune failed releases' files before successful ones, oldest first.
  const order = [...all].sort((a, b) => Number(succeeded(a)) - Number(succeeded(b)) || a.seq - b.seq);
  const pruned: number[] = [];
  for (const release of order) {
    if (keep.has(release.seq) || release.pruned_at !== null) continue;
    const dir = layout.releaseDir(id, release.seq);
    if (sys.lstat(dir)) sys.remove(dir);
    registry.updateRelease(id, release.seq, { pruned_at: now(ctx) });
    pruned.push(release.seq);
  }
  return pruned.sort((a, b) => a - b);
}

/** Every other release the branch had live is now superseded. */
function supersedeOthers(ctx: OpsContext, id: string, seq: number) {
  for (const release of ctx.registry.listReleases(id)) {
    if (release.seq !== seq && release.status === "live") ctx.registry.updateRelease(id, release.seq, { status: "superseded" });
  }
}

// ---- the release job -----------------------------------------------------------

export async function runReleaseJob(ctx: OpsContext, id: string, seq: number): Promise<ReleaseRow> {
  const { registry, layout, sys } = ctx;
  const log = defaults.log(ctx);
  const unit = layout.units.job("release", id, seq);
  const branch = await claimJob(ctx, id, unit);
  const what = `release ${ref(branch)}#${seq}`;
  const fail = async (patch: Partial<ReleaseRow>, alert?: string) => {
    await locked(ctx, () =>
      registry.tx(() => {
        registry.updateRelease(id, seq, { status: "failed", finished_at: now(ctx), ...patch });
        registry.audit({ actor: actor(ctx), action: "release.failed", branchId: id, detail: { seq, exitCode: patch.exit_code ?? null }, ok: false }, now(ctx));
        if (alert) registry.raiseAlert(`release:${id}`, alert, now(ctx));
      }),
    );
  };
  try {
    const release = registry.getRelease(id, seq);
    if (!release || release.status !== "staged") throw new ReleaseError(`${what} is ${release?.status ?? "missing"}, not staged`);
    const stored = sys.readFile(layout.releaseFile(id, seq));
    if (stored === null || sha256Hex(stored) !== release.sha256) {
      await fail({ error: `${layout.releaseFile(id, seq)} does not match the sha256 recorded when it was added` });
      return registry.getRelease(id, seq)!;
    }
    const result = await deploy(ctx, id, {
      target: { seq, runtime: branch.runtime_version, allowFieldRemoval: release.allow_field_removal === 1 },
      preflight: release.preflight === 1,
      snapshotName: branch.kind === "prod" ? `pre-${seq}` : null,
      what,
      onSnapshot: (path) => registry.updateRelease(id, seq, { snapshot: path }),
      onPreflight: () => registry.updateRelease(id, seq, { status: "preflight" }),
      onSwitch: (generation) => registry.updateRelease(id, seq, { generation }),
    });
    if (result.ok) {
      await locked(ctx, () => {
        registry.tx(() => {
          registry.updateRelease(id, seq, { status: "live", finished_at: now(ctx), preflight_ms: result.preflightMs, migration_committed: null });
          supersedeOthers(ctx, id, seq);
          registry.resolveAlert(`release:${id}`, now(ctx));
          registry.resolveAlert(`branch:${id}`, now(ctx));
          registry.audit({ actor: actor(ctx), action: "release.live", branchId: id, detail: { seq, generation: result.generation }, ok: true }, now(ctx));
        });
        // Live: the drop-in loses --allow-field-removal.
        render(ctx, id);
        const pruned = pruneReleases(ctx, id);
        if (pruned.length) log(`${what}: removed the files of releases ${pruned.join(", ")}`);
      });
      log(`${what} is live`);
    } else if (result.migrationCommitted) {
      const back = registry.listReleases(id).find((r) => r.seq < seq && (r.status === "live" || r.status === "superseded") && r.pruned_at === null);
      const suggestion = result.snapshot
        ? `incibase release rollback ${ref(branch)}${back ? ` --to ${back.seq}` : ""} --restore pre-${seq}`
        : `incibase release rollback ${ref(branch)}${back ? ` --to ${back.seq}` : ""} (no snapshot: the data stays migrated)`;
      await fail(
        { error: result.error, exit_code: result.exitCode, migration_committed: 1, preflight_ms: result.preflightMs },
        `${what} committed its migration but is not healthy; to go back: ${suggestion}`,
      );
      await locked(ctx, () => registry.tx(() => supersedeOthers(ctx, id, seq)));
      log(`${what} FAILED after its migration committed; it stays in place. To go back (writes since the snapshot are lost):\n  ${suggestion}`);
    } else {
      await fail({ error: result.error, exit_code: result.exitCode, migration_committed: result.stage === "gate" ? 0 : null, preflight_ms: result.preflightMs });
      log(`${what} FAILED at the ${result.stage}${result.reverted === "previous" ? "; the previous release runs again" : result.reverted === "stopped" ? "; the branch is stopped" : "; the live branch was not touched"}`);
      log(printable(result.error, 4000));
    }
  } catch (err) {
    const current = registry.getRelease(id, seq);
    const message = `the release job failed: ${(err as Error).message}`;
    if (current && (current.status === "staged" || current.status === "preflight")) await fail({ error: message }, `${what}: ${message}`);
    else {
      // The job died somewhere the normal paths do not cover; the branch may be in an unknown state, so alert.
      try {
        await jobLocked(ctx, () => registry.raiseAlert(`release:${id}`, `${what}: ${message}`, now(ctx)));
      } catch {
        // best effort
      }
    }
    log(`${what}: ${message}`);
  } finally {
    await finishJob(ctx, id, unit);
  }
  return registry.getRelease(id, seq)!;
}

// ---- rollback ------------------------------------------------------------------

/**
 * Switches the branch to release `to` (restart and gate). With `restore`,
 * the branch is stopped first and its database replaced by that snapshot
 * (the replaced one is kept in backups/<id>/replaced-<at>/).
 *
 * On a gate failure without `--restore`, or on any failure before the data
 * was replaced, the branch goes back to the release it ran before (switched
 * back, restarted and gated), so a failed rollback never leaves a healthy
 * branch down. With `--restore` the data has already been replaced, so the
 * branch is left as it is with an alert.
 */
export async function runRollbackJob(ctx: OpsContext, id: string, n: number, to: number, restore: string | null): Promise<{ ok: boolean; error?: string }> {
  const { registry, layout, sys, driver } = ctx;
  const log = defaults.log(ctx);
  const unit = layout.units.job("rollback", id, n);
  const branch = await claimJob(ctx, id, unit);
  const what = `rollback ${ref(branch)} to #${to}${restore ? ` with ${restore}` : ""}`;
  const branchUnit = layout.units.branch(id);
  const prev = { seq: branch.release_seq, runtime: branch.runtime_version, desired: branch.desired_state };
  let dataReplaced = false;
  const auditResult = (ok: boolean, detail: Record<string, unknown>) =>
    locked(ctx, () => registry.audit({ actor: actor(ctx), action: "release.rollback", branchId: id, detail: { ...detail, unit }, ok }, now(ctx)));
  try {
    const target = registry.getRelease(id, to);
    if (!target || target.pruned_at !== null || sys.lstat(layout.releaseFile(id, to))?.type !== "file") throw new ReleaseError(`Release ${to} has no files to go back to`);
    if (restore) {
      const snapshot = layout.snapshot(id, restore);
      if (sys.lstat(snapshot)?.type !== "file") throw new ReleaseError(`No snapshot ${restore} (${snapshot})`);
      log(`${what}: stopping the branch`);
      driver.stop(branchUnit);
      const sleep = defaults.sleep(ctx);
      for (let i = 0; sys.processesOf(branch.os_uid).length && i < 300; i++) await sleep(100);
      const kept = restoreDatabase(ctx, branch, snapshot, now(ctx));
      dataReplaced = true;
      log(`${what}: data.db replaced by ${restore}${kept ? `; the replaced database is kept in ${kept}` : ""}`);
    }
    const generation = newGeneration(to, ctx.random);
    await locked(ctx, () => {
      registry.tx(() => registry.updateBranch(id, { release_seq: to, generation, desired_state: "running" }, now(ctx)));
      render(ctx, id);
    });
    driver.resetFailed(branchUnit);
    driver.restart(branchUnit);
    const gate = await gateBranch(ctx, id, generation, defaults.gateFloorMs(ctx));
    if (!gate.ok) {
      const error = `${what}: release ${to} did not become healthy: ${gate.reason === "timeout" ? "no answer in time" : describeStatus(gate.status).text}`;
      log(error);
      if (restore) {
        // The data was replaced; there is no safe revert. Leave the branch on the target with an alert.
        await locked(ctx, () => registry.raiseAlert(`branch:${id}`, error, now(ctx)));
        await auditResult(false, { to, restore, error });
        return { ok: false, error };
      }
      // No data changed: put the branch back on the release it ran before and gate it.
      log(`${what}: reverting to release ${prev.seq ?? "none"}`);
      await revert(ctx, id, prev, what);
      await auditResult(false, { to, restore, error, reverted: prev.seq });
      return { ok: false, error };
    }
    await locked(ctx, () =>
      registry.tx(() => {
        registry.updateRelease(id, to, { status: "live", generation });
        supersedeOthers(ctx, id, to);
        registry.resolveAlert(`release:${id}`, now(ctx));
        registry.resolveAlert(`branch:${id}`, now(ctx));
        registry.audit({ actor: actor(ctx), action: "release.rollback", branchId: id, detail: { to, restore, generation, unit }, ok: true }, now(ctx));
      }),
    );
    log(`${what}: release ${to} is live`);
    return { ok: true };
  } catch (err) {
    const error = `${what} failed: ${(err as Error).message}`;
    log(error);
    if (!dataReplaced) {
      // Nothing was replaced on disk; bring the branch back up on the release it ran before.
      try {
        await revert(ctx, id, prev, what);
      } catch (revertErr) {
        log(`${what}: reverting to release ${prev.seq ?? "none"} failed: ${(revertErr as Error).message}`);
      }
    } else {
      await locked(ctx, () => registry.raiseAlert(`branch:${id}`, error, now(ctx)));
    }
    await auditResult(false, { to, restore, error });
    return { ok: false, error };
  } finally {
    await finishJob(ctx, id, unit);
  }
}

// ---- runtime upgrade -------------------------------------------------------------

/** Runs the branch's release on runtime `version`, with the same snapshot, preflight, gate and revert as a release. */
export async function runUpgradeJob(ctx: OpsContext, id: string, n: number, version: string): Promise<DeployResult | null> {
  const { registry, layout } = ctx;
  const log = defaults.log(ctx);
  const unit = layout.units.job("upgrade", id, n);
  const branch = await claimJob(ctx, id, unit);
  const what = `upgrade ${ref(branch)} to ${version}`;
  try {
    if (branch.release_seq === null) throw new ReleaseError(`${ref(branch)} has no release to run`);
    const release = registry.getRelease(id, branch.release_seq)!;
    const config = parseConfig(branch.config_json);
    const result = await deploy(ctx, id, {
      target: { seq: branch.release_seq, runtime: version, allowFieldRemoval: false },
      preflight: config.preflight ?? branch.kind === "prod",
      snapshotName: branch.kind === "prod" ? `pre-upgrade-${n}` : null,
      what,
      onSwitch: (generation) => registry.updateRelease(id, release.seq, { generation }),
    });
    await locked(ctx, () =>
      registry.tx(() => {
        registry.audit(
          {
            actor: actor(ctx),
            action: "branch.upgrade",
            branchId: id,
            detail: result.ok ? { from: branch.runtime_version, to: version } : { from: branch.runtime_version, to: version, stage: result.stage, error: result.error },
            ok: result.ok,
          },
          now(ctx),
        );
        if (!result.ok && result.migrationCommitted) {
          registry.raiseAlert(`release:${id}`, `${what} committed a migration but is not healthy; see incibase release rollback --restore`, now(ctx));
        }
      }),
    );
    log(result.ok ? `${what}: done` : `${what} FAILED: ${printable(result.error, 4000)}`);
    return result;
  } catch (err) {
    const message = `${what} failed: ${(err as Error).message}`;
    log(message);
    try {
      await jobLocked(ctx, () =>
        registry.tx(() => {
          registry.audit({ actor: actor(ctx), action: "branch.upgrade", branchId: id, detail: { to: version, error: (err as Error).message }, ok: false }, now(ctx));
          registry.raiseAlert(`release:${id}`, message, now(ctx));
        }),
      );
    } catch {
      // best effort
    }
    return null;
  } finally {
    await finishJob(ctx, id, unit);
  }
}
