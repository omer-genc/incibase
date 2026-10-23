// The owner operations (design section 5.2) on a fake host: input
// validation, control/LOCK, busy branches, audit rows, start/stop/restart,
// delete, env, keys, status and logs.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/host/ops.ts";
import { Registry, RegistryLockedError, type BranchRow } from "../src/host/registry.ts";
import { closeOpsHosts, fakeBundle, fakeOpsHost, parseEnvFile, seedDatabase, type OpsTestHost } from "./host-helpers.ts";

afterEach(closeOpsHosts);

const HOSTNAME = "prod--shop.incibase.example.net";

async function shop(branches = ["prod", "dev"]) {
  const host = await fakeOpsHost();
  await ops.createProject(host, { slug: "shop", branches });
  return host;
}

const branchOf = (host: OpsTestHost, name: string) => host.registry.findBranch("shop", name)!;
const audit = (host: OpsTestHost, b?: BranchRow) => host.registry.listAudit(b?.id).map((a) => [a.action, a.ok] as const);

describe("input", () => {
  test("is checked before anything happens", async () => {
    const host = await shop([]);
    const cases: [Promise<unknown>, RegExp][] = [
      [ops.createProject(host, { slug: "Shop" }), /Project name "Shop" must be lowercase/],
      [ops.createProject(host, { slug: "admin" }), /reserved/],
      [ops.createProject(host, { slug: "a--b" }), /single hyphens/],
      [ops.createBranch(host, { project: "shop", name: "x".repeat(21) }), /1 to 20 characters/],
      [ops.createBranch(host, { project: "shop", name: "dev", kind: "staging" as never }), /kind/],
      [ops.createBranch(host, { project: "shop", name: "dev", runtimeVersion: "../../bin" }), /Invalid runtime version/],
      [ops.setBranch(host, { project: "shop", branch: "dev", limits: { memoryMax: 1 } }), /memoryMax/],
      [ops.setBranch(host, { project: "shop", branch: "dev", extra: true } as never), /Unrecognized key/],
      [ops.addRelease(host, { project: "shop", branch: "dev" } as never), /file/],
      [ops.rollback(host, { project: "shop", branch: "dev", restore: "../../etc/passwd" }), /must name a snapshot/],
      [ops.serviceKeyCreate(host, { project: "shop", branch: "dev", label: "a\nb" }), /control characters/],
      [ops.serviceKeyCreate(host, { project: "shop", branch: "dev", label: "x", scopes: ["root" as never] }), /scopes/],
      [ops.serviceKeyRevoke(host, { id: "k_bad" }), /service key id/],
      [ops.logs(host, { project: "shop", branch: "dev", since: "1h; rm -rf /" }), /since/],
      [ops.initHost(host, { domain: "Example.COM" }), /Invalid domain/],
    ];
    for (const [promise, message] of cases) {
      const err = await promise.then(() => null, (e) => e);
      expect(err).toBeInstanceOf(ops.OpError);
      expect(err.code).toBe("INVALID");
      expect(err.message).toMatch(message);
    }
    // Bad input is not an attempt worth an audit row.
    expect(audit(host).filter(([, ok]) => !ok)).toEqual([]);
    await expect(ops.createBranch(host, { project: "nope", name: "dev" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ops.envList(host, { project: "shop", branch: "dev" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("control/LOCK", () => {
  test("an op waits for another command's lock, then gives up without changing anything", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    const other = Registry.open(host.layout);
    let release!: () => void;
    const held = other.withLock(() => new Promise<void>((resolve) => (release = resolve)));
    await Bun.sleep(20);
    const started = performance.now();
    await expect(ops.envSet(host, { project: "shop", branch: "dev", vars: { A: "1" } })).rejects.toBeInstanceOf(RegistryLockedError);
    expect(performance.now() - started).toBeGreaterThanOrEqual(400);
    expect(host.registry.getEnv(dev.id, "A")).toBeNull();
    // A lock timeout is not audited (writing the row would need the lock).
    expect(audit(host, dev).filter(([a]) => a === "env.set")).toEqual([]);
    release();
    await held;
    await ops.envSet(host, { project: "shop", branch: "dev", vars: { A: "1" } });
    expect(host.registry.getEnv(dev.id, "A")!.value).toBe("1");
    other.close();
  });
});

describe("a busy branch", () => {
  test("refuses every change and audits the refusal; reads still work", async () => {
    const host = await shop(["prod", "dev"]);
    const dev = branchOf(host, "dev");
    await ops.addRelease(host, { project: "shop", branch: "dev", file: fakeBundle(host.dir, "v1") });
    await host.registry.withLock(() => host.registry.claimBusy(dev.id, "incibase-release-x.service", 1));
    const t = { project: "shop", branch: "dev" };
    const refused: (() => Promise<unknown>)[] = [
      () => ops.setBranch(host, { ...t, limits: { tasksMax: 100 } }),
      () => ops.start(host, t),
      () => ops.stop(host, t),
      () => ops.restart(host, t),
      () => ops.deleteBranch(host, t),
      () => ops.addRelease(host, { ...t, file: fakeBundle(host.dir, "v2") }),
      () => ops.rollback(host, t),
      () => ops.envSet(host, { ...t, vars: { A: "1" } }),
      () => ops.envUnset(host, { ...t, names: ["A"] }),
      () => ops.adminKey(host, { ...t, rotate: true }),
      () => ops.serviceKeyCreate(host, { ...t, label: "next" }),
    ];
    for (const op of refused) await expect(op()).rejects.toMatchObject({ code: "BUSY" });
    const failures = audit(host, dev).filter(([, ok]) => !ok).map(([a]) => a);
    expect(failures).toEqual([
      "branch.set",
      "branch.start",
      "branch.stop",
      "branch.restart",
      "branch.delete",
      "release.add",
      "release.rollback",
      "env.set",
      "env.unset",
      "admin_key.rotate",
      "service_key.create",
    ]);
    expect(JSON.parse(host.registry.listAudit(dev.id).find((a) => a.action === "env.set")!.detail_json!).error).toMatch(/busy/);
    // Reads, and other branches, are fine.
    expect((await ops.status(host, t)).branches[0]!.busy).toBe("incibase-release-x.service");
    expect(await ops.envList(host, t)).toBeArray();
    await ops.envSet(host, { project: "shop", branch: "prod", vars: { A: "1" } });
  });
});

describe("audit", () => {
  test("every change leaves a row, and no secret reaches the log", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    const t = { project: "shop", branch: "dev" };
    await ops.addRelease(host, { ...t, file: fakeBundle(host.dir, "v1") });
    await ops.envSet(host, { ...t, vars: { STRIPE_KEY: "sk_live_secret" } });
    await ops.envUnset(host, { ...t, names: ["STRIPE_KEY"] });
    const { key } = await ops.adminKey(host, t);
    const rotated = await ops.adminKey(host, { ...t, rotate: true });
    const created = await ops.serviceKeyCreate(host, { ...t, label: "next" });
    await ops.serviceKeyRevoke(host, { id: created.id });
    await ops.restart(host, t);
    await ops.stop(host, t);
    await ops.start(host, t);
    expect(audit(host, dev).map(([a]) => a)).toEqual([
      "branch.create",
      "branch.provisioned",
      "release.add",
      "release.live",
      "env.set",
      "env.unset",
      "admin_key.read",
      "admin_key.rotate",
      "service_key.create",
      "service_key.revoke",
      "branch.restart",
      "branch.stop",
      "branch.start",
    ]);
    expect(audit(host, dev).every(([, ok]) => ok === 1)).toBe(true);
    const all = JSON.stringify(host.registry.listAudit());
    for (const secret of ["sk_live_secret", key, rotated.key, created.key]) expect(all).not.toContain(secret);
    expect(host.registry.listAudit(dev.id).every((a) => a.actor === "root:test")).toBe(true);
  });
});

describe("start, stop, restart", () => {
  test("follow the desired state: boot link, unit, new generation and gate", async () => {
    const host = await shop(["prod", "dev"]);
    const dev = branchOf(host, "dev");
    const t = { project: "shop", branch: "dev" };
    await expect(ops.start(host, t)).rejects.toThrow(/no release to run/);
    await ops.addRelease(host, { ...t, file: fakeBundle(host.dir, "v1") });
    const unit = host.layout.units.branch(dev.id);
    const wants = host.layout.wantsLink(dev.id).path;

    await ops.stop(host, t);
    expect(branchOf(host, "dev").desired_state).toBe("stopped");
    expect(host.driver.isActive(unit)).toBe(false);
    expect(host.sys.readlink(wants)).toBeNull();

    const started = await ops.start(host, t);
    expect(started.gate).toMatchObject({ ok: true });
    expect(host.driver.isActive(unit)).toBe(true);
    expect(host.sys.readlink(wants)).not.toBeNull();

    const before = branchOf(host, "dev").generation;
    const restarted = await ops.restart(host, t);
    expect(restarted.gate).toMatchObject({ ok: true });
    expect(restarted.branch.generation).not.toBe(before);
    expect(readFileSync(host.layout.dropIn(unit), "utf8")).toContain(`INCIBASE_GENERATION=${restarted.branch.generation}`);

    // A restart that does not come back is reported, not hidden.
    host.driver.behavior = () => ({ hang: true });
    expect((await ops.restart(host, t)).gate).toMatchObject({ ok: false, reason: "timeout" });
    expect(audit(host, dev).at(-1)).toEqual(["branch.restart", 0]);
  });

  test("stopping a protected branch needs its hostname", async () => {
    const host = await shop(["prod"]);
    await ops.addRelease(host, { project: "shop", branch: "prod", file: fakeBundle(host.dir, "v1") });
    await expect(ops.stop(host, { project: "shop", branch: "prod" })).rejects.toMatchObject({ code: "CONFIRM" });
    await expect(ops.stop(host, { project: "shop", branch: "prod", confirm: "prod--shop" })).rejects.toThrow(HOSTNAME);
    await ops.stop(host, { project: "shop", branch: "prod", confirm: HOSTNAME });
    expect(branchOf(host, "prod").desired_state).toBe("stopped");
    // Unprotecting needs it too.
    await expect(ops.setBranch(host, { project: "shop", branch: "prod", protected: false })).rejects.toMatchObject({ code: "CONFIRM" });
    await ops.setBranch(host, { project: "shop", branch: "prod", protected: false, confirm: HOSTNAME });
    expect(branchOf(host, "prod").protected).toBe(0);
  });
});

describe("deleteBranch", () => {
  test("prod: refused without its hostname; then units stopped and removed, data and snapshots in trash", async () => {
    const host = await shop(["prod", "dev"]);
    const prod = branchOf(host, "prod");
    seedDatabase(host, prod);
    await ops.addRelease(host, { project: "shop", branch: "prod", file: fakeBundle(host.dir, "v1") });
    expect(readdirSync(host.layout.branch(prod.id).backups)).toEqual(["pre-1.db"]);
    await expect(ops.deleteBranch(host, { project: "shop", branch: "prod" })).rejects.toMatchObject({ code: "CONFIRM" });
    expect(audit(host, prod).at(-1)).toEqual(["branch.delete", 0]);
    expect(branchOf(host, "prod").phase).toBe("ready");

    const calls = host.driver.calls.length;
    await ops.deleteBranch(host, { project: "shop", branch: "prod", confirm: HOSTNAME });
    const unit = host.layout.units.branch(prod.id);
    expect(host.driver.calls.slice(calls)).toEqual([
      `stop ${unit}`,
      `reset-failed ${unit}`,
      `stop ${host.layout.units.preflight(prod.id)}`,
      `reset-failed ${host.layout.units.preflight(prod.id)}`,
      "daemon-reload",
    ]);
    expect(existsSync(`${host.layout.dropIn(unit)}`)).toBe(false);
    expect(existsSync(host.layout.wantsLink(prod.id).path)).toBe(false);
    expect(existsSync(host.layout.branch(prod.id).dir)).toBe(false);
    expect(existsSync(host.layout.branch(prod.id).backups)).toBe(false);
    const [entry, ...rest] = readdirSync(host.layout.trash);
    expect(rest).toEqual([]);
    expect(entry).toMatch(new RegExp(`^${prod.id}-\\d+$`));
    expect(readdirSync(join(host.layout.trash, entry!, "data"))).toContain("data.db");
    expect(readdirSync(join(host.layout.trash, entry!, "backups"))).toEqual(["pre-1.db"]);
    expect(host.sys.getpwnam(`ib-${prod.id}`)).toBeNull();
    expect(host.registry.getBranch(prod.id)!.phase).toBe("deleted");
  });

  test("an unprotected production branch still needs its hostname to be deleted", async () => {
    const host = await shop(["prod"]);
    await ops.setBranch(host, { project: "shop", branch: "prod", protected: false, confirm: HOSTNAME });
    await expect(ops.deleteBranch(host, { project: "shop", branch: "prod" })).rejects.toThrow(/is a production branch: to delete it, confirm with its hostname/);
    // Stopping it does not.
    await ops.stop(host, { project: "shop", branch: "prod" });
    await ops.deleteBranch(host, { project: "shop", branch: "prod", confirm: HOSTNAME });
  });

  test("dev: no confirmation, nothing kept; a new branch of the same name gets a new uid", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await ops.addRelease(host, { project: "shop", branch: "dev", file: fakeBundle(host.dir, "v1") });
    await ops.deleteBranch(host, { project: "shop", branch: "dev" });
    expect(readdirSync(host.layout.trash)).toEqual([]);
    expect(existsSync(host.layout.branch(dev.id).dir)).toBe(false);
    const again = await ops.createBranch(host, { project: "shop", name: "dev" });
    expect(again.os_uid).toBe(dev.os_uid + 1);
    expect(again.id).not.toBe(dev.id);
  });

  test("gcTrash removes trash older than 7 days only", async () => {
    const host = await shop([]);
    const old = `b0000000-${host.now!() - 8 * 86_400_000}`;
    const fresh = `b1111111-${host.now!() - 86_400_000}`;
    for (const name of [old, fresh, "not-ours"]) mkdirSync(join(host.layout.trash, name));
    expect(await ops.gcTrash(host)).toEqual({ removed: [old] });
    expect(readdirSync(host.layout.trash).sort()).toEqual([fresh, "not-ours"].sort());
  });
});

describe("env", () => {
  test("set, list (masked unless shown), unset; host rows are untouchable; restart on request", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    const t = { project: "shop", branch: "dev" };
    await ops.addRelease(host, { ...t, file: fakeBundle(host.dir, "v1") });
    const calls = host.driver.calls.length;
    await ops.envSet(host, { ...t, vars: { STRIPE_KEY: "sk_1", S3_BUCKET: "b" } });
    // Without restart: the env file changes, the process does not.
    expect(host.driver.calls.slice(calls)).toEqual([]);
    expect(parseEnvFile(host.sys.readFile(host.layout.branch(dev.id).envFile)!).STRIPE_KEY).toBe("sk_1");
    const masked = await ops.envList(host, t);
    expect(masked.find((r) => r.name === "STRIPE_KEY")).toEqual({ name: "STRIPE_KEY", system: false });
    expect(masked.find((r) => r.name === "INCIBASE_ADMIN_KEY")).toEqual({ name: "INCIBASE_ADMIN_KEY", system: true });
    expect((await ops.envList(host, { ...t, show: true })).find((r) => r.name === "STRIPE_KEY")).toMatchObject({ value: "sk_1" });
    expect(audit(host, dev).at(-1)).toEqual(["env.show", 1]);

    const { restarted } = await ops.envSet(host, { ...t, vars: { STRIPE_KEY: "sk_2" }, restart: true });
    expect(restarted).toMatchObject({ ok: true });
    expect(await ops.envUnset(host, { ...t, names: ["STRIPE_KEY", "MISSING"] })).toMatchObject({ removed: ["STRIPE_KEY"] });
    await expect(ops.envUnset(host, { ...t, names: ["INCIBASE_ADMIN_KEY"] })).rejects.toMatchObject({ code: "INVALID" });
    expect(host.registry.getEnv(dev.id, "INCIBASE_ADMIN_KEY")).not.toBeNull();
  });

  test("another branch's S3 access key needs sharedS3Credentials", async () => {
    const host = await shop(["prod", "dev"]);
    await ops.envSet(host, { project: "shop", branch: "prod", vars: { S3_ACCESS_KEY_ID: "AKIA1" } });
    await expect(ops.envSet(host, { project: "shop", branch: "dev", vars: { S3_ACCESS_KEY_ID: "AKIA1" } })).rejects.toThrow(/Another branch uses this S3_ACCESS_KEY_ID/);
    await ops.envSet(host, { project: "shop", branch: "dev", vars: { S3_ACCESS_KEY_ID: "AKIA1" }, sharedS3Credentials: true });
  });
});

describe("keys", () => {
  test("the admin key: read, and rotate (env file, restart with a new generation)", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    const t = { project: "shop", branch: "dev" };
    await ops.addRelease(host, { ...t, file: fakeBundle(host.dir, "v1") });
    const { key } = await ops.adminKey(host, t);
    expect(key).toBe(parseEnvFile(host.sys.readFile(host.layout.branch(dev.id).envFile)!).INCIBASE_ADMIN_KEY!);
    const generation = branchOf(host, "dev").generation;
    const rotated = await ops.adminKey(host, { ...t, rotate: true });
    expect(rotated.key).toMatch(/^ik_admin_[A-Za-z0-9_-]{32}$/);
    expect(rotated.key).not.toBe(key);
    expect(rotated.restarted).toMatchObject({ ok: true });
    expect(parseEnvFile(host.sys.readFile(host.layout.branch(dev.id).envFile)!).INCIBASE_ADMIN_KEY).toBe(rotated.key);
    expect(branchOf(host, "dev").generation).not.toBe(generation);
  });

  test("service keys: only the sha256 is kept; create and revoke re-render the file and reload the branch", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    const t = { project: "shop", branch: "dev" };
    const file = host.layout.branch(dev.id).serviceKeys;
    // Not running: nothing to reload; serve reads the file when it starts.
    const early = await ops.serviceKeyCreate(host, { ...t, label: "early" });
    expect(early.reloaded).toBeNull();
    await ops.addRelease(host, { ...t, file: fakeBundle(host.dir, "v1") });

    const unit = host.layout.units.branch(dev.id);
    let calls = host.driver.calls.length;
    const created = await ops.serviceKeyCreate(host, { ...t, label: "next-server", scopes: ["internal", "impersonate"] });
    expect(created.key).toMatch(new RegExp(`^ik_svc_${created.id}_[A-Za-z0-9_-]{43}$`));
    expect(created.reloaded).toBe(true);
    expect(host.driver.calls.slice(calls)).toEqual([`reload ${unit}`]);
    const sha = new Bun.CryptoHasher("sha256").update(created.key).digest("hex");
    expect(host.registry.getServiceKey(created.id)!.sha256).toBe(sha);
    expect(JSON.stringify(host.registry.db.query("SELECT * FROM service_keys").all())).not.toContain(created.key);
    expect(host.sys.lstat(file)).toMatchObject({ uid: 0, gid: dev.os_uid, mode: 0o640 });
    const listed = JSON.parse(readFileSync(file, "utf8"));
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        { id: early.id, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), scopes: ["internal"], label: "early" },
        { id: created.id, sha256: sha, scopes: ["internal", "impersonate"], label: "next-server" },
      ]),
    );
    expect((await ops.serviceKeyList(host, t)).map((k) => [k.id, k.revoked_at]).sort()).toEqual(
      [
        [early.id, null],
        [created.id, null],
      ].sort(),
    );

    calls = host.driver.calls.length;
    expect(await ops.serviceKeyRevoke(host, { id: created.id })).toEqual({ id: created.id, reloaded: true });
    expect(host.driver.calls.slice(calls)).toEqual([`reload ${unit}`]);
    expect(JSON.parse(readFileSync(file, "utf8")).map((k: { id: string }) => k.id)).toEqual([early.id]);
    expect(host.registry.getServiceKey(created.id)!.revoked_at).not.toBeNull();
    await expect(ops.serviceKeyRevoke(host, { id: created.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(ops.serviceKeyRevoke(host, { id: "k000000000" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("status and logs", () => {
  test("status puts the registry's desired state next to systemd's", async () => {
    const host = await shop(["prod", "dev"]);
    await ops.addRelease(host, { project: "shop", branch: "dev", file: fakeBundle(host.dir, "v1") });
    const { branches, alerts } = await ops.status(host);
    expect(alerts).toEqual([]);
    expect(branches.map((b) => [b.ref, b.desired, b.release, b.releaseStatus, b.actual.activeState])).toEqual([
      ["shop/dev", "running", 1, "live", "active"],
      ["shop/prod", "stopped", null, null, "inactive"],
    ]);
    expect(branches[0]).toMatchObject({ url: "https://dev--shop.incibase.example.net", kind: "dev", limits: { memoryMax: 256 * 1024 * 1024, tasksMax: 256 } });
    expect((await ops.status(host, { project: "shop", branch: "prod" })).branches).toHaveLength(1);
    await expect(ops.status(host, { project: "shop", branch: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("logs gives the journalctl command for the branch's unit", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    expect((await ops.logs(host, { project: "shop", branch: "dev", follow: true })).command).toEqual([
      "journalctl",
      "--unit",
      `incibase-branch@${dev.id}.service`,
      "--follow",
    ]);
  });

  test("createProject makes prod and dev by default; prod is protected with 512M, dev 256M", async () => {
    const host = await fakeOpsHost();
    const { branches } = await ops.createProject(host, { slug: "shop", name: "Shop" });
    expect(branches.map((b) => [b.name, b.kind, b.protected, JSON.parse(b.limits_json).memoryMax / 1024 / 1024])).toEqual([
      ["prod", "prod", 1, 512],
      ["dev", "dev", 0, 256],
    ]);
    await expect(ops.createProject(host, { slug: "shop" })).rejects.toMatchObject({ code: "CONFLICT" });
    writeFileSync(join(host.dir, "unused"), "");
  });
});
