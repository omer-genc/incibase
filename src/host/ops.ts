// The owner operations (design section 5.2): what `sudo incibase …` does
// in M1 and what M4 serves under /control/v1. Every op
//
//   - validates its input with Zod (names through names.ts),
//   - holds control/LOCK only for short transactions,
//   - writes an audit row with its change (and one with ok = 0 when it is refused),
//   - renders derived files after the commit, atomically, and runs
//     `daemon-reload` only when a unit file changed,
//   - refuses while the branch is busy with a job (busy_unit).
//
// Long work (a release, a rollback, a runtime upgrade) runs in a transient
// unit; the op follows its journal and returns its result from the registry.
import { totalmem } from "node:os";
import { z } from "zod";
import { VERSION } from "../engine/version.ts";
import { newServiceKey } from "../engine/service-keys.ts";
import { limitsSchema, configSchema, MiB, parseConfig, parseLimits, resolveLimits, type BranchConfig, type BranchLimits } from "./config.ts";
import { defaults, type OpsContext } from "./context.ts";
import { settled, type UnitStatus } from "./driver.ts";
import { checkRuntimeVersion } from "./layout.ts";
import {
  BRANCH_KINDS,
  branchRef,
  checkBranchName,
  checkDomain,
  checkEnvName,
  checkProjectSlug,
  checkTimezone,
  NameError,
  randomBytes,
} from "./names.ts";
import * as provision from "./provision.ts";
import { currentActor, RegistryLockedError, type BranchRow, type ReleaseRow, type ServiceKeyRow } from "./registry.ts";
import { cleanupPreflight, followJob, gateBranch, newGeneration, recoverSwitchedBranch, stageRelease, startJob, type GateResult } from "./release.ts";
import { branchUrl, removeIfPresent } from "./render.ts";
// runtime.ts uses this module's helpers inside its functions only, so the import cycle is safe either way round.
import { gc, gcRuntimes, installRuntime, listRuntimes, requireInstalled, useCli } from "./runtime.ts";

export { gc, gcRuntimes, installRuntime, listRuntimes, useCli };

/** Why an op refused: `code` for M4's HTTP mapping, the message for people. */
export class OpError extends Error {
  constructor(
    readonly code: "INVALID" | "NOT_FOUND" | "BUSY" | "CONFLICT" | "CONFIRM" | "FAILED",
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}

const actor = (ctx: OpsContext) => ctx.actor ?? currentActor();
const now = (ctx: OpsContext) => (ctx.now ?? Date.now)();

// ---- input -------------------------------------------------------------------

/** A Zod string checked by one of the names.ts functions, keeping its message. */
const checked = (check: (v: unknown) => string) =>
  z.string().transform((value, zctx) => {
    try {
      return check(value);
    } catch (err) {
      zctx.addIssue({ code: "custom", message: (err as Error).message });
      return z.NEVER;
    }
  });

const project = checked(checkProjectSlug);
const branchName = checked(checkBranchName);
const target = { project, branch: branchName };
/** A protected branch's hostname, typed again by the owner. */
const confirm = z.string().max(300).optional();
/** Printable text without control characters. */
const label = z.string().min(1).max(64).regex(/^[^\u0000-\u001f\u007f-\u009f]+$/, "must not contain control characters");

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new OpError("INVALID", `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  }
  return result.data;
}

/** Runs an op; a refusal or failure is audited with ok = 0 (not a bad input or a lock timeout). */
export async function audited<T>(ctx: OpsContext, action: string, branchId: string | null, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof RegistryLockedError) && !(err instanceof OpError && err.code === "INVALID")) {
      try {
        await ctx.registry.withLock(() =>
          ctx.registry.audit({ actor: actor(ctx), action, branchId, detail: { error: (err as Error).message.slice(0, 500) }, ok: false }, now(ctx)),
        );
      } catch {
        // The refusal still reaches the caller.
      }
    }
    throw err;
  }
}

/** The live branch `project/branch`; NOT_FOUND otherwise. */
function findBranch(ctx: OpsContext, input: { project: string; branch: string }): BranchRow {
  const branch = ctx.registry.findBranch(input.project, input.branch);
  if (!branch) throw new OpError("NOT_FOUND", `No branch ${branchRef(input.project, input.branch)}`);
  return branch;
}

/** Ready and not busy: what every op that changes a branch needs. */
function idle(branch: BranchRow): BranchRow {
  if (branch.phase !== "ready") throw new OpError("CONFLICT", `${branchRef(branch.project, branch.name)} is ${branch.phase}`);
  if (branch.busy_unit) {
    throw new OpError("BUSY", `${branchRef(branch.project, branch.name)} is busy (${branch.busy_unit}); try again when it has finished`);
  }
  return branch;
}

/** What a protected branch must be confirmed with: its hostname. */
export function confirmationFor(ctx: OpsContext, branch: BranchRow): string {
  const domain = ctx.registry.getSetting("domain");
  return domain ? `${branch.label}.${domain}` : branch.label;
}

/** Protected branches (and, for a delete, every production branch) need their hostname typed again. */
function requireConfirm(ctx: OpsContext, branch: BranchRow, given: string | undefined, what: string, { prod = false } = {}) {
  if (!branch.protected && !(prod && branch.kind === "prod")) return;
  const expected = confirmationFor(ctx, branch);
  if (given !== expected) {
    const why = branch.protected ? "is protected" : "is a production branch";
    throw new OpError("CONFIRM", `${branchRef(branch.project, branch.name)} ${why}: to ${what} it, confirm with its hostname ${expected}`);
  }
}

/** A short transaction on an idle branch, under the lock, then its files rendered. */
async function changeBranch<T>(ctx: OpsContext, input: { project: string; branch: string }, fn: (branch: BranchRow) => T): Promise<{ branch: BranchRow; value: T }> {
  return ctx.registry.withLock(() => {
    const branch = idle(findBranch(ctx, input));
    const value = ctx.registry.tx(() => fn(branch));
    const after = ctx.registry.getBranch(branch.id)!;
    provision.renderBranchFiles(ctx, after);
    return { branch: after, value };
  });
}

// ---- host --------------------------------------------------------------------

const initSchema = z.strictObject({
  domain: checked(checkDomain),
  timezone: checked(checkTimezone).optional(),
  uidBase: z.number().int().optional(),
  tunnelPortBase: z.number().int().optional(),
  /** incibase.slice MemoryMax; default: the machine's memory less 1 GiB (at least 512 MiB). */
  sliceMemoryMax: z.number().int().min(256 * MiB).optional(),
});

/** The registry settings, host tree and units of `host init` (the parts this layer owns); safe to run again. */
export async function initHost(ctx: OpsContext, input: z.input<typeof initSchema>) {
  const settings = parse(initSchema, input);
  return audited(ctx, "host.init", null, async () => {
    const sliceMemoryMax = settings.sliceMemoryMax ?? Math.max(512 * MiB, Math.floor((totalmem() - 1024 * MiB) / MiB) * MiB);
    await provision.initHost(ctx, { ...settings, sliceMemoryMax });
    await ctx.registry.withLock(() => ctx.registry.audit({ actor: actor(ctx), action: "host.init", detail: { domain: settings.domain }, ok: true }, now(ctx)));
    return { domain: ctx.registry.getSetting("domain"), layout: ctx.layout.saved() };
  });
}

/**
 * `incibase host render`: every derived file again (repairing half-done
 * provisioning and deletes, see provision.renderHost), and branches still
 * marked busy with a job that is gone are freed; their unfinished release
 * becomes 'interrupted'.
 */
export async function render(ctx: OpsContext, _input: Record<string, never> = {}) {
  return audited(ctx, "host.render", null, async () => {
    const interrupted = await ctx.registry.withLock(() => {
      const freed: string[] = [];
      for (const branch of ctx.registry.listBranches({ phase: "ready" })) {
        if (!branch.busy_unit || !settled(ctx.driver.show(branch.busy_unit))) continue;
        ctx.registry.tx(() => {
          for (const release of ctx.registry.listReleases(branch.id)) {
            if (release.status === "staged" || release.status === "preflight") {
              ctx.registry.updateRelease(branch.id, release.seq, {
                status: "interrupted",
                error: `its job ${branch.busy_unit} ended before it finished`,
                finished_at: now(ctx),
              });
            }
          }
          ctx.registry.releaseBusy(branch.id, branch.busy_unit!, now(ctx));
          ctx.registry.audit({ actor: actor(ctx), action: "job.interrupted", branchId: branch.id, detail: { unit: branch.busy_unit }, ok: false }, now(ctx));
        });
        freed.push(branch.id);
      }
      return freed;
    });
    // For each freed branch: clean up any preflight the dead job orphaned, and if the job had already switched
    // the branch to a release that never passed its gate, make sure the branch is healthy on it or revert.
    for (const id of interrupted) {
      const branch = ctx.registry.getBranch(id)!;
      await cleanupPreflight(ctx, branch);
      const current = branch.release_seq === null ? null : ctx.registry.getRelease(id, branch.release_seq);
      if (current && current.status === "interrupted" && current.generation) await recoverSwitchedBranch(ctx, id);
    }
    const report = await provision.renderHost(ctx);
    await ctx.registry.withLock(() =>
      ctx.registry.audit(
        {
          actor: actor(ctx),
          action: "host.render",
          detail: { ...report, rendered: report.rendered.length, interrupted },
          ok: report.failed.length === 0,
        },
        now(ctx),
      ),
    );
    return { ...report, interrupted };
  });
}

const gcSchema = z.strictObject({ olderThanDays: z.number().min(0).max(3650).default(7) });

/** Removes production data that deleted branches left in trash/ longer ago than `olderThanDays` (7). */
export async function gcTrash(ctx: OpsContext, input: z.input<typeof gcSchema> = {}) {
  const { olderThanDays } = parse(gcSchema, input);
  return audited(ctx, "host.gc", null, () =>
    ctx.registry.withLock(() => {
      const cutoff = now(ctx) - olderThanDays * 86_400_000;
      const removed: string[] = [];
      for (const name of ctx.sys.readdir(ctx.layout.trash)) {
        const match = /^b[0-9a-z]{7}-(\d+)(?:-backups)?$/.exec(name);
        if (!match || Number(match[1]) > cutoff) continue;
        removeIfPresent(ctx, `${ctx.layout.trash}/${name}`);
        removed.push(name);
      }
      ctx.registry.audit({ actor: actor(ctx), action: "host.gc", detail: { removed, olderThanDays }, ok: true }, now(ctx));
      return { removed };
    }),
  );
}

// ---- projects and branches -----------------------------------------------------------

const createProjectSchema = z.strictObject({
  slug: project,
  name: label.optional(),
  /** Branches to create with it; default prod and dev. */
  branches: z.array(branchName).max(20).default(["prod", "dev"]),
});

export async function createProject(ctx: OpsContext, input: z.input<typeof createProjectSchema>) {
  const { slug, name, branches } = parse(createProjectSchema, input);
  return audited(ctx, "project.create", null, async () => {
    if (ctx.registry.getProject(slug)) throw new OpError("CONFLICT", `Project ${slug} already exists`);
    const row = await provision.createProject(ctx, { slug, name });
    const created: BranchRow[] = [];
    for (const branch of branches) created.push(await createBranch(ctx, { project: slug, name: branch }));
    return { project: row, branches: created };
  });
}

const createBranchSchema = z.strictObject({
  project,
  name: branchName,
  kind: z.enum(BRANCH_KINDS).optional(),
  protected: z.boolean().optional(),
  runtimeVersion: checked(checkRuntimeVersion).optional(),
});

/** Both provisioning phases (provision.ts), with the branch's units. */
export async function createBranch(ctx: OpsContext, input: z.input<typeof createBranchSchema>): Promise<BranchRow> {
  const data = parse(createBranchSchema, input);
  return audited(ctx, "branch.create", null, async () => {
    if (!ctx.registry.getProject(data.project)) throw new OpError("NOT_FOUND", `No project ${data.project}: create it first`);
    if (ctx.registry.findBranch(data.project, data.name)) throw new OpError("CONFLICT", `Branch ${branchRef(data.project, data.name)} already exists`);
    if (data.runtimeVersion !== undefined) requireInstalled(ctx, data.runtimeVersion);
    return provision.createBranch(ctx, { ...data, runtimeVersion: data.runtimeVersion ?? VERSION });
  });
}

const setBranchSchema = z.strictObject({
  ...target,
  limits: limitsSchema.partial().optional(),
  config: configSchema.optional(),
  protected: z.boolean().optional(),
  /** Turning protection off needs the hostname. */
  confirm,
  /** Restart (with the gate) so the change takes effect now; otherwise at the next start. */
  restart: z.boolean().default(false),
});

/** Changes limits (merged), settings (merged) or protection; renders the drop-in and env file. */
export async function setBranch(ctx: OpsContext, input: z.input<typeof setBranchSchema>) {
  const data = parse(setBranchSchema, input);
  const existing = findBranch(ctx, data);
  return audited(ctx, "branch.set", existing.id, async () => {
    const { branch } = await changeBranch(ctx, data, (branch) => {
      const patch: Parameters<typeof ctx.registry.updateBranch>[1] = {};
      if (data.limits) {
        const limits: BranchLimits = { ...parseLimits(branch.limits_json), ...data.limits };
        parse(limitsSchema, limits);
        try {
          resolveLimits(limits);
        } catch (err) {
          throw new OpError("INVALID", (err as Error).message);
        }
        patch.limits_json = JSON.stringify(limits);
      }
      if (data.config) {
        const config: BranchConfig = { ...parseConfig(branch.config_json), ...data.config };
        if (data.config.timeouts) config.timeouts = { ...parseConfig(branch.config_json).timeouts, ...data.config.timeouts };
        patch.config_json = JSON.stringify(parse(configSchema, config));
      }
      if (data.protected !== undefined && data.protected !== !!branch.protected) {
        if (!data.protected) requireConfirm(ctx, branch, data.confirm, "unprotect");
        patch.protected = data.protected ? 1 : 0;
      }
      ctx.registry.updateBranch(branch.id, patch, now(ctx));
      ctx.registry.audit(
        { actor: actor(ctx), action: "branch.set", branchId: branch.id, detail: { limits: data.limits, config: data.config, protected: data.protected }, ok: true },
        now(ctx),
      );
    });
    const restarted = data.restart && branch.release_seq !== null ? await restartGated(ctx, branch) : null;
    return { branch: ctx.registry.getBranch(branch.id)!, restarted };
  });
}

/** A new generation, a restart and the gate. */
async function restartGated(ctx: OpsContext, branch: BranchRow): Promise<GateResult> {
  if (branch.release_seq === null) throw new OpError("CONFLICT", `${branchRef(branch.project, branch.name)} has no release to run: add one first`);
  const generation = newGeneration(branch.release_seq, ctx.random);
  await ctx.registry.withLock(() => {
    const current = idle(ctx.registry.getBranch(branch.id)!);
    ctx.registry.tx(() => ctx.registry.updateBranch(current.id, { generation, desired_state: "running" }, now(ctx)));
    provision.renderBranchFiles(ctx, ctx.registry.getBranch(branch.id)!);
  });
  const unit = ctx.layout.units.branch(branch.id);
  ctx.driver.resetFailed(unit);
  ctx.driver.restart(unit);
  return gateBranch(ctx, branch.id, generation, defaults.gateFloorMs(ctx));
}

const lifecycleSchema = z.strictObject({ ...target, confirm });

/** Starts the branch's release (desired state running, started at boot) and waits for its gate. */
export async function start(ctx: OpsContext, input: z.input<typeof lifecycleSchema>) {
  const data = parse(lifecycleSchema, input);
  const branch = findBranch(ctx, data);
  return audited(ctx, "branch.start", branch.id, async () => {
    idle(branch);
    if (branch.release_seq === null) throw new OpError("CONFLICT", `${branchRef(branch.project, branch.name)} has no release to run: add one first`);
    const gate = await restartIfStopped(ctx, branch);
    await ctx.registry.withLock(() =>
      ctx.registry.audit({ actor: actor(ctx), action: "branch.start", branchId: branch.id, detail: { healthy: gate.ok }, ok: gate.ok }, now(ctx)),
    );
    return { branch: ctx.registry.getBranch(branch.id)!, gate };
  });
}

async function restartIfStopped(ctx: OpsContext, branch: BranchRow): Promise<GateResult> {
  const unit = ctx.layout.units.branch(branch.id);
  if (branch.desired_state === "running" && ctx.driver.isActive(unit) && branch.generation) {
    return gateBranch(ctx, branch.id, branch.generation, defaults.gateFloorMs(ctx));
  }
  return restartGated(ctx, branch);
}

/** Stops the branch and keeps it stopped (also across reboots). Protected branches need their hostname. */
export async function stop(ctx: OpsContext, input: z.input<typeof lifecycleSchema>) {
  const data = parse(lifecycleSchema, input);
  const existing = findBranch(ctx, data);
  return audited(ctx, "branch.stop", existing.id, async () => {
    const { branch } = await changeBranch(ctx, data, (branch) => {
      requireConfirm(ctx, branch, data.confirm, "stop");
      ctx.registry.updateBranch(branch.id, { desired_state: "stopped" }, now(ctx));
      ctx.registry.audit({ actor: actor(ctx), action: "branch.stop", branchId: branch.id, ok: true }, now(ctx));
    });
    ctx.driver.stop(ctx.layout.units.branch(branch.id));
    return { branch };
  });
}

/** Restarts with a new generation (drain, then start) and waits for the gate. */
export async function restart(ctx: OpsContext, input: z.input<typeof lifecycleSchema>) {
  const data = parse(lifecycleSchema, input);
  const branch = findBranch(ctx, data);
  return audited(ctx, "branch.restart", branch.id, async () => {
    idle(branch);
    const gate = await restartGated(ctx, branch);
    await ctx.registry.withLock(() =>
      ctx.registry.audit({ actor: actor(ctx), action: "branch.restart", branchId: branch.id, detail: { healthy: gate.ok }, ok: gate.ok }, now(ctx)),
    );
    return { branch: ctx.registry.getBranch(branch.id)!, gate };
  });
}

/**
 * Stops and removes a branch: units, links, env file, user. A production
 * branch's data goes to trash/ for 7 days (gcTrash), others' is removed.
 * Its uid is never given out again. Protected branches need their hostname.
 */
export async function deleteBranch(ctx: OpsContext, input: z.input<typeof lifecycleSchema>) {
  const data = parse(lifecycleSchema, input);
  const branch = findBranch(ctx, data);
  return audited(ctx, "branch.delete", branch.id, async () => {
    if (branch.busy_unit) idle(branch);
    requireConfirm(ctx, branch, data.confirm, "delete", { prod: true });
    return provision.deleteBranch(ctx, { project: data.project, name: data.branch, confirm: data.confirm });
  });
}

// ---- releases ---------------------------------------------------------------------

const addReleaseSchema = z.strictObject({
  ...target,
  /** The bundle (`incibase bundle --out app.ib`). */
  file: z.string().min(1).max(4096),
  preflight: z.boolean().optional(),
  allowFieldRemoval: z.boolean().default(false),
  origin: z.string().max(4200).regex(/^[\x20-\x7e]*$/).optional(),
  /** Follow the job until it ends (default); false returns once it started. */
  wait: z.boolean().default(true),
});

export interface ReleaseResult {
  release: ReleaseRow;
  unit: string;
  branch: BranchRow;
}

/** `release add`: stage, then the release job in its transient unit (release.ts). */
export async function addRelease(ctx: OpsContext, input: z.input<typeof addReleaseSchema>): Promise<ReleaseResult> {
  const data = parse(addReleaseSchema, input);
  const branch = findBranch(ctx, data);
  return audited(ctx, "release.add", branch.id, async () => {
    idle(branch);
    const { release, unit } = await stageRelease(ctx, branch.id, data.file, {
      preflight: data.preflight,
      allowFieldRemoval: data.allowFieldRemoval,
      origin: data.origin ?? `cli:${data.file}`,
    });
    if (data.wait) await followJob(ctx, unit);
    return { release: ctx.registry.getRelease(branch.id, release.seq)!, unit, branch: ctx.registry.getBranch(branch.id)! };
  });
}

export async function listReleases(ctx: OpsContext, input: z.input<z.ZodObject<typeof target>>) {
  const data = parse(z.strictObject(target), input);
  const branch = findBranch(ctx, data);
  return ctx.registry.listReleases(branch.id).map((r) => ({ ...r, manifest_json: undefined, current: r.seq === branch.release_seq }));
}

const rollbackSchema = z.strictObject({
  ...target,
  /** The release to go back to; default the newest live or superseded one before the current. */
  to: z.number().int().min(1).optional(),
  /** A snapshot to put back first, e.g. `pre-7`: writes since it was taken are lost. */
  restore: z.string().regex(/^pre-(?:\d{1,9}|upgrade-\d{1,15})$/, "must name a snapshot such as pre-7").optional(),
  /** A restore on a protected branch needs its hostname. */
  confirm,
  wait: z.boolean().default(true),
});

export async function rollback(ctx: OpsContext, input: z.input<typeof rollbackSchema>) {
  const data = parse(rollbackSchema, input);
  const existing = findBranch(ctx, data);
  return audited(ctx, "release.rollback", existing.id, async () => {
    const { unit, to } = await ctx.registry.withLock(() => {
      const branch = idle(findBranch(ctx, data));
      const releases = ctx.registry.listReleases(branch.id);
      const usable = (r: ReleaseRow) => r.pruned_at === null && ctx.sys.lstat(ctx.layout.releaseFile(branch.id, r.seq))?.type === "file";
      const to =
        data.to ??
        releases.find((r) => r.seq !== branch.release_seq && (r.status === "live" || r.status === "superseded") && (branch.release_seq === null || r.seq < branch.release_seq) && usable(r))?.seq;
      if (to === undefined) throw new OpError("NOT_FOUND", `${branchRef(branch.project, branch.name)} has no earlier release to go back to`);
      const release = releases.find((r) => r.seq === to);
      if (!release || !usable(release)) throw new OpError("NOT_FOUND", `Release ${to} of ${branchRef(branch.project, branch.name)} has no files`);
      if (to === branch.release_seq && !data.restore) throw new OpError("CONFLICT", `${branchRef(branch.project, branch.name)} already runs release ${to}`);
      if (data.restore) {
        requireConfirm(ctx, branch, data.confirm, "restore a snapshot of");
        if (ctx.sys.lstat(ctx.layout.snapshot(branch.id, data.restore))?.type !== "file") throw new OpError("NOT_FOUND", `No snapshot ${data.restore}`);
      }
      const n = now(ctx);
      const unit = ctx.layout.units.job("rollback", branch.id, n);
      ctx.registry.tx(() => {
        if (!ctx.registry.claimBusy(branch.id, unit, n)) throw new OpError("BUSY", `${branchRef(branch.project, branch.name)} became busy`);
        ctx.registry.audit({ actor: actor(ctx), action: "release.rollback.start", branchId: branch.id, detail: { to, restore: data.restore ?? null }, ok: true }, n);
      });
      try {
        startJob(ctx, "rollback", branch, n, [String(to), data.restore ?? "-"], `incibase rollback ${branchRef(branch.project, branch.name)} ${to}`);
      } catch (err) {
        ctx.registry.releaseBusy(branch.id, unit, now(ctx));
        throw err;
      }
      return { unit, to };
    });
    if (data.wait) await followJob(ctx, unit);
    const branch = ctx.registry.getBranch(existing.id)!;
    // Derive ok from the job's own outcome, not from the registry state: a restore onto the current release
    // leaves release_seq unchanged, so `release_seq === to` alone would report ok even when the job failed.
    // The rollback job tags its final audit row with its unit; the newest such row is this job's result.
    const outcome = ctx.registry
      .listAudit(existing.id)
      .reverse()
      .find((a) => {
        if (a.action !== "release.rollback") return false;
        try {
          return (JSON.parse(a.detail_json ?? "{}") as { unit?: string }).unit === unit;
        } catch {
          return false;
        }
      });
    return { branch, unit, to, ok: outcome?.ok === 1 };
  });
}

const upgradeSchema = z.strictObject({ ...target, runtimeVersion: checked(checkRuntimeVersion), wait: z.boolean().default(true) });

/** Pins the branch to another installed runtime, with the release's snapshot, preflight, gate and revert. */
export async function upgradeBranch(ctx: OpsContext, input: z.input<typeof upgradeSchema>) {
  const data = parse(upgradeSchema, input);
  const existing = findBranch(ctx, data);
  return audited(ctx, "branch.upgrade", existing.id, async () => {
    requireInstalled(ctx, data.runtimeVersion);
    if (existing.runtime_version === data.runtimeVersion) return { branch: existing, unit: null, ok: true };
    if (existing.release_seq === null) {
      const { branch } = await changeBranch(ctx, data, (branch) => {
        requireInstalled(ctx, data.runtimeVersion);
        ctx.registry.updateBranch(branch.id, { runtime_version: data.runtimeVersion }, now(ctx));
        ctx.registry.audit({ actor: actor(ctx), action: "branch.upgrade", branchId: branch.id, detail: { from: branch.runtime_version, to: data.runtimeVersion }, ok: true }, now(ctx));
      });
      return { branch, unit: null, ok: true };
    }
    const unit = await ctx.registry.withLock(() => {
      const branch = idle(findBranch(ctx, data));
      requireInstalled(ctx, data.runtimeVersion); // again under the lock: gcRuntimes may have removed it meanwhile
      const n = now(ctx);
      const unit = ctx.layout.units.job("upgrade", branch.id, n);
      ctx.registry.tx(() => {
        if (!ctx.registry.claimBusy(branch.id, unit, n)) throw new OpError("BUSY", `${branchRef(branch.project, branch.name)} became busy`);
      });
      try {
        startJob(ctx, "upgrade", branch, n, [data.runtimeVersion], `incibase upgrade ${branchRef(branch.project, branch.name)} ${data.runtimeVersion}`);
      } catch (err) {
        ctx.registry.releaseBusy(branch.id, unit, now(ctx));
        throw err;
      }
      return unit;
    });
    if (data.wait) await followJob(ctx, unit);
    const branch = ctx.registry.getBranch(existing.id)!;
    return { branch, unit, ok: branch.runtime_version === data.runtimeVersion };
  });
}

// ---- env -------------------------------------------------------------------------------

/** Names the host sets or the runtime and systemd rely on; `env set` cannot touch them. */
const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "NO_COLOR",
  "NOTIFY_SOCKET",
  "LISTEN_PID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "MAINPID",
  "MANAGERPID",
  "CREDENTIALS_DIRECTORY",
  "RUNTIME_DIRECTORY",
  "STATE_DIRECTORY",
  "CACHE_DIRECTORY",
  "LOGS_DIRECTORY",
  "CONFIGURATION_DIRECTORY",
]);
const RESERVED_ENV_PREFIX = /^(?:INCIBASE_|BUN_|NODE_|LD_|SYSTEMD_)/;
/**
 * Characters an env value may not have: every control character but tab.
 * A newline would be kept inside the renderer's quotes by systemd, but the
 * env file would then hold a line that reads like a variable of its own to
 * anything that reads it line by line. Multi-line values (PEM keys) go in
 * base64.
 */
const BAD_ENV_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export function checkAppEnvName(value: unknown): string {
  const name = checkEnvName(value);
  if (RESERVED_ENV.has(name) || RESERVED_ENV_PREFIX.test(name)) throw new NameError(`${name} is set by the host; it cannot be changed with env set`);
  return name;
}

const envValue = z
  .string()
  .max(64 * 1024)
  .refine((v) => !BAD_ENV_VALUE.test(v), "must not contain newlines or other control characters (only tabs); encode multi-line values, e.g. in base64");
const envName = checked(checkAppEnvName);

const envSetSchema = z.strictObject({
  ...target,
  vars: z.record(z.string(), envValue).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 200, "give 1 to 200 variables"),
  restart: z.boolean().default(false),
  /** Allow an S3 access key another branch uses (the key, not the prefix, is the isolation boundary). */
  sharedS3Credentials: z.boolean().default(false),
});

/** Sets app variables (never the host's); they reach the process at its next start (`restart: true` for now). */
export async function envSet(ctx: OpsContext, input: z.input<typeof envSetSchema>) {
  const data = parse(envSetSchema, input);
  const names = Object.keys(data.vars).map((name) => parse(envName, name));
  const existing = findBranch(ctx, data);
  return audited(ctx, "env.set", existing.id, async () => {
    const { branch } = await changeBranch(ctx, data, (branch) => {
      for (const name of names) {
        if (ctx.registry.getEnv(branch.id, name)?.system) throw new OpError("INVALID", `${name} is set by the host`);
        if (name === "S3_ACCESS_KEY_ID" && !data.sharedS3Credentials) {
          const others = ctx.registry.branchesWithEnv(name, data.vars[name]!).filter((id) => id !== branch.id);
          if (others.length) {
            throw new OpError(
              "CONFLICT",
              `Another branch uses this S3_ACCESS_KEY_ID; with shared credentials either branch can reach the other's files. Pass sharedS3Credentials to allow it.`,
            );
          }
        }
        ctx.registry.setEnv(branch.id, name, data.vars[name]!, false);
      }
      ctx.registry.audit({ actor: actor(ctx), action: "env.set", branchId: branch.id, detail: { names }, ok: true }, now(ctx));
    });
    const restarted = data.restart && branch.release_seq !== null ? await restartGated(ctx, branch) : null;
    return { names, restarted };
  });
}

const envUnsetSchema = z.strictObject({ ...target, names: z.array(envName).min(1).max(200), restart: z.boolean().default(false) });

export async function envUnset(ctx: OpsContext, input: z.input<typeof envUnsetSchema>) {
  const data = parse(envUnsetSchema, input);
  const existing = findBranch(ctx, data);
  return audited(ctx, "env.unset", existing.id, async () => {
    const { branch, value: removed } = await changeBranch(ctx, data, (branch) => {
      const removed = data.names.filter((name) => ctx.registry.deleteEnv(branch.id, name));
      ctx.registry.audit({ actor: actor(ctx), action: "env.unset", branchId: branch.id, detail: { names: removed }, ok: true }, now(ctx));
      return removed;
    });
    const restarted = data.restart && removed.length && branch.release_seq !== null ? await restartGated(ctx, branch) : null;
    return { removed, restarted };
  });
}

const envListSchema = z.strictObject({ ...target, show: z.boolean().default(false) });

/** The branch's variables; values only with `show` (audited). */
export async function envList(ctx: OpsContext, input: z.input<typeof envListSchema>) {
  const data = parse(envListSchema, input);
  const branch = findBranch(ctx, data);
  if (data.show) await ctx.registry.withLock(() => ctx.registry.audit({ actor: actor(ctx), action: "env.show", branchId: branch.id, ok: true }, now(ctx)));
  return ctx.registry.listEnv(branch.id).map((row) => ({ name: row.name, system: row.system === 1, ...(data.show ? { value: row.value } : {}) }));
}

// ---- keys ---------------------------------------------------------------------------------

const adminKeySchema = z.strictObject({ ...target, rotate: z.boolean().default(false) });

/** The branch's admin key (audited); `rotate` makes a new one and restarts the branch (which also ends admin sessions). */
export async function adminKey(ctx: OpsContext, input: z.input<typeof adminKeySchema>) {
  const data = parse(adminKeySchema, input);
  const existing = findBranch(ctx, data);
  return audited(ctx, data.rotate ? "admin_key.rotate" : "admin_key.read", existing.id, async () => {
    if (!data.rotate) {
      await ctx.registry.withLock(() => ctx.registry.audit({ actor: actor(ctx), action: "admin_key.read", branchId: existing.id, ok: true }, now(ctx)));
      return { key: ctx.registry.getEnv(existing.id, "INCIBASE_ADMIN_KEY")!.value, restarted: null };
    }
    const key = `ik_admin_${Buffer.from((ctx.random ?? randomBytes)(24)).toString("base64url")}`;
    const { branch } = await changeBranch(ctx, data, (branch) => {
      ctx.registry.setEnv(branch.id, "INCIBASE_ADMIN_KEY", key, true);
      ctx.registry.audit({ actor: actor(ctx), action: "admin_key.rotate", branchId: branch.id, ok: true }, now(ctx));
    });
    const restarted = branch.release_seq !== null && branch.desired_state === "running" ? await restartGated(ctx, branch) : null;
    return { key, restarted };
  });
}

const SCOPES = ["internal", "impersonate", "upload"] as const;
const serviceKeyCreateSchema = z.strictObject({
  ...target,
  label,
  scopes: z.array(z.enum(SCOPES)).min(1).max(3).default(["internal"]),
});

/** A key servers call one branch with; only its sha256 is kept. The key itself is returned once. */
export async function serviceKeyCreate(ctx: OpsContext, input: z.input<typeof serviceKeyCreateSchema>) {
  const data = parse(serviceKeyCreateSchema, input);
  const existing = findBranch(ctx, data);
  return audited(ctx, "service_key.create", existing.id, async () => {
    const random = ctx.random ?? randomBytes;
    let id = "";
    const { branch, value } = await changeBranch(ctx, data, (branch) => {
      do id = `k${[...random(9)].map((b) => "0123456789abcdefghjkmnpqrstvwxyz"[b & 31]).join("")}`;
      while (ctx.registry.getServiceKey(id));
      const { key, sha256 } = newServiceKey(id);
      const scopes = [...new Set(data.scopes)];
      const row: ServiceKeyRow = { id, branch_id: branch.id, sha256, scopes: scopes.join(","), label: data.label, created_at: now(ctx), revoked_at: null };
      ctx.registry.insertServiceKey(row);
      ctx.registry.audit({ actor: actor(ctx), action: "service_key.create", branchId: branch.id, detail: { id, label: data.label, scopes }, ok: true }, now(ctx));
      return key;
    });
    const reloaded = await reloadServiceKeys(ctx, branch);
    return { id, key: value, reloaded };
  });
}

export async function serviceKeyList(ctx: OpsContext, input: z.input<z.ZodObject<typeof target>>) {
  const data = parse(z.strictObject(target), input);
  const branch = findBranch(ctx, data);
  return ctx.registry.listServiceKeys(branch.id).map(({ sha256: _sha, ...row }) => ({ ...row, scopes: row.scopes.split(",") }));
}

const serviceKeyRevokeSchema = z.strictObject({ id: z.string().regex(/^k[0-9a-z]{9}$/, "must be a service key id such as k3fq9a1c7e") });

/** Revokes a key: service-keys.json is rendered without it and the branch reloads it (SIGHUP), checked through /api/health. */
export async function serviceKeyRevoke(ctx: OpsContext, input: z.input<typeof serviceKeyRevokeSchema>) {
  const { id } = parse(serviceKeyRevokeSchema, input);
  const key = ctx.registry.getServiceKey(id);
  if (!key) throw new OpError("NOT_FOUND", `No service key ${id}`);
  return audited(ctx, "service_key.revoke", key.branch_id, async () => {
    const existing = ctx.registry.getBranch(key.branch_id)!;
    const { branch } = await changeBranch(ctx, { project: existing.project, branch: existing.name }, (branch) => {
      if (!ctx.registry.revokeServiceKey(id, now(ctx))) throw new OpError("CONFLICT", `Service key ${id} is already revoked`);
      ctx.registry.audit({ actor: actor(ctx), action: "service_key.revoke", branchId: branch.id, detail: { id }, ok: true }, now(ctx));
    });
    const reloaded = await reloadServiceKeys(ctx, branch);
    return { id, reloaded };
  });
}

/**
 * Makes a running branch read service-keys.json again (systemctl reload,
 * SIGHUP) and waits until its admin socket reports the sha256 of the file
 * as written. null when the branch does not run (it reads the file when it
 * starts); false when the reload was not confirmed in time.
 */
async function reloadServiceKeys(ctx: OpsContext, branch: BranchRow): Promise<boolean | null> {
  const unit = ctx.layout.units.branch(branch.id);
  if (!ctx.driver.isActive(unit)) return null;
  const content = ctx.sys.readFile(ctx.layout.branch(branch.id).serviceKeys) ?? "";
  const expected = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  ctx.driver.reload(unit);
  const sleep = defaults.sleep(ctx);
  const health = defaults.health(ctx);
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    if ((await health(ctx.layout.branch(branch.id).adminSock))?.serviceKeys?.sha256 === expected) return true;
    await sleep(defaults.pollMs(ctx));
  }
  return false;
}

// ---- status and logs --------------------------------------------------------------------------

const statusSchema = z.strictObject({ project: project.optional(), branch: branchName.optional() });

export interface BranchStatus {
  ref: string;
  id: string;
  label: string;
  kind: string;
  url: string | null;
  phase: string;
  /** What the registry asks for. */
  desired: string;
  release: number | null;
  releaseStatus: string | null;
  runtime: string;
  generation: string | null;
  busy: string | null;
  limits: ReturnType<typeof resolveLimits>;
  /** What systemd says. */
  actual: UnitStatus;
}

/** Desired state from the registry next to the actual state from `systemctl show`, per branch. */
export async function status(ctx: OpsContext, input: z.input<typeof statusSchema> = {}) {
  const data = parse(statusSchema, input);
  const domain = ctx.registry.getSetting("domain");
  const branches = ctx.registry
    .listBranches({ phase: ["provisioning", "ready", "deleting"], ...(data.project ? { project: data.project } : {}) })
    .filter((b) => data.branch === undefined || b.name === data.branch);
  if (data.branch !== undefined && !branches.length) throw new OpError("NOT_FOUND", `No branch ${branchRef(data.project ?? "?", data.branch)}`);
  const rows: BranchStatus[] = branches.map((b) => ({
    ref: branchRef(b.project, b.name),
    id: b.id,
    label: b.label,
    kind: b.kind,
    url: domain ? branchUrl(b.label, domain) : null,
    phase: b.phase,
    desired: b.desired_state,
    release: b.release_seq,
    releaseStatus: b.release_seq === null ? null : (ctx.registry.getRelease(b.id, b.release_seq)?.status ?? null),
    runtime: b.runtime_version,
    generation: b.generation,
    busy: b.busy_unit,
    limits: resolveLimits(parseLimits(b.limits_json)),
    actual: ctx.driver.show(ctx.layout.units.branch(b.id)),
  }));
  return { branches: rows, alerts: ctx.registry.listAlerts("firing") };
}

const logsSchema = z.strictObject({
  ...target,
  follow: z.boolean().default(false),
  lines: z.number().int().min(1).max(100_000).optional(),
  since: z.string().regex(/^[A-Za-z0-9 :.+-]{1,40}$/).optional(),
  json: z.boolean().default(false),
});

/** The journalctl command that shows a branch's log, for the CLI to run with its terminal. */
export async function logs(ctx: OpsContext, input: z.input<typeof logsSchema>) {
  const data = parse(logsSchema, input);
  const branch = findBranch(ctx, data);
  return { command: ctx.driver.journalCommand({ unit: ctx.layout.units.branch(branch.id), follow: data.follow, lines: data.lines, since: data.since, json: data.json }) };
}

/** Every op by name, for `incibase host op <name> <json>` (and M4's routes). */
export const OPS = {
  initHost,
  render,
  installRuntime,
  listRuntimes,
  useCli,
  gcTrash,
  gcRuntimes,
  gc,
  createProject,
  createBranch,
  setBranch,
  start,
  stop,
  restart,
  deleteBranch,
  addRelease,
  listReleases,
  rollback,
  upgradeBranch,
  envSet,
  envUnset,
  envList,
  adminKey,
  serviceKeyCreate,
  serviceKeyList,
  serviceKeyRevoke,
  status,
  logs,
} as const satisfies Record<string, (ctx: OpsContext, input: never) => Promise<unknown>>;
