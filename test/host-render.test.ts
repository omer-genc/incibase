// Unit files, drop-ins, the slice and the env file as the host renders them
// (design section 5.4), and that rendering writes nothing when nothing changed.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { VERSION } from "../src/engine/version.ts";
import { HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { renderBranchFiles } from "../src/host/provision.ts";
import type { BranchRow } from "../src/host/registry.ts";
import { branchDropIn, branchTemplateUnit, envFileContent, preflightDropIn, preflightTemplateUnit, sliceUnit, snapshotDropIn, snapshotTemplateUnit } from "../src/host/render.ts";
import { closeOpsHosts, fakeBundle, fakeOpsHost, parseEnvFile } from "./host-helpers.ts";

afterEach(closeOpsHosts);

const MiB = 1024 * 1024;
const layout = new HostLayout();
const branch: BranchRow = {
  id: "b7k2m9q4",
  project: "shop",
  name: "prod",
  kind: "prod",
  protected: 1,
  label: "prod--shop",
  os_uid: 70012,
  tunnel_port: 7101,
  phase: "ready",
  desired_state: "running",
  release_seq: 7,
  runtime_version: "0.3.1",
  busy_unit: null,
  s3_prefix: "shop/b7k2m9q4/",
  limits_json: JSON.stringify({ memoryMax: 512 * MiB }),
  config_json: "{}",
  copied_from_branch_id: null,
  created_at: 0,
  updated_at: 0,
  generation: "7.0a1b2c3d4e5f",
};
const HEADER = "# Rendered by incibase from control/registry.db; changes here are overwritten.\n";
const SANDBOX = (writable: string) => `UMask=0007
TemporaryFileSystem=/tmp:size=64M,mode=1777
SocketBindDeny=any
IPAddressDeny=localhost 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 fc00::/7 fe80::/10
IPAddressAllow=127.0.0.53/32
ProtectSystem=strict
ReadWritePaths=${writable}
InaccessiblePaths=-/var/lib/incibase/control -/var/lib/incibase/trash -/var/lib/incibase/backups
InaccessiblePaths=-/var/log/nginx
ProtectHome=yes
PrivateDevices=yes
ProtectProc=invisible
NoNewPrivileges=yes
CapabilityBoundingSet=
RestrictNamespaces=yes
`;
const SERVE_TAIL =
  "--url https://prod--shop.incibase.omergenc.net --log-format json --timeouts query=10s,mutation=10s,action=120s,http=120s --drain-timeout 10s";

describe("unit files", () => {
  test("the branch template has the whole sandbox and restart policy", () => {
    expect(branchTemplateUnit(layout)).toBe(`${HEADER}[Unit]
Description=incibase branch %i
Wants=network-online.target
After=network-online.target
RequiresMountsFor=/var/lib/incibase
StartLimitIntervalSec=120
StartLimitBurst=8

[Service]
Type=exec
Slice=incibase.slice
WorkingDirectory=/var/lib/incibase/branches/%i
EnvironmentFile=/var/lib/incibase/control/env/%i.env
Environment=HOME=/nonexistent NO_COLOR=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
Restart=on-failure
RestartSec=2
RestartPreventExitStatus=64 65 78
# A reload that comes before serve has its own SIGHUP handler (runtime start and imports, about 40 ms)
# ends the process by signal; systemd would take that as a clean exit and not restart it.
RestartForceExitStatus=SIGHUP
ExecReload=/bin/kill -HUP $MAINPID
TimeoutStopSec=25
${SANDBOX("/var/lib/incibase/branches/%i/data /var/lib/incibase/branches/%i/run/http /var/lib/incibase/branches/%i/run/admin")}
[Install]
WantedBy=multi-user.target
`);
  });

  test("the preflight template: the same sandbox, only preflight/ writable", () => {
    expect(preflightTemplateUnit(layout)).toBe(`${HEADER}[Unit]
Description=incibase preflight %i
RequiresMountsFor=/var/lib/incibase

[Service]
Type=exec
Slice=incibase.slice
WorkingDirectory=/var/lib/incibase/branches/%i
EnvironmentFile=/var/lib/incibase/control/env/%i.env
Environment=HOME=/nonexistent NO_COLOR=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
RestartForceExitStatus=SIGHUP
# A migration that runs this long is stopped (Result=timeout).
RuntimeMaxSec=900
${SANDBOX("/var/lib/incibase/branches/%i/preflight")}`);
  });

  test("the snapshot template: the same sandbox, no env file, only data/ and snapshot/ writable", () => {
    expect(snapshotTemplateUnit(layout)).toBe(`${HEADER}[Unit]
Description=incibase snapshot %i
RequiresMountsFor=/var/lib/incibase

[Service]
Type=exec
Slice=incibase.slice
WorkingDirectory=/var/lib/incibase/branches/%i
Environment=HOME=/nonexistent NO_COLOR=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
# A copy that runs this long is stopped (Result=timeout).
RuntimeMaxSec=900
${SANDBOX("/var/lib/incibase/branches/%i/data /var/lib/incibase/branches/%i/snapshot")}`);
    // The control plane, the snapshots and the trash are out of its reach like a branch's.
    expect(snapshotTemplateUnit(layout)).toContain("InaccessiblePaths=-/var/lib/incibase/control -/var/lib/incibase/trash -/var/lib/incibase/backups\n");
  });

  test("the slice caps all branches together", () => {
    expect(sliceUnit(3 * 1024 * MiB)).toBe(`${HEADER}[Unit]\nDescription=incibase branches\n\n[Slice]\nMemoryMax=3G\n`);
    expect(sliceUnit(null)).toBe(`${HEADER}[Unit]\nDescription=incibase branches\n\n[Slice]\n`);
  });

  test("the branch drop-in: user, pinned runtime, release, generation and limits", () => {
    const live = { seq: 7, status: "live" as const, allow_field_removal: 0 };
    expect(branchDropIn({ layout, branch, domain: "incibase.omergenc.net", release: live })).toBe(`${HEADER}[Service]
User=ib-b7k2m9q4
Group=ib-b7k2m9q4
ExecStart=
ExecStart=/usr/local/lib/incibase/0.3.1/incibase serve --bundle /var/lib/incibase/branches/b7k2m9q4/releases/7/app.ib --data /var/lib/incibase/branches/b7k2m9q4/data --socket /var/lib/incibase/branches/b7k2m9q4/run/http/http.sock --admin-socket /var/lib/incibase/branches/b7k2m9q4/run/admin/admin.sock ${SERVE_TAIL}
Environment=INCIBASE_GENERATION=7.0a1b2c3d4e5f
MemoryMax=512M
MemoryHigh=460M
MemorySwapMax=0
CPUQuota=100%
TasksMax=256
TimeoutStopSec=25
`);
    // A dev branch's limits and settings, and --allow-field-removal until the release is live.
    const dev: BranchRow = {
      ...branch,
      kind: "dev",
      limits_json: JSON.stringify({ memoryMax: 256 * MiB, cpuQuota: 50, tasksMax: 128 }),
      config_json: JSON.stringify({ drainMs: 1000, timeouts: { query: 5000 } }),
    };
    const text = branchDropIn({ layout, branch: dev, domain: "incibase.omergenc.net", release: { seq: 8, status: "staged", allow_field_removal: 1 } });
    expect(text).toContain(" serve --allow-field-removal --bundle /var/lib/incibase/branches/b7k2m9q4/releases/8/app.ib ");
    expect(text).toContain("--timeouts query=5s,mutation=10s,action=120s,http=120s --drain-timeout 1s\n");
    expect(text).toContain("MemoryMax=256M\nMemoryHigh=230M\nMemorySwapMax=0\nCPUQuota=50%\nTasksMax=128\nTimeoutStopSec=16\n");
    expect(branchDropIn({ layout, branch: dev, domain: "incibase.omergenc.net", release: { seq: 8, status: "live", allow_field_removal: 1 } })).not.toContain(
      "--allow-field-removal",
    );
    // Without a release there is no command: the unit cannot start.
    const none = branchDropIn({ layout, branch: { ...branch, release_seq: null, generation: null }, domain: "incibase.omergenc.net", release: null });
    expect(none).not.toContain("ExecStart");
    expect(none).not.toContain("INCIBASE_GENERATION");
  });

  test("the preflight drop-in runs serve --migrate-only on preflight/", () => {
    const text = preflightDropIn({ layout, branch, domain: "incibase.omergenc.net", seq: 8, runtimeVersion: "0.3.2", allowEmpty: true, allowFieldRemoval: false });
    expect(text).toBe(`${HEADER}[Service]
User=ib-b7k2m9q4
Group=ib-b7k2m9q4
ExecStart=
ExecStart=/usr/local/lib/incibase/0.3.2/incibase serve --migrate-only --allow-empty --bundle /var/lib/incibase/branches/b7k2m9q4/releases/8/app.ib --data /var/lib/incibase/branches/b7k2m9q4/preflight --socket /var/lib/incibase/branches/b7k2m9q4/preflight/http.sock --admin-socket /var/lib/incibase/branches/b7k2m9q4/preflight/admin.sock ${SERVE_TAIL}
MemoryMax=512M
MemoryHigh=460M
MemorySwapMax=0
CPUQuota=100%
TasksMax=256
TimeoutStopSec=25
`);
  });

  test("the snapshot drop-in runs the pinned runtime's _snapshot as the branch, with its limits", () => {
    expect(snapshotDropIn(layout, branch)).toBe(`${HEADER}[Service]
User=ib-b7k2m9q4
Group=ib-b7k2m9q4
ExecStart=
ExecStart=/usr/local/lib/incibase/0.3.1/incibase _snapshot --data /var/lib/incibase/branches/b7k2m9q4/data --out /var/lib/incibase/branches/b7k2m9q4/snapshot/snapshot.db
MemoryMax=512M
MemoryHigh=460M
MemorySwapMax=0
CPUQuota=100%
TasksMax=256
TimeoutStopSec=25
`);
    expect(() => snapshotDropIn(layout, { ...branch, runtime_version: "0.3.1 --evil" })).toThrow(/Invalid runtime version/);
  });

  test("nothing that systemd would expand or split reaches a unit file", () => {
    const render = (patch: Partial<BranchRow>, domain = "incibase.omergenc.net") =>
      branchDropIn({ layout, branch: { ...branch, ...patch }, domain, release: { seq: 7, status: "live", allow_field_removal: 0 } });
    expect(() => render({ runtime_version: "0.3.1 --evil" })).toThrow(/Invalid runtime version/);
    expect(() => render({ generation: "7.$HOME" })).toThrow(/Refusing to write/);
    expect(() => render({ generation: "7.%i" })).toThrow(/Refusing to write/);
    expect(() => render({}, "evil.net --data /")).toThrow(/Invalid domain/);
    expect(() => render({ limits_json: JSON.stringify({ memoryMax: "512M\nUser=root" }) })).toThrow();
    expect(() => render({ limits_json: JSON.stringify({ memoryMax: 512 * MiB, extra: 1 }) })).toThrow();
    expect(() => render({ config_json: JSON.stringify({ drainMs: -1 }) })).toThrow();
    expect(() => new HostLayout({ root: "/var/lib/in cibase" })).toThrow();
  });

  test("unit names carry the host's prefix", () => {
    const test = new HostLayout({ root: "/var/lib/incibase-s10", unitPrefix: "incibase-s10" });
    expect(test.units.branch("b7k2m9q4")).toBe("incibase-s10-branch@b7k2m9q4.service");
    expect(test.units.preflight("b7k2m9q4")).toBe("incibase-s10-preflight@b7k2m9q4.service");
    expect(test.units.snapshot("b7k2m9q4")).toBe("incibase-s10-snapshot@b7k2m9q4.service");
    expect(test.units.job("release", "b7k2m9q4", 3)).toBe("incibase-s10-release-b7k2m9q4-3.service");
    expect(test.units.slice).toBe("incibase-s10.slice");
    expect(branchTemplateUnit(test)).toContain("Slice=incibase-s10.slice\n");
    expect(test.dropIn(test.units.branch("b7k2m9q4"))).toBe("/etc/systemd/system/incibase-s10-branch@b7k2m9q4.service.d/10-incibase.conf");
    expect(layout.units.branch("b7k2m9q4")).toBe("incibase-branch@b7k2m9q4.service");
    for (const bad of ["Incibase", "a--b", "a-", "-a", "a b", "x".repeat(33)]) expect(() => new HostLayout({ unitPrefix: bad })).toThrow(/unit prefix/);
  });
});

describe("the env file", () => {
  test("a value cannot add a variable, and a name cannot carry one", async () => {
    const attack = 'x" INCIBASE_ADMIN_KEY=evil #\\';
    const text = envFileContent([
      ["APP_VALUE", attack],
      ["INCIBASE_ADMIN_KEY", "ik_admin_real"],
    ]);
    expect(parseEnvFile(text)).toEqual({ APP_VALUE: attack, INCIBASE_ADMIN_KEY: "ik_admin_real" });
    expect(text.split("\n").filter((l) => /^[A-Z_]+=/.test(l))).toEqual(['APP_VALUE="x\\" INCIBASE_ADMIN_KEY=evil #\\\\"', "INCIBASE_ADMIN_KEY=ik_admin_real"]);
    for (const name of ["A=B", "A\nB", "A B", "1A", ""]) expect(() => envFileContent([[name, "x"]])).toThrow(/Invalid environment variable name/);

    // env set refuses what would put a second line in the file, and the host's own names.
    const host = await fakeOpsHost();
    await ops.createProject(host, { slug: "shop", branches: ["dev"] });
    const set = (vars: Record<string, string>) => ops.envSet(host, { project: "shop", branch: "dev", vars });
    for (const value of ["a\nINCIBASE_ADMIN_KEY=evil", "a\rb", "a\0b", "\u001b[31m"]) {
      await expect(set({ APP_VALUE: value })).rejects.toThrow(/must not contain newlines or other control characters/);
    }
    for (const name of ["INCIBASE_ADMIN_KEY", "INCIBASE_GENERATION", "LD_PRELOAD", "BUN_OPTIONS", "NODE_OPTIONS", "PATH", "HOME", "TZ", "A=B", "A\nB"]) {
      await expect(set({ [name]: "x" })).rejects.toMatchObject({ code: "INVALID" });
    }
    const dev = host.registry.findBranch("shop", "dev")!;
    expect(host.registry.listEnv(dev.id).filter((r) => !r.system)).toEqual([]);
    await set({ TABBED: "a\tb", QUOTED: attack });
    const env = parseEnvFile(host.sys.readFile(host.layout.branch(dev.id).envFile)!);
    expect(env).toMatchObject({ TABBED: "a\tb", QUOTED: attack });
    expect(env.INCIBASE_ADMIN_KEY).toMatch(/^ik_admin_/);
  });

  test("rendered files: derived limits next to the registry's rows", async () => {
    const host = await fakeOpsHost();
    await ops.createProject(host, { slug: "shop", branches: ["prod"] });
    await ops.setBranch(host, { project: "shop", branch: "prod", limits: { maxDbBytes: 1_000_000, maxUploadBytes: 2_000_000 } });
    await ops.envSet(host, { project: "shop", branch: "prod", vars: { STRIPE_KEY: "sk_test_1", SPACED: "two words $HOME" } });
    const prod = host.registry.findBranch("shop", "prod")!;
    const env = parseEnvFile(host.sys.readFile(host.layout.branch(prod.id).envFile)!);
    expect(env).toMatchObject({
      STRIPE_KEY: "sk_test_1",
      SPACED: "two words $HOME",
      INCIBASE_MAX_DB_BYTES: "1000000",
      INCIBASE_MAX_UPLOAD_BYTES: "2000000",
      INCIBASE_AUTH_CONCURRENCY: "4",
      INCIBASE_BRANCH_LABEL: "shop/prod",
    });
    expect(env).not.toHaveProperty("INCIBASE_GENERATION");
  });
});

describe("rendering on a host", () => {
  test("init writes the host's units; a second render writes nothing and reloads nothing", async () => {
    const host = await fakeOpsHost();
    for (const name of ["incibase-branch@.service", "incibase-preflight@.service", "incibase-snapshot@.service", "incibase.slice"]) {
      expect(host.sys.lstat(host.layout.unitFile(name))).toMatchObject({ type: "file", uid: 0, gid: 0, mode: 0o644 });
    }
    expect(readFileSync(host.layout.unitFile("incibase-snapshot@.service"), "utf8")).toBe(snapshotTemplateUnit(host.layout));
    expect(readFileSync(host.layout.unitFile("incibase-branch@.service"), "utf8")).toBe(branchTemplateUnit(host.layout));
    await ops.createProject(host, { slug: "shop" });
    await ops.addRelease(host, { project: "shop", branch: "dev", file: fakeBundle(host.dir, "v1") });

    await ops.render(host);
    const changes = host.sys.changeCount;
    const calls = host.driver.calls.length;
    const report = await ops.render(host);
    expect(report.rendered).toHaveLength(2);
    expect(report.unitsChanged).toBe(false);
    expect(host.sys.changeCount).toBe(changes);
    expect(host.driver.calls.slice(calls)).toEqual([]);
  });

  test("render puts back a removed drop-in and boot link, then reloads once", async () => {
    const host = await fakeOpsHost();
    await ops.createProject(host, { slug: "shop", branches: ["dev"] });
    const { branch } = await ops.addRelease(host, { project: "shop", branch: "dev", file: fakeBundle(host.dir, "v1") });
    const dropIn = host.layout.dropIn(host.layout.units.branch(branch.id));
    const wants = host.layout.wantsLink(branch.id);
    const before = readFileSync(dropIn, "utf8");
    expect(host.sys.readlink(wants.path)).toBe(wants.target);
    host.sys.remove(dropIn);
    host.sys.remove(wants.path);
    const calls = host.driver.calls.length;
    const report = await ops.render(host);
    expect(report.unitsChanged).toBe(true);
    expect(readFileSync(dropIn, "utf8")).toBe(before);
    expect(host.sys.readlink(wants.path)).toBe(wants.target);
    expect(host.driver.calls.slice(calls)).toEqual(["daemon-reload"]);
  });

  test("a crash while a branch's units are written is repaired by render", async () => {
    const host = await fakeOpsHost();
    await ops.createProject(host, { slug: "shop", branches: [] });
    host.checkpoint = (step) => {
      if (step === "units") throw new Error("crash at units");
    };
    await expect(ops.createBranch(host, { project: "shop", name: "dev" })).rejects.toThrow(/crash at units/);
    delete host.checkpoint;
    const [row] = host.registry.listBranches();
    expect(row!.phase).toBe("provisioning");
    await ops.render(host);
    const dev = host.registry.getBranch(row!.id)!;
    expect(dev.phase).toBe("ready");
    expect(existsSync(host.layout.dropIn(host.layout.units.branch(dev.id)))).toBe(true);
    expect(readFileSync(host.layout.dropIn(host.layout.units.branch(dev.id)), "utf8")).toContain(`User=ib-${dev.id}`);
  });

  test("a limit change re-renders the drop-in and reloads systemd, without a restart unless asked", async () => {
    const host = await fakeOpsHost();
    await ops.createProject(host, { slug: "shop", branches: ["dev"] });
    const { branch } = await ops.addRelease(host, { project: "shop", branch: "dev", file: fakeBundle(host.dir, "v1") });
    const calls = host.driver.calls.length;
    await ops.setBranch(host, { project: "shop", branch: "dev", limits: { memoryMax: 384 * MiB } });
    expect(readFileSync(host.layout.dropIn(host.layout.units.branch(branch.id)), "utf8")).toContain("MemoryMax=384M\nMemoryHigh=345M\n");
    expect(host.driver.calls.slice(calls)).toEqual(["daemon-reload"]);
    const gen = host.registry.getBranch(branch.id)!.generation;
    const { restarted } = await ops.setBranch(host, { project: "shop", branch: "dev", config: { drainMs: 2000 }, restart: true });
    expect(restarted).toMatchObject({ ok: true });
    expect(host.registry.getBranch(branch.id)!.generation).not.toBe(gen);
    expect(VERSION).toBe(host.registry.getBranch(branch.id)!.runtime_version);
  });
});
