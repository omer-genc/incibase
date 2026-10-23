// Creating and removing branches on the machine (design section 3.2 D.1).
//
// createBranch has two phases. Phase 1 is one short registry transaction:
// a uid from the never-reused counter, the branch row in phase
// 'provisioning', its system env (fresh secrets) and an audit row. Phase 2
// makes the machine match, one idempotent step at a time:
//
//   1. the uid and gid are free, or already ours (a group and user ib-<id>);
//   2. groupadd ib-<id> with gid = uid, then useradd ib-<id> with that uid
//      and gid. An explicit gid, because useradd would take a system gid
//      (< 1000) that a later group could reuse; userdel removes it again;
//   3. getpwnam agrees;
//   4. no file under the host root belongs to that uid or gid, outside the
//      branch's own directory (which only this provisioning creates);
//   5. the branch tree with exact owners and modes, service-keys.json, the
//      env file (0600), the systemd drop-in and `daemon-reload` (with a
//      driver), and the hosts/ and admin/ links;
//   6. phase 'ready', then admin/index.json.
//
// A crash between any two steps leaves the branch in 'provisioning';
// renderHost (`incibase host render`) runs phase 2 again. When a step finds
// something it must not touch (the uid taken by someone else, foreign files),
// the branch is rolled back instead: phase 'deleting', everything it created
// removed, phase 'deleted'. Its uid stays used.
import { VERSION } from "../engine/version.ts";
import type { HostLayout, PathSpec } from "./layout.ts";
import {
  branchLabel,
  branchRef,
  branchUser,
  checkBranchKind,
  checkBranchName,
  checkDomain,
  checkProjectSlug,
  checkTimezone,
  defaultKind,
  defaultLimits,
  defaultProtected,
  newBranchId,
  randomBytes,
  type BranchKind,
} from "./names.ts";
import type { Driver } from "./driver.ts";
import { currentActor, RegistryError, type BranchRow, type InitSettings, type Registry } from "./registry.ts";
import {
  adminIndexContent,
  branchEnv,
  derivedEnv,
  envFileContent,
  removeBranchUnits,
  renderBranchUnits,
  renderHostUnits,
  serviceKeysContent,
  writeIfChanged,
} from "./render.ts";
import type { HostSystem } from "./system.ts";

export interface HostContext {
  layout: HostLayout;
  sys: HostSystem;
  registry: Registry;
  /** The service manager; without one (provisioning tests) no unit is rendered, started or stopped. */
  driver?: Driver;
  /** The command that runs this incibase as root; with it (and a driver) the check timer's units are rendered too. */
  self?: string[];
  now?: () => number;
  random?: (n: number) => Uint8Array;
  actor?: string;
  /** Called before each provisioning step; tests throw from it to stop there. */
  checkpoint?: (step: string) => void;
}

export const BRANCH_HOME = "/nonexistent";
export const BRANCH_SHELL = "/usr/sbin/nologin";

/** Something on the machine that provisioning must not take over or remove; the branch is rolled back. */
export class ProvisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionConflictError";
  }
}

/** Processes still run as the branch's uid; stop them first, then try again. */
export class BranchBusyError extends Error {
  constructor(id: string, pids: number[]) {
    super(`Branch ${id} still has processes (${pids.slice(0, 5).join(", ")}${pids.length > 5 ? ", ..." : ""}); stop it first`);
    this.name = "BranchBusyError";
  }
}

const now = (ctx: HostContext) => (ctx.now ?? Date.now)();
const actor = (ctx: HostContext) => ctx.actor ?? currentActor();
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

// ---- paths with owners ---------------------------------------------------

function groupId(ctx: HostContext, group: string, uid: number): number {
  if (group === "root") return 0;
  if (group === "branch") return uid;
  const entry = ctx.sys.getgrnam(group);
  if (!entry) throw new RegistryError(`The group ${group} does not exist: run \`incibase host init\` first`);
  return entry.gid;
}

function ownerOf(ctx: HostContext, spec: PathSpec, uid: number): { uid: number; gid: number } {
  return { uid: spec.owner === "root" ? 0 : uid, gid: groupId(ctx, spec.group, uid) };
}

/** Creates a directory of `spec` if needed and sets its owner and mode when they differ. */
function applyDir(ctx: HostContext, spec: PathSpec, uid = 0) {
  const want = ownerOf(ctx, spec, uid);
  let info = ctx.sys.lstat(spec.path);
  if (info && info.type !== "dir") throw new ProvisionConflictError(`${spec.path} exists and is not a directory`);
  if (!info) {
    ctx.sys.mkdir(spec.path, spec.mode);
    info = ctx.sys.lstat(spec.path);
  }
  if (!info || info.uid !== want.uid || info.gid !== want.gid) ctx.sys.chown(spec.path, want.uid, want.gid);
  // After chown: it may clear setgid.
  if (ctx.sys.lstat(spec.path)?.mode !== spec.mode) ctx.sys.chmod(spec.path, spec.mode);
}

/** Where a path differs from its spec, as readable lines; empty when it matches. */
export function verifySpecs(ctx: HostContext, specs: PathSpec[], uid = 0): string[] {
  const problems: string[] = [];
  for (const spec of specs) {
    const info = ctx.sys.lstat(spec.path);
    if (!info) {
      problems.push(`${spec.path}: missing`);
      continue;
    }
    if (info.type !== spec.type) problems.push(`${spec.path}: is a ${info.type}, expected a ${spec.type}`);
    const want = ownerOf(ctx, spec, uid);
    if (info.uid !== want.uid || info.gid !== want.gid) problems.push(`${spec.path}: owner ${info.uid}:${info.gid}, expected ${want.uid}:${want.gid}`);
    if (info.mode !== spec.mode) problems.push(`${spec.path}: mode ${info.mode.toString(8)}, expected ${spec.mode.toString(8)}`);
  }
  return problems;
}

/** The host's groups and top-level directories (part of `host init`); safe to run again. */
export function ensureHostTree(ctx: HostContext) {
  for (const group of [ctx.layout.groups.proxy, ctx.layout.groups.admin]) {
    if (!ctx.sys.getgrnam(group)) ctx.sys.groupadd(group);
  }
  for (const spec of ctx.layout.hostTree()) applyDir(ctx, spec);
}

/** The registry settings, the host tree and the host's units (the part of `host init` this layer owns); safe to run again. */
export async function initHost(ctx: HostContext, settings: InitSettings = {}) {
  if (settings.domain !== undefined) checkDomain(settings.domain);
  if (settings.timezone !== undefined) checkTimezone(settings.timezone);
  await ctx.registry.withLock(() => {
    ctx.registry.initSettings(settings);
    ensureHostTree(ctx);
    if (ctx.driver && renderHostUnits(ctx)) ctx.driver.daemonReload();
  });
}

/** Problems with the host tree, for `host doctor`. */
export function verifyHostTree(ctx: HostContext): string[] {
  return verifySpecs(ctx, ctx.layout.hostTree());
}

/** Problems with a ready branch's directories, files and links. */
export function verifyBranch(ctx: HostContext, branch: BranchRow): string[] {
  const { layout } = ctx;
  const problems = verifySpecs(ctx, [...layout.branchTree(branch.id), ...layout.branchFiles(branch.id)], branch.os_uid);
  for (const link of layout.branchLinks(branch.id, branch.label)) {
    const target = ctx.sys.readlink(link.path);
    if (target !== link.target) problems.push(`${link.path}: points at ${target ?? "nothing"}, expected ${link.target}`);
  }
  return problems;
}

// ---- projects ------------------------------------------------------------

export async function createProject(ctx: HostContext, input: { slug: string; name?: string }) {
  const slug = checkProjectSlug(input.slug);
  const name = input.name ?? slug;
  return ctx.registry.withLock(() => {
    if (ctx.registry.getProject(slug)) throw new RegistryError(`Project ${slug} already exists`);
    ctx.registry.tx(() => {
      ctx.registry.insertProject(slug, name, now(ctx));
      ctx.registry.audit({ actor: actor(ctx), action: "project.create", detail: { slug, name }, ok: true }, now(ctx));
    });
    return ctx.registry.getProject(slug)!;
  });
}

// ---- branches ------------------------------------------------------------

export interface CreateBranchInput {
  project: string;
  name: string;
  kind?: BranchKind;
  protected?: boolean;
  runtimeVersion?: string;
}

/** Phase 1 and phase 2; returns the branch, ready. */
export async function createBranch(ctx: HostContext, input: CreateBranchInput): Promise<BranchRow> {
  return ctx.registry.withLock(() => {
    const branch = registerBranch(ctx, input);
    return provisionBranch(ctx, branch.id);
  });
}

/** Phase 1: one transaction; nothing on the machine changes yet. */
export function registerBranch(ctx: HostContext, input: CreateBranchInput): BranchRow {
  const { registry } = ctx;
  const project = checkProjectSlug(input.project);
  const name = checkBranchName(input.name);
  const kind = input.kind === undefined ? defaultKind(name) : checkBranchKind(input.kind);
  const label = branchLabel(project, name);
  const random = ctx.random ?? randomBytes;
  return registry.tx(() => {
    if (!registry.getProject(project)) throw new RegistryError(`No project ${project}: create it first`);
    if (registry.findBranch(project, name)) throw new RegistryError(`Branch ${branchRef(project, name)} already exists`);
    const timezone = registry.getSetting("timezone") ?? "UTC";
    let id = newBranchId(random);
    while (registry.getBranch(id)) id = newBranchId(random);
    const at = now(ctx);
    const row: BranchRow = {
      id,
      project,
      name,
      kind,
      protected: (input.protected ?? defaultProtected(kind)) ? 1 : 0,
      label,
      os_uid: registry.allocateUid(),
      tunnel_port: registry.allocateTunnelPort(),
      phase: "provisioning",
      desired_state: "stopped",
      release_seq: null,
      runtime_version: input.runtimeVersion ?? VERSION,
      busy_unit: null,
      s3_prefix: `${project}/${id}/`,
      limits_json: JSON.stringify(defaultLimits(kind)),
      config_json: "{}",
      copied_from_branch_id: null,
      created_at: at,
      updated_at: at,
      generation: null,
    };
    registry.insertBranch(row);
    const env: [string, string][] = [
      ["INCIBASE_ADMIN_KEY", `ik_admin_${b64url(random(24))}`],
      ["INCIBASE_STORAGE_SECRET", b64url(random(32))],
      ["INCIBASE_BRANCH_LABEL", branchRef(project, name)],
      ["INCIBASE_BRANCH_KIND", kind],
      ["INCIBASE_S3_PREFIX", row.s3_prefix],
      ["TZ", timezone],
    ];
    for (const [envName, value] of env) registry.setEnv(id, envName, value, true);
    registry.audit(
      { actor: actor(ctx), action: "branch.create", branchId: id, detail: { project, name, kind, label, uid: row.os_uid }, ok: true },
      at,
    );
    return row;
  });
}

function step(ctx: HostContext, name: string) {
  ctx.checkpoint?.(name);
}

/** The branch's group and user, created or confirmed as ours; anything else is a conflict. */
function ensureBranchAccount(ctx: HostContext, branch: BranchRow) {
  const { sys } = ctx;
  const user = branchUser(branch.id);
  const uid = branch.os_uid;

  step(ctx, "group");
  const group = sys.getgrgid(uid);
  if (group && group.name !== user) throw new ProvisionConflictError(`gid ${uid} already belongs to the group ${group.name}`);
  if (!group) {
    const named = sys.getgrnam(user);
    if (named) throw new ProvisionConflictError(`The group ${user} already exists with gid ${named.gid}`);
    sys.groupadd(user, uid);
  }

  step(ctx, "user");
  const existing = sys.getpwuid(uid);
  if (existing && existing.name !== user) throw new ProvisionConflictError(`uid ${uid} already belongs to the user ${existing.name}`);
  if (!existing) {
    const named = sys.getpwnam(user);
    if (named) throw new ProvisionConflictError(`The user ${user} already exists with uid ${named.uid}`);
    sys.useradd({ name: user, uid, gid: uid, home: BRANCH_HOME, shell: BRANCH_SHELL, comment: `incibase branch ${branchRef(branch.project, branch.name)}` });
  }

  step(ctx, "verify-user");
  const entry = sys.getpwnam(user);
  if (!entry || entry.uid !== uid || entry.gid !== uid || entry.home !== BRANCH_HOME || entry.shell !== BRANCH_SHELL) {
    throw new ProvisionConflictError(
      `The user ${user} is ${entry ? `uid ${entry.uid}, gid ${entry.gid}, home ${entry.home}, shell ${entry.shell}` : "missing"}; ` +
        `expected uid and gid ${uid}, home ${BRANCH_HOME}, shell ${BRANCH_SHELL}`,
    );
  }
}

/**
 * The branch's derived files: service-keys.json, the env file, its units
 * (with a driver) and the links. Run again by renderHost. True when a unit
 * file changed and `daemon-reload` is still to run (`reload: false`).
 */
export function renderBranchFiles(ctx: HostContext, branch: BranchRow, { reload = true } = {}): boolean {
  const { sys, layout, registry } = ctx;
  const paths = layout.branch(branch.id);
  const uid = branch.os_uid;
  step(ctx, "service-keys");
  writeIfChanged(ctx, paths.serviceKeys, serviceKeysContent(registry.listServiceKeys(branch.id)), { uid: 0, gid: uid, mode: 0o640 });
  step(ctx, "env-file");
  const env = branchEnv(registry.listEnv(branch.id), derivedEnv(layout, branch));
  writeIfChanged(ctx, paths.envFile, envFileContent(env), { uid: 0, gid: 0, mode: 0o600 });
  let unitsChanged = false;
  if (ctx.driver) {
    step(ctx, "units");
    unitsChanged = renderBranchUnits(ctx, branch);
    if (unitsChanged && reload) {
      ctx.driver.daemonReload();
      unitsChanged = false;
    }
  }
  step(ctx, "links");
  for (const link of layout.branchLinks(branch.id, branch.label)) {
    if (sys.readlink(link.path) === link.target) continue;
    const info = sys.lstat(link.path);
    if (info && info.type !== "symlink") throw new ProvisionConflictError(`${link.path} exists and is not a link`);
    sys.symlink(link.target, link.path);
  }
  return unitsChanged;
}

export function renderAdminIndex(ctx: HostContext) {
  const content = adminIndexContent(ctx.registry.listBranches({ phase: "ready" }), ctx.registry.getSetting("domain"));
  writeIfChanged(ctx, ctx.layout.adminIndex, content, { uid: 0, gid: groupId(ctx, ctx.layout.groups.admin, 0), mode: 0o640 });
}

/**
 * Phase 2 for a branch in 'provisioning'; every step can run again. A
 * conflict rolls the branch back and is thrown again. Needs control/LOCK.
 */
export async function provisionBranch(ctx: HostContext, id: string): Promise<BranchRow> {
  const { registry, sys, layout } = ctx;
  return registry.withLock(async () => {
    const branch = registry.getBranch(id);
    if (!branch) throw new RegistryError(`No branch ${id}`);
    if (branch.phase === "ready") return branch;
    if (branch.phase !== "provisioning") throw new RegistryError(`Branch ${id} is ${branch.phase}, not provisioning`);
    try {
      ensureBranchAccount(ctx, branch);
      step(ctx, "scan");
      const paths = layout.branch(id);
      const foreign = sys.findOwned(layout.root, branch.os_uid, [paths.dir]);
      if (foreign) {
        throw new ProvisionConflictError(`${foreign} already belongs to uid or gid ${branch.os_uid}; a new branch must not inherit files`);
      }
      step(ctx, "tree");
      for (const spec of layout.branchTree(id)) applyDir(ctx, spec, branch.os_uid);
      renderBranchFiles(ctx, branch);
    } catch (err) {
      if (!(err instanceof ProvisionConflictError)) throw err;
      await rollbackBranch(ctx, id, err.message);
      throw err;
    }
    step(ctx, "commit");
    registry.tx(() => {
      if (!registry.setPhase(id, "provisioning", "ready", now(ctx))) throw new RegistryError(`Branch ${id} changed phase while it was provisioned`);
      registry.audit({ actor: actor(ctx), action: "branch.provisioned", branchId: id, ok: true }, now(ctx));
    });
    renderAdminIndex(ctx);
    return registry.getBranch(id)!;
  });
}

/** Gives up on a branch in 'provisioning': phase 'deleting', then the same teardown as a delete. */
export async function rollbackBranch(ctx: HostContext, id: string, reason: string) {
  const { registry } = ctx;
  await registry.withLock(() => {
    registry.tx(() => {
      registry.setPhase(id, "provisioning", "deleting", now(ctx));
      registry.audit({ actor: actor(ctx), action: "branch.rollback", branchId: id, detail: { reason }, ok: false }, now(ctx));
    });
  });
  // The tree is small and nothing runs yet, so this is quick even under a caller's lock.
  await teardownBranch(ctx, id);
}

export interface DeleteBranchInput {
  project: string;
  name: string;
  /** Protected branches need their hostname (or label, before a domain is set) here. */
  confirm?: string;
}

/**
 * Removes a ready branch: its links, env file, directory (a production
 * branch's goes to trash/) and user. The registry row stays, phase
 * 'deleted', so its uid and port are never handed out again. The branch's
 * processes must have stopped (step 10 stops its unit first).
 */
export async function deleteBranch(ctx: HostContext, input: DeleteBranchInput) {
  const { registry } = ctx;
  // Mark the branch 'deleting' in one short transaction, then release the lock: the long teardown
  // (systemctl stop can wait a whole drain, plus rm -rf and userdel) must not starve other commands.
  const branch = await registry.withLock(() => {
    const b = registry.findBranch(checkProjectSlug(input.project), checkBranchName(input.name));
    if (!b) throw new RegistryError(`No branch ${branchRef(input.project, input.name)}`);
    if (b.protected) {
      const domain = registry.getSetting("domain");
      const expected = domain ? `${b.label}.${domain}` : b.label;
      if (input.confirm !== expected) {
        throw new RegistryError(`${branchRef(b.project, b.name)} is protected: confirm with its hostname ${expected}`);
      }
    }
    if (b.busy_unit) throw new RegistryError(`${branchRef(b.project, b.name)} is busy (${b.busy_unit})`);
    registry.tx(() => {
      registry.setPhase(b.id, ["ready", "provisioning"], "deleting", now(ctx));
      registry.audit({ actor: actor(ctx), action: "branch.delete", branchId: b.id, detail: { label: b.label }, ok: true }, now(ctx));
    });
    return registry.getBranch(b.id)!;
  });
  await teardownBranch(ctx, branch.id);
  return registry.getBranch(branch.id)!;
}

/**
 * Removes what a branch has on the machine; every step can run again. The
 * 'deleting' phase is a durable marker, so this runs without holding
 * control/LOCK (it takes the lock only for the short registry writes), and
 * the slow `systemctl stop` and `rm -rf` never block other commands. Ends in
 * phase 'deleted'.
 */
async function teardownBranch(ctx: HostContext, id: string) {
  const { registry, sys, layout } = ctx;
  const branch = registry.getBranch(id);
  if (!branch || branch.phase !== "deleting") throw new RegistryError(`Branch ${id} is not being deleted`);
  const paths = layout.branch(id);
  const user = branchUser(id);

  step(ctx, "unlink");
  for (const link of layout.branchLinks(id, branch.label)) {
    // A later branch with the same label may own the link by now.
    if (sys.readlink(link.path) === link.target) sys.remove(link.path);
  }
  await registry.withLock(() => renderAdminIndex(ctx));

  if (ctx.driver) {
    step(ctx, "units");
    for (const unit of [layout.units.branch(id), layout.units.preflight(id), layout.units.snapshot(id)]) {
      ctx.driver.stop(unit);
      ctx.driver.resetFailed(unit);
    }
    if (removeBranchUnits(ctx, id)) ctx.driver.daemonReload();
  }

  step(ctx, "processes");
  const pids = sys.processesOf(branch.os_uid);
  if (pids.length) throw new BranchBusyError(id, pids);

  step(ctx, "env-file");
  if (sys.lstat(paths.envFile)) sys.remove(paths.envFile);

  step(ctx, "tree");
  if (branch.kind === "prod") {
    // The data and its snapshots go to one trash entry, kept 7 days (gcTrash).
    const entry = layout.trashEntry(id, now(ctx));
    if (sys.lstat(paths.dir)) sys.rename(paths.dir, entry);
    if (sys.lstat(paths.backups)) {
      const keep = sys.lstat(entry) ? `${entry}/backups` : `${entry}-backups`;
      sys.rename(paths.backups, keep);
    }
  } else {
    if (sys.lstat(paths.dir)) sys.remove(paths.dir);
    if (sys.lstat(paths.backups)) sys.remove(paths.backups);
  }

  step(ctx, "user");
  const entry = sys.getpwnam(user);
  if (entry && entry.uid === branch.os_uid) sys.userdel(user);
  const group = sys.getgrnam(user);
  if (group && group.gid === branch.os_uid) sys.groupdel(user);

  step(ctx, "commit");
  await registry.withLock(() =>
    registry.tx(() => {
      registry.setPhase(id, "deleting", "deleted", now(ctx));
      registry.audit({ actor: actor(ctx), action: "branch.deleted", branchId: id, ok: true }, now(ctx));
    }),
  );
}

export interface RenderReport {
  provisioned: string[];
  rolledBack: string[];
  deleted: string[];
  rendered: string[];
  failed: { id: string; error: string }[];
  /** Whether a unit file changed (and `daemon-reload` ran). */
  unitsChanged?: boolean;
}

/**
 * `incibase host render`: finishes or rolls back half-done provisioning,
 * finishes deletes, and renders every ready branch's files again. Safe to
 * run any time.
 */
export async function renderHost(ctx: HostContext): Promise<RenderReport> {
  const { registry, layout } = ctx;
  const report: RenderReport = { provisioned: [], rolledBack: [], deleted: [], rendered: [], failed: [] };
  const deleting: string[] = [];
  await registry.withLock(async () => {
    ensureHostTree(ctx);
    let unitsChanged = ctx.driver ? renderHostUnits(ctx) : false;
    for (const branch of registry.listBranches({ phase: ["provisioning", "deleting", "ready"] })) {
      try {
        if (branch.phase === "provisioning") {
          try {
            await provisionBranch(ctx, branch.id);
            report.provisioned.push(branch.id);
          } catch (err) {
            if (!(err instanceof ProvisionConflictError)) throw err;
            report.rolledBack.push(branch.id);
          }
        } else if (branch.phase === "deleting") {
          // Deferred to after the lock: its teardown is slow and must not hold up the host.
          deleting.push(branch.id);
        } else {
          for (const spec of layout.branchTree(branch.id)) applyDir(ctx, spec, branch.os_uid);
          if (renderBranchFiles(ctx, branch, { reload: false })) unitsChanged = true;
          report.rendered.push(branch.id);
        }
      } catch (err) {
        report.failed.push({ id: branch.id, error: (err as Error).message });
      }
    }
    if (unitsChanged) ctx.driver!.daemonReload();
    report.unitsChanged = unitsChanged;
    renderAdminIndex(ctx);
  });
  // Finish deletes without holding control/LOCK, so a drain-long `systemctl stop` never starves other commands.
  for (const id of deleting) {
    try {
      await teardownBranch(ctx, id);
      report.deleted.push(id);
    } catch (err) {
      report.failed.push({ id, error: (err as Error).message });
    }
  }
  return report;
}
