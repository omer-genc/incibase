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
//      env file (0600) and the hosts/ and admin/ links (the systemd drop-in
//      joins here with the systemd driver);
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
import { currentActor, RegistryError, type BranchRow, type InitSettings, type Registry } from "./registry.ts";
import { adminIndexContent, branchEnv, envFileContent, serviceKeysContent } from "./render.ts";
import type { HostSystem } from "./system.ts";

export interface HostContext {
  layout: HostLayout;
  sys: HostSystem;
  registry: Registry;
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

/** The registry settings and the host tree (the part of `host init` this layer owns); safe to run again. */
export async function initHost(ctx: HostContext, settings: InitSettings = {}) {
  if (settings.domain !== undefined) checkDomain(settings.domain);
  if (settings.timezone !== undefined) checkTimezone(settings.timezone);
  await ctx.registry.withLock(() => {
    ctx.registry.initSettings(settings);
    ensureHostTree(ctx);
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

/** Writes a derived file unless it already has this content, owner and mode. */
function writeDerived(ctx: HostContext, path: string, content: string, owner: { uid: number; gid: number; mode: number }) {
  const info = ctx.sys.lstat(path);
  if (info?.type === "file" && info.uid === owner.uid && info.gid === owner.gid && info.mode === owner.mode && ctx.sys.readFile(path) === content) return;
  ctx.sys.writeFile(path, content, owner);
}

/** The branch's derived files: service-keys.json, the env file and the links. Run again by renderHost. */
function renderBranchFiles(ctx: HostContext, branch: BranchRow) {
  const { sys, layout, registry } = ctx;
  const paths = layout.branch(branch.id);
  const uid = branch.os_uid;
  step(ctx, "service-keys");
  writeDerived(ctx, paths.serviceKeys, serviceKeysContent(registry.listServiceKeys(branch.id)), { uid: 0, gid: uid, mode: 0o640 });
  step(ctx, "env-file");
  const env = branchEnv(registry.listEnv(branch.id), { INCIBASE_SERVICE_KEYS_FILE: paths.serviceKeys });
  writeDerived(ctx, paths.envFile, envFileContent(env), { uid: 0, gid: 0, mode: 0o600 });
  step(ctx, "links");
  for (const link of layout.branchLinks(branch.id, branch.label)) {
    if (sys.readlink(link.path) === link.target) continue;
    const info = sys.lstat(link.path);
    if (info && info.type !== "symlink") throw new ProvisionConflictError(`${link.path} exists and is not a link`);
    sys.symlink(link.target, link.path);
  }
}

function renderAdminIndex(ctx: HostContext) {
  const content = adminIndexContent(ctx.registry.listBranches({ phase: "ready" }), ctx.registry.getSetting("domain"));
  writeDerived(ctx, ctx.layout.adminIndex, content, { uid: 0, gid: groupId(ctx, ctx.layout.groups.admin, 0), mode: 0o640 });
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
  await registry.withLock(async () => {
    registry.tx(() => {
      registry.setPhase(id, "provisioning", "deleting", now(ctx));
      registry.audit({ actor: actor(ctx), action: "branch.rollback", branchId: id, detail: { reason }, ok: false }, now(ctx));
    });
    await teardownBranch(ctx, id);
  });
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
  return registry.withLock(async () => {
    const branch = registry.findBranch(checkProjectSlug(input.project), checkBranchName(input.name));
    if (!branch) throw new RegistryError(`No branch ${branchRef(input.project, input.name)}`);
    if (branch.protected) {
      const domain = registry.getSetting("domain");
      const expected = domain ? `${branch.label}.${domain}` : branch.label;
      if (input.confirm !== expected) {
        throw new RegistryError(`${branchRef(branch.project, branch.name)} is protected: confirm with its hostname ${expected}`);
      }
    }
    if (branch.busy_unit) throw new RegistryError(`${branchRef(branch.project, branch.name)} is busy (${branch.busy_unit})`);
    registry.tx(() => {
      registry.setPhase(branch.id, ["ready", "provisioning"], "deleting", now(ctx));
      registry.audit({ actor: actor(ctx), action: "branch.delete", branchId: branch.id, detail: { label: branch.label }, ok: true }, now(ctx));
    });
    await teardownBranch(ctx, branch.id);
    return registry.getBranch(branch.id)!;
  });
}

/** Removes what a branch has on the machine; every step can run again. Ends in phase 'deleted'. */
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
  renderAdminIndex(ctx);

  step(ctx, "processes");
  const pids = sys.processesOf(branch.os_uid);
  if (pids.length) throw new BranchBusyError(id, pids);

  step(ctx, "env-file");
  if (sys.lstat(paths.envFile)) sys.remove(paths.envFile);

  step(ctx, "tree");
  if (sys.lstat(paths.dir)) {
    if (branch.kind === "prod") sys.rename(paths.dir, layout.trashEntry(id, now(ctx)));
    else sys.remove(paths.dir);
  }

  step(ctx, "user");
  const entry = sys.getpwnam(user);
  if (entry && entry.uid === branch.os_uid) sys.userdel(user);
  const group = sys.getgrnam(user);
  if (group && group.gid === branch.os_uid) sys.groupdel(user);

  step(ctx, "commit");
  registry.tx(() => {
    registry.setPhase(id, "deleting", "deleted", now(ctx));
    registry.audit({ actor: actor(ctx), action: "branch.deleted", branchId: id, ok: true }, now(ctx));
  });
}

export interface RenderReport {
  provisioned: string[];
  rolledBack: string[];
  deleted: string[];
  rendered: string[];
  failed: { id: string; error: string }[];
}

/**
 * `incibase host render`: finishes or rolls back half-done provisioning,
 * finishes deletes, and renders every ready branch's files again. Safe to
 * run any time.
 */
export async function renderHost(ctx: HostContext): Promise<RenderReport> {
  const { registry, layout } = ctx;
  const report: RenderReport = { provisioned: [], rolledBack: [], deleted: [], rendered: [], failed: [] };
  await registry.withLock(async () => {
    ensureHostTree(ctx);
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
          await teardownBranch(ctx, branch.id);
          report.deleted.push(branch.id);
        } else {
          for (const spec of layout.branchTree(branch.id)) applyDir(ctx, spec, branch.os_uid);
          renderBranchFiles(ctx, branch);
          report.rendered.push(branch.id);
        }
      } catch (err) {
        report.failed.push({ id: branch.id, error: (err as Error).message });
      }
    }
    renderAdminIndex(ctx);
  });
  return report;
}
