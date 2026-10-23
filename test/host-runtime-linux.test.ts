// Runtimes on a real Linux machine with systemd, as root: a standalone
// binary installed against a SHA256SUMS made with sha256sum, a branch pinned
// to it, upgraded through the gate to a second version (the same binary
// installed under another version string), a broken runtime reverted, the
// CLI link and gc. Skipped unless INCIBASE_TEST_HOST=1 on Linux as root;
// needs INCIBASE_TEST_BINARY (`bun scripts/build-binary.ts`). Uses its own
// host root (INCIBASE_TEST_HOST_ROOT, default /var/lib/incibase-runtime-test),
// uid base (INCIBASE_TEST_UID_BASE, default 79000), and a unit prefix,
// groups, runtime root and CLI link named after the root; removes everything
// it created.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VERSION } from "../src/engine/version.ts";
import { openHost, type OpsContext } from "../src/host/context.ts";
import { DEFAULT_ROOT, HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { Registry } from "../src/host/registry.ts";
import { runtimeAsset } from "../src/host/runtime.ts";
import { LinuxSystem } from "../src/host/system.ts";

const enabled = process.env.INCIBASE_TEST_HOST === "1" && process.platform === "linux" && process.getuid?.() === 0;
const ROOT = process.env.INCIBASE_TEST_HOST_ROOT ?? "/var/lib/incibase-runtime-test";
const UID_BASE = Number(process.env.INCIBASE_TEST_UID_BASE ?? 79000);
const BINARY = process.env.INCIBASE_TEST_BINARY ?? "";
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
const SECOND = `${VERSION}-r14b`;
const BROKEN = "0.0.1-broken";
const SLOW = 300_000;

const sys = new LinuxSystem();
let ctx: OpsContext;

function run(command: string[], options: { ok?: number[]; cwd?: string } = {}) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", cwd: options.cwd });
  const code = result.exitCode ?? -1;
  if (!(options.ok ?? [0]).includes(code)) throw new Error(`${command.join(" ")} exited ${code}: ${result.stderr.toString()}${result.stdout.toString()}`);
  return { code, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

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

/** The example app bundled as `nobody`: bundling runs the app's top-level code, which root never does. */
function bundleApp(name: string): string {
  const dir = join(APPS, name);
  cpSync(join(import.meta.dir, "..", "example"), dir, { recursive: true });
  run(["chown", "-R", "nobody:nogroup", dir]);
  run(["setpriv", "--reuid=nobody", "--regid=nogroup", "--clear-groups", "--", "env", `HOME=${dir}`, join(APPS, "incibase"), "bundle", "--dir", join(dir, "incibase"), "--out", join(dir, "app.ib")]);
  return join(dir, "app.ib");
}

const dev = () => ctx.registry.findBranch("shop", "dev")!;

async function health() {
  try {
    const res = await fetch("http://localhost/api/health", { unix: ctx.layout.branch(dev().id).adminSock } as RequestInit);
    return res.ok ? ((await res.json()) as { generation?: string }) : null;
  } catch {
    return null;
  }
}

/** The binary the branch's process runs. */
function runningBinary(): string {
  const pid = ctx.driver.show(ctx.layout.units.branch(dev().id)).mainPid;
  expect(pid).toBeGreaterThan(0);
  return readlinkSync(`/proc/${pid}/exe`);
}

describe.skipIf(!enabled)("runtimes on systemd", () => {
  const dist = join(APPS, "dist");
  const asset = runtimeAsset();
  const local = join(dist, asset);

  beforeAll(async () => {
    if (ROOT === DEFAULT_ROOT) throw new Error(`Refusing to test on ${DEFAULT_ROOT}`);
    if (!BINARY || !existsSync(BINARY)) throw new Error("Set INCIBASE_TEST_BINARY to a standalone incibase for this machine (bun scripts/build-binary.ts)");
    if (existsSync(ROOT) && !existsSync(join(ROOT, MARKER))) throw new Error(`${ROOT} exists and is not a test root`);
    cleanup();
    mkdirSync(ROOT, { mode: 0o755 });
    writeFileSync(join(ROOT, MARKER), "");
    mkdirSync(join(APPS, "bin"), { recursive: true, mode: 0o755 });
    chmodSync(APPS, 0o755);
    cpSync(BINARY, join(APPS, "incibase"));
    chmodSync(join(APPS, "incibase"), 0o755);
    // A release directory as the workflow makes it.
    mkdirSync(dist);
    cpSync(BINARY, local);
    writeFileSync(join(dist, "SHA256SUMS"), run(["sha256sum", asset], { cwd: dist }).stdout);
    ctx = openHost({ root: ROOT, layout: LAYOUT });
    ctx.actor = "root:test";
    ctx.log = (line) => console.log(`  | ${line}`);
    await ops.initHost(ctx, { domain: "incibase.example.net", timezone: "UTC", uidBase: UID_BASE, sliceMemoryMax: 2 * 1024 ** 3 });
  }, SLOW);

  afterAll(() => {
    ctx?.registry.close();
    cleanup();
  });

  test("a SHA256SUMS that does not match is refused and leaves nothing", async () => {
    const wrong = join(dist, "SHA256SUMS.wrong");
    writeFileSync(wrong, `${"0".repeat(64)}  ${asset}\n`);
    await expect(ops.installRuntime(ctx, { version: VERSION, binary: local, sums: wrong })).rejects.toMatchObject({ code: "FAILED" });
    expect(existsSync(ctx.layout.runtimeDir(VERSION))).toBe(false);
    expect(ctx.registry.listRuntimes()).toEqual([]);
  }, SLOW);

  test("installs from the local file and its SHA256SUMS: root 0755, atomically, once", async () => {
    const result = await ops.installRuntime(ctx, { version: VERSION, binary: local, sums: join(dist, "SHA256SUMS") });
    expect(result).toMatchObject({ installed: true });
    for (const [path, mode] of [
      [ctx.layout.runtimeRoot, 0o755],
      [ctx.layout.runtimeDir(VERSION), 0o755],
      [ctx.layout.runtimeBinary(VERSION), 0o755],
    ] as const) {
      const st = statSync(path);
      expect({ path, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 }).toEqual({ path, uid: 0, gid: 0, mode });
    }
    expect(readdirSync(ctx.layout.runtimeDir(VERSION))).toEqual(["incibase"]);
    expect(run([ctx.layout.runtimeBinary(VERSION), "--version"]).stdout.trim()).toBe(VERSION);
    const ino = statSync(ctx.layout.runtimeBinary(VERSION)).ino;
    expect(await ops.installRuntime(ctx, { version: VERSION, binary: local, sums: join(dist, "SHA256SUMS") })).toMatchObject({ installed: false });
    expect(statSync(ctx.layout.runtimeBinary(VERSION)).ino).toBe(ino);
    // The same build under a second version string: only with the version check skipped.
    const sha256 = result.sha256;
    await expect(ops.installRuntime(ctx, { version: SECOND, binary: local, sha256 })).rejects.toThrow(/says it is/);
    expect(existsSync(ctx.layout.runtimeDir(SECOND))).toBe(false);
    expect(await ops.installRuntime(ctx, { version: SECOND, binary: local, sha256, skipVersionCheck: true })).toMatchObject({ installed: true });
  }, SLOW);

  test("the CLI link runs the installed runtime", async () => {
    await ops.useCli(ctx, { version: VERSION });
    expect(readlinkSync(LAYOUT.cliLink)).toBe(ctx.layout.runtimeBinary(VERSION));
    expect(run([LAYOUT.cliLink, "--version"]).stdout.trim()).toBe(VERSION);
  }, SLOW);

  test("a pinned branch upgrades through the gate; a broken runtime is reverted", async () => {
    await ops.createProject(ctx, { slug: "shop", branches: ["dev"] });
    expect(dev().runtime_version).toBe(VERSION);
    const added = await ops.addRelease(ctx, { project: "shop", branch: "dev", file: bundleApp("v1") });
    expect(added.release.status).toBe("live");
    expect(runningBinary()).toBe(ctx.layout.runtimeBinary(VERSION));

    await expect(ops.upgradeBranch(ctx, { project: "shop", branch: "dev", runtimeVersion: "9.9.9" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const up = await ops.upgradeBranch(ctx, { project: "shop", branch: "dev", runtimeVersion: SECOND });
    expect(up.ok).toBe(true);
    expect(dev().runtime_version).toBe(SECOND);
    expect(runningBinary()).toBe(ctx.layout.runtimeBinary(SECOND));
    expect((await health())?.generation).toBe(dev().generation!);
    expect(readFileSync(ctx.layout.dropIn(ctx.layout.units.branch(dev().id)), "utf8")).toContain(`${ctx.layout.runtimeBinary(SECOND)} serve`);

    // A runtime that answers --version but cannot serve: the gate fails and the pin goes back.
    const broken = join(APPS, "broken");
    const text = `#!/bin/sh\nif [ "$1" = --version ]; then echo ${BROKEN}; exit 0; fi\necho "broken runtime" >&2\nexit 1\n`;
    writeFileSync(broken, text, { mode: 0o755 });
    await ops.installRuntime(ctx, { version: BROKEN, binary: broken, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") });
    const down = await ops.upgradeBranch(ctx, { project: "shop", branch: "dev", runtimeVersion: BROKEN });
    expect(down.ok).toBe(false);
    expect(dev().runtime_version).toBe(SECOND);
    expect(runningBinary()).toBe(ctx.layout.runtimeBinary(SECOND));
    expect((await health())?.generation).toBe(dev().generation!);
  }, SLOW);

  test("gc removes what no branch pins, keeping the CLI's runtime", async () => {
    const first = await ops.gcRuntimes(ctx);
    expect(first.removed).toEqual([BROKEN]);
    expect(first.kept.map((k) => k.version).sort()).toEqual([SECOND, VERSION].sort());
    expect(existsSync(ctx.layout.runtimeDir(BROKEN))).toBe(false);
    await ops.useCli(ctx, { version: SECOND });
    expect((await ops.gc(ctx)).runtimes.removed).toEqual([VERSION]);
    expect(existsSync(ctx.layout.runtimeDir(VERSION))).toBe(false);
    expect(readdirSync(ctx.layout.runtimeRoot)).toEqual([SECOND]);
    // The branch runs on, on its pinned runtime.
    expect(runningBinary()).toBe(ctx.layout.runtimeBinary(SECOND));
    expect((await health())?.generation).toBe(dev().generation!);
  }, SLOW);
});
