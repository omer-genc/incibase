// The owner operations on a real Linux machine with systemd, as root: units,
// releases of the example app bundled as an unprivileged user, both sockets,
// the preflight and the automatic revert, systemd's restarts, the sandbox and
// delete. Skipped unless INCIBASE_TEST_HOST=1 on Linux as root; needs
// INCIBASE_TEST_BINARY, a standalone incibase for this machine
// (`bun scripts/build-binary.ts`). Uses its own host root
// (INCIBASE_TEST_HOST_ROOT, default /var/lib/incibase-systemd-test), uid base
// (INCIBASE_TEST_UID_BASE, default 72000), unit prefix, groups and runtime
// root named after the root, and removes everything it created.
//
// Sandbox directives that do not take effect on the machine (a container
// may override them, see `sandboxReport`) are reported, not asserted;
// INCIBASE_TEST_REQUIRE_SANDBOX=1 (the CI VM) makes them failures.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, chownSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VERSION } from "../src/engine/version.ts";
import { openHost, type OpsContext } from "../src/host/context.ts";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { renderBranchFiles } from "../src/host/provision.ts";
import { Registry, type BranchRow } from "../src/host/registry.ts";
import { LinuxSystem } from "../src/host/system.ts";

const enabled = process.env.INCIBASE_TEST_HOST === "1" && process.platform === "linux" && process.getuid?.() === 0;
const ROOT = process.env.INCIBASE_TEST_HOST_ROOT ?? "/var/lib/incibase-systemd-test";
const UID_BASE = Number(process.env.INCIBASE_TEST_UID_BASE ?? 72000);
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
const SLOW = 240_000;

const sys = new LinuxSystem();
let ctx: OpsContext;
const lines: string[] = [];

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
  // The slice last: systemd keeps it active after its units are gone. (Its implicit parent, incibase.slice
  // for a prefix like incibase-s10, may hold other hosts' slices and is left alone.)
  for (const unit of [...units, `${prefix}.slice`]) {
    run(["systemctl", "stop", unit], { ok: [0, 1, 5] });
    run(["systemctl", "reset-failed", unit], { ok: [0, 1, 5] });
  }
  for (const dir of [LAYOUT.systemdDir, join(LAYOUT.systemdDir, "multi-user.target.wants")]) {
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
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(LAYOUT.runtimeRoot, { recursive: true, force: true });
  rmSync(APPS, { recursive: true, force: true });
}

// ---- the apps -----------------------------------------------------------------

/**
 * The example app, and variants of it, bundled as `nobody` with the
 * standalone binary: bundling runs the app's top-level code, which root never does.
 */
function bundleApp(name: string, change: (dir: string) => void = () => {}): string {
  const dir = join(APPS, name);
  cpSync(join(import.meta.dir, "..", "example"), dir, { recursive: true });
  change(join(dir, "incibase"));
  run(["chown", "-R", "nobody:nogroup", dir]);
  run(["setpriv", "--reuid=nobody", "--regid=nogroup", "--clear-groups", "--", "env", `HOME=${dir}`, join(APPS, "incibase"), "bundle", "--dir", join(dir, "incibase"), "--out", join(dir, "app.ib")]);
  return join(dir, "app.ib");
}

const edit = (file: string, from: string, to: string) => {
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`${file} has no ${from}`);
  writeFileSync(file, text.replace(from, to));
};

/** Throws on import when serving (a crash loop); bundling still works, since only serve sets INCIBASE_GENERATION. */
const CRASH_ON_START = `if (process.env.INCIBASE_GENERATION) throw new Error("boom: this release crashes on start");\nexport {};\n`;
/** Exits 300 ms after start, after its migration committed; not during a preflight (--migrate-only). */
const CRASH_AFTER_MIGRATION = `if (process.env.INCIBASE_GENERATION && !process.argv.includes("--migrate-only")) setTimeout(() => process.exit(1), 300);\nexport {};\n`;

// ---- talking to a branch --------------------------------------------------------------

const paths = (b: BranchRow) => ctx.layout.branch(b.id);
const branch = (name: string) => ctx.registry.findBranch("shop", name)!;
const unitOf = (b: BranchRow) => ctx.layout.units.branch(b.id);

async function call(socket: string, path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`http://localhost${path}`, {
    unix: socket,
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  } as RequestInit);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json: json as any };
}

const health = (b: BranchRow) => call(paths(b).adminSock, "/api/health");

function show(b: BranchRow) {
  return ctx.driver.show(unitOf(b));
}

/** Uid, gid and the effective capabilities of a process. */
function processInfo(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const field = (name: string) => new RegExp(`^${name}:\\s+(.*)$`, "m").exec(status)?.[1] ?? "";
  return { uid: Number(field("Uid").split(/\s+/)[0]), gid: Number(field("Gid").split(/\s+/)[0]), capEff: field("CapEff"), noNewPrivs: field("NoNewPrivs") };
}

function environOf(pid: number): string[] {
  return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean);
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

async function signUp(b: BranchRow, email: string) {
  const res = await call(paths(b).httpSock, "/api/auth/signup", { body: { email, password: "correct horse battery staple" } });
  expect(res.status).toBe(200);
  return res.json.token as string;
}

describe.skipIf(!enabled)("the host on systemd", () => {
  let v1 = "";

  beforeAll(async () => {
    if (ROOT === DEFAULT_ROOT) throw new Error(`Refusing to test on ${DEFAULT_ROOT}`);
    if (!BINARY || !existsSync(BINARY)) throw new Error("Set INCIBASE_TEST_BINARY to a standalone incibase for this machine (bun scripts/build-binary.ts)");
    if (existsSync(ROOT)) {
      if (!existsSync(join(ROOT, MARKER))) throw new Error(`${ROOT} exists and is not a test root; remove it or pick another INCIBASE_TEST_HOST_ROOT`);
    }
    cleanup();
    mkdirSync(ROOT, { mode: 0o755 });
    writeFileSync(join(ROOT, MARKER), "");
    mkdirSync(APPS, { mode: 0o755 });
    cpSync(BINARY, join(APPS, "incibase"));
    chmodSync(join(APPS, "incibase"), 0o755);
    ctx = openHost({ root: ROOT, layout: LAYOUT });
    ctx.actor = "root:test";
    ctx.log = (line) => {
      lines.push(line);
      console.log(`  | ${line}`);
    };
    await ops.initHost(ctx, { domain: DOMAIN, timezone: "Europe/Istanbul", uidBase: UID_BASE, sliceMemoryMax: 2 * 1024 ** 3 });
    await ops.installRuntime(ctx, { binary: BINARY, version: VERSION, sha256: new Bun.CryptoHasher("sha256").update(readFileSync(BINARY)).digest("hex") });
    v1 = bundleApp("v1");
  }, SLOW);

  afterAll(() => {
    ctx?.registry.close();
    if (enabled) cleanup();
  });

  test("the host's units are where systemd reads them, and it accepts them", async () => {
    for (const name of [`${LABEL}-branch@.service`, `${LABEL}-preflight@.service`, `${LABEL}.slice`]) {
      const st = statSync(join(LAYOUT.systemdDir, name));
      expect({ uid: st.uid, mode: st.mode & 0o777 }).toEqual({ uid: 0, mode: 0o644 });
    }
    const st = statSync(ctx.layout.runtimeBinary(VERSION));
    expect({ uid: st.uid, mode: st.mode & 0o7777 }).toEqual({ uid: 0, mode: 0o755 });
    await ops.createProject(ctx, { slug: "shop" });
    // Without a release the drop-in has no ExecStart, so systemd will not start the unit.
    const { stderr } = run(["systemd-analyze", "verify", join(LAYOUT.systemdDir, unitOf(branch("prod")))], { ok: [0, 1] });
    expect(stderr).toContain("has no ExecStart");
    expect(show(branch("prod"))).toMatchObject({ loadState: "bad-setting", activeState: "inactive" });
  }, SLOW);

  /** systemd-analyze verify on a unit; only lines about this host's units count (others on the machine may warn). */
  const verify = (unit: string) => {
    const { stderr, code } = run(["systemd-analyze", "verify", join(LAYOUT.systemdDir, unit)], { ok: [0, 1] });
    return { code, ours: stderr.split("\n").filter((l) => l.includes(LABEL)) };
  };

  test("prod and dev serve the example over their own sockets, as their own users, with distinct keys", async () => {
    const prod = (await ops.addRelease(ctx, { project: "shop", branch: "prod", file: v1 })).release;
    expect(prod).toMatchObject({ status: "live", preflight: 1, snapshot: null });
    expect(lines.join("\n")).toContain("preflight (serve --migrate-only on an empty data dir)");
    const dev = (await ops.addRelease(ctx, { project: "shop", branch: "dev", file: v1 })).release;
    expect(dev).toMatchObject({ status: "live", preflight: 0 });
    expect(verify(unitOf(branch("prod")))).toEqual({ code: 0, ours: [] });
    expect(verify(ctx.layout.units.preflight(branch("prod").id))).toEqual({ code: 0, ours: [] });

    const keys: string[] = [];
    for (const name of ["prod", "dev"]) {
      const b = branch(name);
      const status = show(b);
      expect(status).toMatchObject({ activeState: "active", subState: "running" });
      const info = processInfo(status.mainPid);
      expect({ uid: info.uid, gid: info.gid, capEff: info.capEff }).toEqual({ uid: b.os_uid, gid: b.os_uid, capEff: "0000000000000000" });
      expect(environOf(status.mainPid)).toContain(`INCIBASE_GENERATION=${b.generation}`);
      expect(readFileSync(`/proc/${status.mainPid}/cmdline`, "utf8").split("\0")).toContain(ctx.layout.releaseFile(b.id, 1));
      expect((await health(b)).json).toMatchObject({ ok: true, generation: b.generation, version: VERSION });
      expect((await call(paths(b).httpSock, "/api/health")).json).toMatchObject({ ok: true });
      // The sockets: 0770, the branch's, in the setgid dirs.
      for (const [sock, group] of [
        [paths(b).httpSock, LAYOUT.groups.proxy],
        [paths(b).adminSock, LAYOUT.groups.admin],
      ] as const) {
        const st = statSync(sock);
        expect({ uid: st.uid, gid: st.gid, mode: st.mode & 0o777 }).toEqual({ uid: b.os_uid, gid: sys.getgrnam(group)!.gid, mode: 0o770 });
      }
      keys.push((await ops.adminKey(ctx, { project: "shop", branch: name })).key);
      // Its cwd is root's: no .env or bunfig.toml can be planted.
      expect(statSync(readlinkCwd(status.mainPid)).uid).toBe(0);
    }
    const [prodKey, devKey] = keys as [string, string];
    expect(prodKey).not.toBe(devKey);
    const overview = (b: BranchRow, token: string) => call(paths(b).adminSock, "/api/admin/admin_overview", { body: {}, token });
    expect((await overview(branch("prod"), prodKey)).status).toBe(200);
    expect((await overview(branch("prod"), prodKey)).json.value.branch).toMatchObject({ label: "shop/prod", kind: "prod" });
    // Another branch's admin key is refused.
    expect([401, 403]).toContain((await overview(branch("prod"), devKey)).status);
    expect((await overview(branch("dev"), devKey)).status).toBe(200);
    // The public socket never takes the admin key.
    const publicAdmin = await call(paths(branch("prod")).httpSock, "/api/admin/admin_overview", { body: {}, token: prodKey });
    expect(publicAdmin.status).toBe(401);
    expect((await call(paths(branch("prod")).httpSock, "/api/admin/admin_overview", { body: {} })).status).toBe(404);
    expect((await call(paths(branch("prod")).httpSock, "/api/query", { body: { path: "channels:list", args: {} }, token: prodKey })).status).toBe(401);
  }, SLOW);

  test("a service key works on its branch until it is revoked; the reload is confirmed", async () => {
    const created = await ops.serviceKeyCreate(ctx, { project: "shop", branch: "dev", label: "next-server" });
    expect(created.reloaded).toBe(true);
    const bump = (token: string, b = branch("dev")) => call(paths(b).httpSock, "/api/mutation", { body: { path: "messages:bumpCount", args: { key: "svc" } }, token });
    expect((await bump(created.key)).status).toBe(200);
    // Another branch does not know the key: its internal functions stay hidden.
    expect((await bump(created.key, branch("prod"))).status).not.toBe(200);
    expect(await ops.serviceKeyRevoke(ctx, { id: created.id })).toEqual({ id: created.id, reloaded: true });
    expect((await bump(created.key)).status).not.toBe(200);
    // A reload is not a restart.
    expect((await health(branch("dev"))).json.generation).toBe(branch("dev").generation);
  }, SLOW);

  test("prod: a release whose migration is refused fails its preflight; prod keeps serving", async () => {
    const token = await signUp(branch("prod"), "owner@example.com");
    expect((await call(paths(branch("prod")).httpSock, "/api/mutation", { body: { path: "channels:create", args: { name: "general" } }, token })).status).toBe(200);
    const before = branch("prod");
    const pid = show(before).mainPid;
    const refused = bundleApp("v2-refused", (dir) => edit(join(dir, "schema.ts"), "name: z.string().min(1).max(50),", "name: z.number(),"));
    const { release } = await ops.addRelease(ctx, { project: "shop", branch: "prod", file: refused });
    expect(release).toMatchObject({ seq: 2, status: "failed", exit_code: 65 });
    expect(release.error).toMatch(/exited with 65 \(migration refused\)/);
    const snapshot = statSync(release.snapshot!);
    expect({ uid: snapshot.uid, mode: snapshot.mode & 0o777 }).toEqual({ uid: 0, mode: 0o600 });
    // The same process, generation and data.
    expect(show(before).mainPid).toBe(pid);
    expect(branch("prod")).toMatchObject({ release_seq: 1, generation: before.generation, busy_unit: null });
    expect((await call(paths(before).httpSock, "/api/query", { body: { path: "channels:list", args: {} }, token })).json.value).toHaveLength(1);
    expect(readdirSync(paths(before).preflight)).toEqual([]);
    // The snapshot left the live database's files to the branch.
    for (const name of readdirSync(paths(before).data).filter((n) => n.startsWith("data.db"))) expect(statSync(join(paths(before).data, name)).uid).toBe(before.os_uid);
  }, SLOW);

  test("dev: the same release, without a preflight, exits 65 on start and is reverted", async () => {
    const token = await signUp(branch("dev"), "dev@example.com");
    await call(paths(branch("dev")).httpSock, "/api/mutation", { body: { path: "channels:create", args: { name: "dev" } }, token });
    const { release } = await ops.addRelease(ctx, { project: "shop", branch: "dev", file: join(APPS, "v2-refused", "app.ib") });
    expect(release).toMatchObject({ status: "failed", exit_code: 65, migration_committed: 0 });
    const dev = branch("dev");
    expect(dev.release_seq).toBe(1);
    expect(dev.generation).toMatch(/^1\./);
    expect((await health(dev)).json.generation).toBe(dev.generation);
  }, SLOW);

  test("kill -9: systemd starts the branch again", async () => {
    const dev = branch("dev");
    const before = show(dev);
    process.kill(before.mainPid, "SIGKILL");
    const after = await waitFor("a new process", async () => {
      const now = show(dev);
      return now.mainPid !== before.mainPid && now.activeState === "active" && (await health(dev)).json?.generation === dev.generation ? now : null;
    });
    // systemd restarted it (Restart=on-failure), as opposed to a start of ours.
    expect(after.nRestarts).toBeGreaterThan(before.nRestarts);
  }, SLOW);

  test("a crash-looping release ends 'failed' within the start limit and is reverted", async () => {
    const crash = bundleApp("v3-crash", (dir) => writeFileSync(join(dir, "boom.ts"), CRASH_ON_START));
    const started = Date.now();
    const { release } = await ops.addRelease(ctx, { project: "shop", branch: "dev", file: crash });
    expect(release).toMatchObject({ status: "failed", exit_code: 1, migration_committed: 0 });
    expect(release.error).toMatch(/start limit/);
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(branch("dev").release_seq).toBe(1);
    expect((await health(branch("dev"))).json.generation).toBe(branch("dev").generation);
  }, SLOW);

  test("a release that commits its migration and then fails stays, with an alert; rollback --restore brings the data back", async () => {
    const committed = bundleApp("v4-commit-crash", (dir) => {
      edit(join(dir, "schema.ts"), "  stats: defineTable({", "  extra: defineTable({ x: z.string() }),\n  stats: defineTable({");
      writeFileSync(join(dir, "late.ts"), CRASH_AFTER_MIGRATION);
    });
    const { release } = await ops.addRelease(ctx, { project: "shop", branch: "prod", file: committed });
    expect(release).toMatchObject({ seq: 3, status: "failed", migration_committed: 1 });
    expect(branch("prod").release_seq).toBe(3);
    const alert = ctx.registry.listAlerts("firing").find((a) => a.key === `release:${branch("prod").id}`)!;
    expect(alert.message).toContain("incibase release rollback shop/prod --to 1 --restore pre-3");

    const result = await ops.rollback(ctx, { project: "shop", branch: "prod", to: 1, restore: "pre-3", confirm: `prod--shop.${DOMAIN}` });
    expect(result).toMatchObject({ ok: true, to: 1 });
    const prod = branch("prod");
    expect(prod).toMatchObject({ release_seq: 1, busy_unit: null });
    expect((await health(prod)).json.generation).toBe(prod.generation);
    const db = statSync(join(paths(prod).data, "data.db"));
    expect({ uid: db.uid, mode: db.mode & 0o777 }).toEqual({ uid: prod.os_uid, mode: 0o600 });
    const token = (await call(paths(prod).httpSock, "/api/auth/signin", { body: { email: "owner@example.com", password: "correct horse battery staple" } })).json.token;
    expect((await call(paths(prod).httpSock, "/api/query", { body: { path: "channels:list", args: {} }, token })).json.value.map((c: { name: string }) => c.name)).toEqual([
      "general",
    ]);
    expect(ctx.registry.listAlerts("firing")).toEqual([]);
  }, SLOW);

  test("env reaches the process at a restart; a value cannot make a second variable", async () => {
    const attack = 'a" B_INJECTED=1 #\\';
    await ops.envSet(ctx, { project: "shop", branch: "dev", vars: { APP_VALUE: attack, TABBED: "x\ty" }, restart: true });
    const env = environOf(show(branch("dev")).mainPid);
    expect(env).toContain(`APP_VALUE=${attack}`);
    expect(env).toContain("TABBED=x\ty");
    expect(env.some((e) => e.startsWith("B_INJECTED="))).toBe(false);
    // A newline only a hand-edited registry could hold stays inside its variable too.
    const dev = branch("dev");
    await ctx.registry.withLock(() => {
      ctx.registry.setEnv(dev.id, "HAND_EDITED", "line1\nC_INJECTED=1", false);
      renderBranchFiles(ctx, dev);
    });
    await ops.restart(ctx, { project: "shop", branch: "dev" });
    const after = environOf(show(branch("dev")).mainPid);
    expect(after).toContain("HAND_EDITED=line1\nC_INJECTED=1");
    expect(after.some((e) => e.startsWith("C_INJECTED="))).toBe(false);
  }, SLOW);

  test("the sandbox, as this machine applies it", async () => {
    const report = await sandboxReport(branch("dev"), branch("prod"));
    for (const line of report.lines) console.log(`  sandbox: ${line}`);
    expect(report.required).toEqual([]);
    if (REQUIRE_SANDBOX) expect(report.ineffective).toEqual([]);
  }, SLOW);

  test("delete removes units, users and directories; prod's data waits in trash", async () => {
    const prod = branch("prod");
    const dev = branch("dev");
    await expect(ops.deleteBranch(ctx, { project: "shop", branch: "prod" })).rejects.toMatchObject({ code: "CONFIRM" });
    await ops.deleteBranch(ctx, { project: "shop", branch: "prod", confirm: `prod--shop.${DOMAIN}` });
    await ops.deleteBranch(ctx, { project: "shop", branch: "dev" });
    for (const b of [prod, dev]) {
      expect(show(b).activeState).toBe("inactive");
      expect(existsSync(`${join(LAYOUT.systemdDir, unitOf(b))}.d`)).toBe(false);
      expect(existsSync(join(LAYOUT.systemdDir, `${ctx.layout.units.preflight(b.id)}.d`))).toBe(false);
      expect(existsSync(ctx.layout.wantsLink(b.id).path)).toBe(false);
      expect(sys.getpwnam(`ib-${b.id}`)).toBeNull();
      expect(sys.getgrnam(`ib-${b.id}`)).toBeNull();
      expect(sys.processesOf(b.os_uid)).toEqual([]);
      expect(existsSync(paths(b).dir)).toBe(false);
      expect(existsSync(paths(b).envFile)).toBe(false);
    }
    const trash = readdirSync(ctx.layout.trash);
    expect(trash).toEqual([expect.stringMatching(new RegExp(`^${prod.id}-\\d+$`))]);
    const kept = readdirSync(join(ctx.layout.trash, trash[0]!, "backups")).sort();
    expect(kept.filter((n) => n.startsWith("pre-"))).toEqual(["pre-2.db", "pre-3.db"]);
    expect(kept.filter((n) => n.startsWith("replaced-"))).toHaveLength(1);
    // Their uids stay used.
    const again = await ops.createBranch(ctx, { project: "shop", name: "dev" });
    expect(again.os_uid).toBeGreaterThan(Math.max(prod.os_uid, dev.os_uid));
  }, SLOW);
});

function readlinkCwd(pid: number): string {
  return readlinkSync(`/proc/${pid}/cwd`);
}

// ---- the sandbox report ---------------------------------------------------------------

interface SandboxReport {
  lines: string[];
  /** What must hold on any machine (file modes, users, the network filter). */
  required: string[];
  /** Directives that are configured but have no effect here. */
  ineffective: string[];
}

/** Mount points with their options, from a `/proc/<pid>/mountinfo`. */
function parseMounts(text: string): { point: string; options: string; fstype: string; super: string }[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [left, right] = line.split(" - ");
      const f = left!.split(" ");
      const r = right!.split(" ");
      return { point: f[4]!.replace(/\\040/g, " "), options: f[5]!, fstype: r[0]!, super: r[2] ?? "" };
    });
}

/** Who overrides a directive on this machine, if a drop-in outside incibase's does. */
function overriddenBy(unit: string, directive: string): string | null {
  const text = run(["systemctl", "cat", unit]).stdout;
  let file = "";
  let last: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("# /")) file = line.slice(2);
    else if (line.startsWith(`${directive}=`)) last = file;
  }
  return last && !last.includes(LABEL) ? last : null;
}

/**
 * Runs a probe in the branch's own sandbox: a drop-in (removed again) points
 * the unit at a script in its data dir, which tries what the sandbox should
 * stop and prints one JSON line.
 */
async function sandboxReport(b: BranchRow, other: BranchRow): Promise<SandboxReport> {
  const report: SandboxReport = { lines: [], required: [], ineffective: [] };
  const unit = unitOf(b);
  const status = show(b);
  const info = processInfo(status.mainPid);
  const otherPid = show(other).mainPid;

  const bun = join(LAYOUT.runtimeRoot, "bun");
  cpSync(process.execPath, bun);
  chmodSync(bun, 0o755);
  const script = join(paths(b).data, "probe.ts");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const out: Record<string, unknown> = {};
const tryConnect = (hostname: string, port: number) => new Promise<string>((done) => {
  const t = setTimeout(() => done("timeout"), 1500);
  Bun.connect({ hostname, port, socket: { open(s) { clearTimeout(t); s.end(); done("open"); }, data() {}, connectError(_s, e) { clearTimeout(t); done("error " + (e as Error).message); } } }).catch((e) => { clearTimeout(t); done("error " + e.message); });
});
const attempt = (fn: () => unknown) => { try { return "ok " + String(fn() ?? ""); } catch (e) { return "error " + ((e as { code?: string }).code ?? (e as Error).message); } };
out.loopback = await tryConnect("127.0.0.1", 22);
out.metadata = await tryConnect("169.254.169.254", 80);
out.listen = attempt(() => { const s = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } }); s.stop(true); return "bound"; });
out.tmp = attempt(() => fs.writeFileSync("/tmp/probe", "1"));
out.varTmp = attempt(() => fs.writeFileSync("/var/tmp/incibase-probe-${b.id}", "1"));
out.preflightDir = attempt(() => fs.writeFileSync(${JSON.stringify(join(paths(b).preflight, "probe"))}, "1"));
out.dataDir = attempt(() => fs.writeFileSync(${JSON.stringify(join(paths(b).data, "probe-write"))}, "1"));
out.cwd = attempt(() => fs.writeFileSync(".env", "X=1"));
out.control = attempt(() => fs.readdirSync(${JSON.stringify(ctx.layout.control)}));
out.envFile = attempt(() => fs.readFileSync(${JSON.stringify(paths(b).envFile)}));
out.home = attempt(() => fs.readdirSync("/home").length);
out.devices = fs.readdirSync("/dev").length;
out.otherProcess = attempt(() => fs.readFileSync("/proc/${otherPid}/cmdline", "utf8").length);
out.otherEnviron = attempt(() => fs.readFileSync("/proc/${otherPid}/environ"));
out.otherData = attempt(() => fs.readdirSync(${JSON.stringify(paths(other).data)}));
out.noNewPrivs = /^NoNewPrivs:\\s+(\\d)/m.exec(fs.readFileSync("/proc/self/status", "utf8"))?.[1];
out.mounts = fs.readFileSync("/proc/self/mountinfo", "utf8");
console.log("PROBE " + JSON.stringify(out));
`,
  );
  chownSync(script, b.os_uid, b.os_uid);
  const dropIn = join(LAYOUT.systemdDir, `${unit}.d`, "99-probe.conf");
  writeFileSync(dropIn, `[Service]\nExecStart=\nExecStart=${bun} ${script}\nRestart=no\n`);
  let probe: Record<string, string> = {};
  try {
    run(["systemctl", "daemon-reload"]);
    const cursor = ctx.driver.journalCursor();
    run(["systemctl", "restart", unit]);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const entry = ctx.driver.journal({ unit, ...(cursor ? { afterCursor: cursor } : {}) }).find((e) => e.message.startsWith("PROBE "));
      if (entry) {
        probe = JSON.parse(entry.message.slice(6));
        break;
      }
      if (Date.now() > deadline) throw new Error("the sandbox probe printed nothing");
      await Bun.sleep(250);
    }
  } finally {
    rmSync(dropIn, { force: true });
    rmSync(script, { force: true });
    rmSync(join(paths(b).data, "probe-write"), { force: true });
    rmSync(join(paths(b).preflight, "probe"), { force: true });
    rmSync(`/var/tmp/incibase-probe-${b.id}`, { force: true });
    run(["systemctl", "daemon-reload"]);
    run(["systemctl", "restart", unit]);
  }
  const mounts = parseMounts(probe.mounts ?? "");
  const mount = (point: string) => mounts.filter((m) => m.point === point).at(-1);
  report.lines.push(`probe: ${JSON.stringify({ ...probe, mounts: undefined })}`);

  const must = (name: string, ok: boolean, detail: string) => {
    report.lines.push(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
    if (!ok) report.required.push(`${name}: ${detail}`);
  };
  const directive = (name: string, effective: boolean, detail: string) => {
    if (effective) return report.lines.push(`ok   ${name}: ${detail}`);
    const by = overriddenBy(unit, name);
    report.lines.push(`NOT EFFECTIVE ${name}: ${detail}${by ? ` (overridden by ${by})` : " (not supported here)"}`);
    report.ineffective.push(name);
  };

  // Hold everywhere: users, modes, the env file, the network filter (cgroup BPF), the private /tmp.
  must("uid", info.uid === b.os_uid, `runs as ${info.uid}`);
  must("capabilities", info.capEff === "0000000000000000", `CapEff ${info.capEff}`);
  must("cwd", String(probe.cwd).startsWith("error EACCES") || String(probe.cwd).startsWith("error EROFS"), `writing .env: ${probe.cwd}`);
  must("control", String(probe.control).startsWith("error"), `reading control/: ${probe.control}`);
  must("env file", String(probe.envFile).startsWith("error"), `reading its env file: ${probe.envFile}`);
  must("other branch", String(probe.otherData).startsWith("error") && String(probe.otherEnviron).startsWith("error"), `data ${probe.otherData}, environ ${probe.otherEnviron}`);
  must("data dir", String(probe.dataDir).startsWith("ok"), `writing data/: ${probe.dataDir}`);
  must("IPAddressDeny", probe.loopback !== "open" && probe.metadata !== "open", `127.0.0.1:22 ${probe.loopback}, 169.254.169.254:80 ${probe.metadata}`);
  must("TemporaryFileSystem", mount("/tmp")?.fstype === "tmpfs" && String(probe.tmp).startsWith("ok"), `/tmp is ${mount("/tmp")?.fstype}, writing: ${probe.tmp}`);

  // Configured, but a container may switch them off.
  const root = mount("/");
  directive("ProtectSystem", String(probe.varTmp).startsWith("error EROFS") && String(probe.preflightDir).startsWith("error EROFS"), `/var/tmp: ${probe.varTmp}, preflight/: ${probe.preflightDir}, / mounted ${root?.options}`);
  directive("ReadWritePaths", String(probe.dataDir).startsWith("ok") && String(probe.preflightDir).startsWith("error EROFS"), `data/ writable, preflight/ ${probe.preflightDir}`);
  directive("ProtectHome", String(probe.home).startsWith("error") || probe.home === "ok 0", `listing /home: ${probe.home}`);
  const hostDevices = readdirSync("/dev").length;
  directive("PrivateDevices", Number(probe.devices) < hostDevices, `${probe.devices} entries in its /dev, ${hostDevices} on the host`);
  directive("ProtectProc", String(probe.otherProcess).startsWith("error"), `another branch's /proc/<pid>/cmdline: ${probe.otherProcess}`);
  directive("NoNewPrivileges", probe.noNewPrivs === "1", `NoNewPrivs ${probe.noNewPrivs}`);
  directive("SocketBindDeny", !String(probe.listen).startsWith("ok"), `listen on 0.0.0.0: ${probe.listen}`);
  return report;
}
