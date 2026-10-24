// Provisioning on a real Linux machine, as root: users, groups, owners, modes,
// links and the env file as systemd reads it. Skipped unless
// INCIBASE_TEST_HOST=1 on Linux as root. Uses its own host root
// (INCIBASE_TEST_HOST_ROOT, default /var/lib/incibase-test), uid base
// (INCIBASE_TEST_UID_BASE, default 71000) and a layout (groups, unit prefix,
// runtime root, CLI link) named after the root, so several runs can share a
// machine; it removes everything it created.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chownSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HostLayout, DEFAULT_ROOT } from "../src/host/layout.ts";
import {
  BranchBusyError,
  createBranch,
  createProject,
  deleteBranch,
  initHost,
  ProvisionConflictError,
  renderHost,
  verifyBranch,
  verifyHostTree,
  type HostContext,
} from "../src/host/provision.ts";
import { Registry, type BranchRow } from "../src/host/registry.ts";
import { LinuxSystem } from "../src/host/system.ts";
import { parseEnvFile } from "./host-helpers.ts";

const enabled = process.env.INCIBASE_TEST_HOST === "1" && process.platform === "linux" && process.getuid?.() === 0;
const ROOT = process.env.INCIBASE_TEST_HOST_ROOT ?? "/var/lib/incibase-test";
const UID_BASE = Number(process.env.INCIBASE_TEST_UID_BASE ?? 71000);
const MARKER = ".incibase-test-root";
const label = basename(ROOT).slice(0, 24);
const GROUPS = { proxy: `${label}-proxy`, admin: `${label}-admin` };
/** No units or runtimes here (no driver), but a layout of its own all the same: never the machine's defaults. */
const LAYOUT = { groups: GROUPS, unitPrefix: label, runtimeRoot: `/usr/local/lib/${label}`, cliLink: `/usr/local/lib/${label}-bin/incibase` };

const sys = new LinuxSystem();
let ctx: HostContext;

function asUser(uid: number, command: string[]): number {
  const result = Bun.spawnSync(["setpriv", `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--", ...command], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode ?? -1;
}

function mode(path: string) {
  const st = lstatSync(path);
  return { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
}

function gid(name: string): number {
  const group = sys.getgrnam(name);
  if (!group) throw new Error(`no group ${name}`);
  return group.gid;
}

/** Removes the users, groups and tree of this test host. */
function cleanup() {
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
  for (const name of [`${label}-foreign`]) if (sys.getpwnam(name)) sys.userdel(name);
  for (const name of [`${label}-foreign`, GROUPS.proxy, GROUPS.admin]) if (sys.getgrnam(name)) sys.groupdel(name);
  rmSync(ROOT, { recursive: true, force: true });
}

describe.skipIf(!enabled)("host provisioning on Linux", () => {
  beforeAll(async () => {
    if (ROOT === DEFAULT_ROOT) throw new Error(`Refusing to test on ${DEFAULT_ROOT}`);
    if (existsSync(ROOT)) {
      if (!existsSync(join(ROOT, MARKER))) throw new Error(`${ROOT} exists and is not a test root; remove it or pick another INCIBASE_TEST_HOST_ROOT`);
      cleanup();
    }
    mkdirSync(ROOT, { mode: 0o755 });
    writeFileSync(join(ROOT, MARKER), "");
    const layout = new HostLayout({ root: ROOT, ...LAYOUT });
    ctx = { layout, sys, registry: Registry.open(layout), actor: "root:test" };
    await initHost(ctx, { uidBase: UID_BASE, domain: "incibase.example.net", timezone: "Europe/Istanbul" });
    await createProject(ctx, { slug: "shop" });
  });

  afterAll(() => {
    ctx?.registry.close();
    cleanup();
  });

  test("the host tree has its groups, owners and modes", () => {
    expect(verifyHostTree(ctx)).toEqual([]);
    expect(mode(ROOT)).toEqual({ uid: 0, gid: 0, mode: 0o755 });
    expect(mode(ctx.layout.control)).toEqual({ uid: 0, gid: 0, mode: 0o700 });
    expect(mode(ctx.layout.registry)).toEqual({ uid: 0, gid: 0, mode: 0o600 });
    expect(mode(ctx.layout.hosts)).toEqual({ uid: 0, gid: gid(GROUPS.proxy), mode: 0o750 });
    expect(mode(ctx.layout.admin)).toEqual({ uid: 0, gid: gid(GROUPS.admin), mode: 0o750 });
    expect(mode(ctx.layout.branches)).toEqual({ uid: 0, gid: 0, mode: 0o711 });
  });

  let prod: BranchRow;
  let dev: BranchRow;

  test("createBranch makes a real user and tree", async () => {
    prod = await createBranch(ctx, { project: "shop", name: "prod" });
    dev = await createBranch(ctx, { project: "shop", name: "dev" });
    expect(prod.os_uid).toBeGreaterThanOrEqual(UID_BASE);
    expect(dev.os_uid).toBe(prod.os_uid + 1);
    for (const b of [prod, dev]) {
      expect(verifyBranch(ctx, b)).toEqual([]);
      const user = sys.getpwnam(`ib-${b.id}`)!;
      expect(user).toMatchObject({ uid: b.os_uid, gid: b.os_uid, home: "/nonexistent", shell: "/usr/sbin/nologin" });
      expect(sys.getgrgid(b.os_uid)!.name).toBe(`ib-${b.id}`);
      const p = ctx.layout.branch(b.id);
      expect(mode(p.dir)).toEqual({ uid: 0, gid: 0, mode: 0o711 });
      expect(mode(p.data)).toEqual({ uid: b.os_uid, gid: b.os_uid, mode: 0o700 });
      expect(mode(p.releases)).toEqual({ uid: 0, gid: b.os_uid, mode: 0o750 });
      expect(mode(p.runHttp)).toEqual({ uid: b.os_uid, gid: gid(GROUPS.proxy), mode: 0o2750 });
      expect(mode(p.runAdmin)).toEqual({ uid: b.os_uid, gid: gid(GROUPS.admin), mode: 0o2750 });
      expect(mode(p.serviceKeys)).toEqual({ uid: 0, gid: b.os_uid, mode: 0o640 });
      expect(mode(p.envFile)).toEqual({ uid: 0, gid: 0, mode: 0o600 });
      expect(readlinkSync(ctx.layout.hostLink(b.label))).toBe(`../branches/${b.id}/run/http`);
      expect(statSync(ctx.layout.hostLink(b.label)).isDirectory()).toBe(true);
      expect(readlinkSync(ctx.layout.adminLink(b.label))).toBe(`../branches/${b.id}/run/admin/admin.sock`);
    }
    expect(mode(ctx.layout.adminIndex)).toEqual({ uid: 0, gid: gid(GROUPS.admin), mode: 0o640 });
    expect(Object.keys(JSON.parse(await Bun.file(ctx.layout.adminIndex).text())).sort()).toEqual(["shop/dev", "shop/prod"]);
  });

  test("the branch user can use its data dir and nothing else", () => {
    const a = ctx.layout.branch(prod.id);
    const b = ctx.layout.branch(dev.id);
    expect(asUser(prod.os_uid, ["touch", join(a.data, "data.db")])).toBe(0);
    expect(asUser(prod.os_uid, ["mkdir", join(a.preflight, "x")])).toBe(0);
    expect(asUser(prod.os_uid, ["cat", join(a.dir, "service-keys.json")])).toBe(0);
    // Not its cwd (.env, bunfig.toml), its releases, the env file, the registry, or the other branch.
    expect(asUser(prod.os_uid, ["touch", join(a.dir, ".env")])).not.toBe(0);
    expect(asUser(prod.os_uid, ["touch", join(a.releases, "x")])).not.toBe(0);
    expect(asUser(prod.os_uid, ["cat", a.envFile])).not.toBe(0);
    expect(asUser(prod.os_uid, ["cat", ctx.layout.registry])).not.toBe(0);
    expect(asUser(prod.os_uid, ["ls", ctx.layout.branches])).not.toBe(0);
    expect(asUser(prod.os_uid, ["ls", ctx.layout.hosts])).not.toBe(0);
    expect(asUser(dev.os_uid, ["ls", a.data])).not.toBe(0);
    expect(asUser(dev.os_uid, ["cat", join(a.data, "data.db")])).not.toBe(0);
    expect(asUser(dev.os_uid, ["cat", join(a.dir, "service-keys.json")])).not.toBe(0);
    expect(asUser(dev.os_uid, ["touch", join(b.data, "data.db")])).toBe(0);
  });

  test("systemd reads the env file as rendered", async () => {
    const tricky: Record<string, string> = {
      APP_QUOTE: 'say "hi"',
      APP_BACKSLASH: "C:\\path\\n",
      APP_NEWLINE: "line1\nline2",
      APP_PADDED: "  padded  ",
      APP_DOLLAR: "$HOME ${PATH} $$",
      APP_HASH: "#not-a-comment",
      APP_UNICODE: "çay ☕",
      APP_EMPTY: "",
    };
    await ctx.registry.withLock(() => {
      for (const [name, value] of Object.entries(tricky)) ctx.registry.setEnv(dev.id, name, value, false);
    });
    expect((await renderHost(ctx)).failed).toEqual([]);
    const envFile = ctx.layout.branch(dev.id).envFile;
    const run = Bun.spawnSync(["systemd-run", "--wait", "--pipe", "--quiet", "--collect", "-p", `EnvironmentFile=${envFile}`, "/usr/bin/env", "-0"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    const seen: Record<string, string> = {};
    for (const entry of run.stdout.toString().split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) seen[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    const file = parseEnvFile(await Bun.file(envFile).text());
    for (const [name, value] of Object.entries(file)) expect([name, seen[name]]).toEqual([name, value]);
    for (const [name, value] of Object.entries(tricky)) expect([name, seen[name]]).toEqual([name, value]);
    expect(seen.INCIBASE_BRANCH_LABEL).toBe("shop/dev");
    expect(seen.INCIBASE_ADMIN_KEY).toMatch(/^ik_admin_/);
  });

  test("a crash in phase 2 is repaired by render", async () => {
    const crashing: HostContext = {
      ...ctx,
      checkpoint: (s) => {
        if (s === "env-file") throw new Error("simulated crash");
      },
    };
    await expect(createBranch(crashing, { project: "shop", name: "crash" })).rejects.toThrow("simulated crash");
    const half = ctx.registry.findBranch("shop", "crash")!;
    expect(half.phase).toBe("provisioning");
    expect(sys.getpwnam(`ib-${half.id}`)).not.toBeNull();
    expect(existsSync(ctx.layout.branch(half.id).envFile)).toBe(false);
    const report = await renderHost(ctx);
    expect(report.provisioned).toEqual([half.id]);
    expect(verifyBranch(ctx, ctx.registry.getBranch(half.id)!)).toEqual([]);
  });

  test("a file that already belongs to the next uid rolls the branch back", async () => {
    const next = Number(ctx.registry.getSetting("uid_next"));
    const stray = join(ctx.layout.trash, "stray");
    writeFileSync(stray, "");
    chownSync(stray, next, next);
    const err = await createBranch(ctx, { project: "shop", name: "stray" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionConflictError);
    expect(err.message).toContain(stray);
    rmSync(stray);
    const rolled = ctx.registry.listBranches({ phase: "deleted" }).find((b) => b.name === "stray")!;
    expect(sys.getpwuid(next)).toBeNull();
    expect(sys.getgrgid(next)).toBeNull();
    expect(existsSync(ctx.layout.branch(rolled.id).dir)).toBe(false);
    expect(existsSync(ctx.layout.hostLink(rolled.label))).toBe(false);
  });

  test("a uid that another user has is never taken over", async () => {
    const next = Number(ctx.registry.getSetting("uid_next"));
    const foreign = `${label}-foreign`;
    sys.groupadd(foreign, next);
    sys.useradd({ name: foreign, uid: next, gid: next, home: "/nonexistent", shell: "/usr/sbin/nologin", comment: "test" });
    await expect(createBranch(ctx, { project: "shop", name: "taken" })).rejects.toThrow(/already belongs to the group/);
    expect(sys.getpwuid(next)!.name).toBe(foreign);
    const next2 = await createBranch(ctx, { project: "shop", name: "taken" });
    expect(next2.os_uid).toBe(next + 1);
  });

  test("delete waits for the branch's processes, then removes user, tree and links", async () => {
    const sleeper = Bun.spawn(["setpriv", `--reuid=${dev.os_uid}`, `--regid=${dev.os_uid}`, "--clear-groups", "--", "sleep", "30"]);
    await Bun.sleep(100);
    expect(sys.processesOf(dev.os_uid)).toContain(sleeper.pid);
    await expect(deleteBranch(ctx, { project: "shop", name: "dev" })).rejects.toBeInstanceOf(BranchBusyError);
    sleeper.kill("SIGKILL");
    await sleeper.exited;
    expect((await renderHost(ctx)).deleted).toEqual([dev.id]);

    await deleteBranch(ctx, { project: "shop", name: "prod", confirm: "prod--shop.incibase.example.net" });
    for (const b of [prod, dev]) {
      expect(sys.getpwnam(`ib-${b.id}`)).toBeNull();
      expect(sys.getgrgid(b.os_uid)).toBeNull();
      expect(existsSync(ctx.layout.branch(b.id).dir)).toBe(false);
      expect(existsSync(ctx.layout.branch(b.id).envFile)).toBe(false);
      expect(existsSync(ctx.layout.hostLink(b.label))).toBe(false);
      expect(existsSync(ctx.layout.adminLink(b.label))).toBe(false);
    }
    // Production data goes to trash, still owned by the (now unused, never reused) uid.
    const [entry] = readdirSync(ctx.layout.trash).filter((n) => n.startsWith(prod.id));
    expect(mode(join(ctx.layout.trash, entry!, "data", "data.db")).uid).toBe(prod.os_uid);
    expect(mode(ctx.layout.trash).mode).toBe(0o700);
  });
});
