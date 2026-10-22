import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { s3PrefixFrom } from "../src/engine/limits.ts";
import { SimulatedCrash } from "../src/host/fake-system.ts";
import {
  BranchBusyError,
  createBranch,
  createProject,
  deleteBranch,
  ProvisionConflictError,
  provisionBranch,
  registerBranch,
  renderHost,
  verifyBranch,
  verifyHostTree,
} from "../src/host/provision.ts";
import type { BranchRow } from "../src/host/registry.ts";
import { envFileContent, quoteEnvValue } from "../src/host/render.ts";
import { closeHosts, fakeHost, parseEnvFile, type TestHost } from "./host-helpers.ts";

afterEach(closeHosts);

async function hostWithProject() {
  const host = await fakeHost();
  await createProject(host, { slug: "shop" });
  return host;
}

/** What a finished branch looks like on the machine; empty when everything is right. */
function problems(host: TestHost, branch: BranchRow): string[] {
  const out = verifyBranch(host, branch);
  const user = host.sys.getpwnam(`ib-${branch.id}`);
  if (!user || user.uid !== branch.os_uid || user.gid !== branch.os_uid) out.push(`user ${JSON.stringify(user)}`);
  if (host.sys.getgrnam(`ib-${branch.id}`)?.gid !== branch.os_uid) out.push("group");
  return out;
}

/** Nothing of a removed branch is left on the machine. */
function gone(host: TestHost, branch: BranchRow) {
  const paths = host.layout.branch(branch.id);
  expect(existsSync(paths.dir)).toBe(false);
  expect(existsSync(paths.envFile)).toBe(false);
  for (const link of host.layout.branchLinks(branch.id, branch.label)) expect(host.sys.readlink(link.path)).toBeNull();
  expect(host.sys.getpwnam(`ib-${branch.id}`)).toBeNull();
  expect(host.sys.getgrnam(`ib-${branch.id}`)).toBeNull();
  expect(JSON.parse(host.sys.readFile(host.layout.adminIndex)!)).not.toHaveProperty(`${branch.project}/${branch.name}`);
}

describe("host tree", () => {
  test("has the groups and the modes of section 6", async () => {
    const host = await fakeHost();
    expect(verifyHostTree(host)).toEqual([]);
    expect(host.sys.getgrnam("incibase-proxy")).not.toBeNull();
    expect(host.sys.getgrnam("incibase-admin")).not.toBeNull();
    // Drift is reported, and render puts it right.
    host.sys.own(host.layout.hosts, 0, 0, 0o755);
    expect(verifyHostTree(host)).toEqual([expect.stringContaining("hosts: owner 0:0"), expect.stringContaining("hosts: mode 755, expected 750")]);
    await renderHost(host);
    expect(verifyHostTree(host)).toEqual([]);
  });
});

describe("createBranch", () => {
  test("provisions user, tree, env file and links", async () => {
    const host = await hostWithProject();
    const branch = await createBranch(host, { project: "shop", name: "prod" });
    expect(branch).toMatchObject({ phase: "ready", kind: "prod", protected: 1, label: "prod--shop", os_uid: 70000, desired_state: "stopped" });
    expect(branch.id).toMatch(/^b[0-9a-z]{7}$/);
    expect(JSON.parse(branch.limits_json)).toEqual({ memoryMax: 512 * 1024 * 1024 });
    expect(problems(host, branch)).toEqual([]);

    const user = host.sys.getpwnam(`ib-${branch.id}`)!;
    expect(user).toMatchObject({ home: "/nonexistent", shell: "/usr/sbin/nologin", gecos: "incibase branch shop/prod" });

    const paths = host.layout.branch(branch.id);
    expect(host.sys.lstat(paths.data)).toMatchObject({ uid: 70000, gid: 70000, mode: 0o700 });
    expect(host.sys.lstat(paths.runHttp)).toMatchObject({ uid: 70000, gid: host.sys.getgrnam("incibase-proxy")!.gid, mode: 0o2750 });
    expect(host.sys.lstat(paths.runAdmin)).toMatchObject({ uid: 70000, gid: host.sys.getgrnam("incibase-admin")!.gid, mode: 0o2750 });
    expect(host.sys.lstat(paths.serviceKeys)).toMatchObject({ uid: 0, gid: 70000, mode: 0o640 });
    expect(JSON.parse(host.sys.readFile(paths.serviceKeys)!)).toEqual([]);
    expect(host.sys.readlink(host.layout.hostLink("prod--shop"))).toBe(`../branches/${branch.id}/run/http`);
    expect(host.sys.readlink(host.layout.adminLink("prod--shop"))).toBe(`../branches/${branch.id}/run/admin/admin.sock`);

    const index = JSON.parse(host.sys.readFile(host.layout.adminIndex)!);
    expect(index).toEqual({
      "shop/prod": { label: "prod--shop", socket: "prod--shop.sock", port: 7101, kind: "prod", url: "https://prod--shop.incibase.example.net" },
    });
    expect(host.sys.lstat(host.layout.adminIndex)).toMatchObject({ uid: 0, gid: host.sys.getgrnam("incibase-admin")!.gid, mode: 0o640 });

    const audit = host.registry.listAudit(branch.id).map((a) => a.action);
    expect(audit).toEqual(["branch.create", "branch.provisioned"]);
    expect(JSON.stringify(host.registry.listAudit())).not.toContain("ik_admin_");
  });

  test("writes the env file root-only, with fresh strong secrets", async () => {
    const host = await hostWithProject();
    const prod = await createBranch(host, { project: "shop", name: "prod" });
    const dev = await createBranch(host, { project: "shop", name: "dev" });
    expect(dev).toMatchObject({ kind: "dev", protected: 0, os_uid: 70001 });

    const envOf = (b: BranchRow) => {
      const path = host.layout.branch(b.id).envFile;
      expect(host.sys.lstat(path)).toMatchObject({ type: "file", uid: 0, gid: 0, mode: 0o600 });
      return parseEnvFile(host.sys.readFile(path)!);
    };
    const a = envOf(prod);
    const b = envOf(dev);
    expect(Object.keys(a).sort()).toEqual(
      [
        "INCIBASE_ADMIN_KEY",
        "INCIBASE_BRANCH_KIND",
        "INCIBASE_BRANCH_LABEL",
        "INCIBASE_S3_PREFIX",
        "INCIBASE_SERVICE_KEYS_FILE",
        "INCIBASE_STORAGE_SECRET",
        "TZ",
      ].sort(),
    );
    expect(a.INCIBASE_ADMIN_KEY).toMatch(/^ik_admin_[A-Za-z0-9_-]{32}$/);
    expect(a.INCIBASE_STORAGE_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.INCIBASE_ADMIN_KEY).not.toBe(b.INCIBASE_ADMIN_KEY);
    expect(a.INCIBASE_STORAGE_SECRET).not.toBe(b.INCIBASE_STORAGE_SECRET);
    expect(a.INCIBASE_BRANCH_LABEL).toBe("shop/prod");
    expect(a.INCIBASE_BRANCH_KIND).toBe("prod");
    expect(b.INCIBASE_BRANCH_KIND).toBe("dev");
    expect(a.TZ).toBe("Europe/Istanbul");
    expect(a.INCIBASE_S3_PREFIX).toBe(`shop/${prod.id}/`);
    expect(s3PrefixFrom(a.INCIBASE_S3_PREFIX)).toBe(a.INCIBASE_S3_PREFIX!);
    expect(a.INCIBASE_SERVICE_KEYS_FILE).toBe(host.layout.branch(prod.id).serviceKeys);

    // The rows are system rows; the secrets never reach the audit log.
    const rows = host.registry.listEnv(prod.id);
    expect(rows.every((r) => r.system === 1)).toBe(true);
    expect(rows.find((r) => r.name === "INCIBASE_ADMIN_KEY")!.value).toBe(a.INCIBASE_ADMIN_KEY!);
  });

  test("ids are random: the same name gets a new id after a delete", async () => {
    const host = await hostWithProject();
    const first = await createBranch(host, { project: "shop", name: "dev" });
    await deleteBranch(host, { project: "shop", name: "dev" });
    const second = await createBranch(host, { project: "shop", name: "dev" });
    expect(second.id).not.toBe(first.id);
    expect(second.s3_prefix).not.toBe(first.s3_prefix);
    expect(problems(host, second)).toEqual([]);
  });

  test("a crash before any change of phase 2 is finished by render", async () => {
    // Count the changes a clean run makes, then crash before each one in turn.
    const clean = await hostWithProject();
    const before = clean.sys.changeCount;
    await createBranch(clean, { project: "shop", name: "prod" });
    const total = clean.sys.changeCount - before;
    expect(total).toBeGreaterThan(15);

    for (let k = 0; k < total; k++) {
      const host = await hostWithProject();
      host.sys.crashAt = host.sys.changeCount + k;
      const err = await createBranch(host, { project: "shop", name: "prod" }).catch((e) => e);
      expect(err).toBeInstanceOf(SimulatedCrash);
      const [branch] = host.registry.listBranches();
      // Only admin/index.json is written after the commit.
      if (err.op === `write ${host.layout.adminIndex}`) expect(branch!.phase).toBe("ready");
      else expect(branch!.phase).toBe("provisioning");
      host.sys.crashAt = null;

      const report = await renderHost(host);
      expect(report.failed).toEqual([]);
      expect(report.rolledBack).toEqual([]);
      expect([...report.provisioned, ...report.rendered]).toEqual([branch!.id]);
      expect(JSON.parse(host.sys.readFile(host.layout.adminIndex)!)).toHaveProperty("shop/prod");
      const ready = host.registry.getBranch(branch!.id)!;
      expect(ready.phase).toBe("ready");
      expect(problems(host, ready)).toEqual([]);
      expect(parseEnvFile(host.sys.readFile(host.layout.branch(ready.id).envFile)!).INCIBASE_BRANCH_LABEL).toBe("shop/prod");
      host.close();
    }
  });

  test("a crash at every step boundary, the commit included, is finished by render", async () => {
    const steps: string[] = [];
    const clean = await hostWithProject();
    clean.checkpoint = (s) => void steps.push(s);
    await createBranch(clean, { project: "shop", name: "dev" });
    expect(steps).toEqual(["group", "user", "verify-user", "scan", "tree", "service-keys", "env-file", "links", "commit"]);

    for (const at of steps) {
      const host = await hostWithProject();
      host.checkpoint = (s) => {
        if (s === at) throw new SimulatedCrash(s);
      };
      await expect(createBranch(host, { project: "shop", name: "dev" })).rejects.toBeInstanceOf(SimulatedCrash);
      delete host.checkpoint;
      const report = await renderHost(host);
      expect(report.provisioned).toHaveLength(1);
      expect(problems(host, host.registry.getBranch(report.provisioned[0]!)!)).toEqual([]);
      host.close();
    }
  });

  test("render after a crash right after phase 1 works on a fresh process", async () => {
    const host = await hostWithProject();
    // Phase 1 alone, as if the process died before phase 2 began.
    const row = await host.registry.withLock(() => registerBranch(host, { project: "shop", name: "dev" }));
    expect(host.registry.getBranch(row.id)!.phase).toBe("provisioning");
    expect(existsSync(host.layout.branch(row.id).dir)).toBe(false);
    const ready = await provisionBranch(host, row.id);
    expect(ready.phase).toBe("ready");
    // Running it again changes nothing.
    const count = host.sys.changeCount;
    await provisionBranch(host, row.id);
    expect(host.sys.changeCount).toBe(count);
  });

  test("render on a healthy host changes nothing", async () => {
    const host = await hostWithProject();
    await createBranch(host, { project: "shop", name: "dev" });
    const count = host.sys.changeCount;
    const first = await renderHost(host);
    expect(first.rendered).toHaveLength(1);
    expect(host.sys.log.slice(count)).toEqual([]);
  });

  test("render puts back a removed link, env file and wrong modes", async () => {
    const host = await hostWithProject();
    const branch = await createBranch(host, { project: "shop", name: "dev" });
    const paths = host.layout.branch(branch.id);
    host.sys.remove(host.layout.hostLink(branch.label));
    host.sys.remove(paths.envFile);
    host.sys.own(paths.data, 0, 0, 0o755);
    expect(verifyBranch(host, branch)).toEqual([
      expect.stringContaining("data: owner 0:0"),
      expect.stringContaining("data: mode 755"),
      expect.stringContaining(".env: missing"),
      expect.stringContaining("hosts/dev--shop: points at nothing"),
    ]);
    await renderHost(host);
    expect(problems(host, branch)).toEqual([]);
  });
});

describe("conflicts roll the branch back", () => {
  test("a uid someone else took: the user is left alone, the branch is deleted, the uid stays used", async () => {
    const host = await hostWithProject();
    host.sys.groupadd("someone", 70000);
    host.sys.useradd({ name: "someone", uid: 70000, gid: 70000, home: "/home/someone", shell: "/bin/sh", comment: "" });
    const err = await createBranch(host, { project: "shop", name: "dev" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionConflictError);
    expect(err.message).toContain("gid 70000 already belongs to the group someone");
    const [branch] = host.registry.listBranches();
    expect(branch!.phase).toBe("deleted");
    gone(host, branch!);
    expect(host.sys.getpwnam("someone")).not.toBeNull();
    expect(host.sys.getgrnam("someone")).not.toBeNull();
    expect(host.registry.listAudit(branch!.id).map((a) => [a.action, a.ok])).toEqual([
      ["branch.create", 1],
      ["branch.rollback", 0],
      ["branch.deleted", 1],
    ]);
    // The next try gets the next uid.
    const next = await createBranch(host, { project: "shop", name: "dev" });
    expect(next.os_uid).toBe(70001);
  });

  test("a user with the uid but a foreign group", async () => {
    const host = await hostWithProject();
    host.sys.groupadd("users", 100);
    host.sys.useradd({ name: "other", uid: 70000, gid: 100, home: "/home/other", shell: "/bin/sh", comment: "" });
    await expect(createBranch(host, { project: "shop", name: "dev" })).rejects.toThrow(/uid 70000 already belongs to the user other/);
    expect(host.sys.getpwnam("other")).not.toBeNull();
  });

  test("files under the root that already belong to the uid", async () => {
    const host = await hostWithProject();
    const stray = join(host.layout.trash, "old", "data.db");
    mkdirSync(join(host.layout.trash, "old"));
    writeFileSync(stray, "");
    host.sys.own(stray, 70000, 70000);
    const err = await createBranch(host, { project: "shop", name: "dev" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionConflictError);
    expect(err.message).toContain(stray);
    const [branch] = host.registry.listBranches();
    expect(branch!.phase).toBe("deleted");
    gone(host, branch!);
    expect(existsSync(stray)).toBe(true);
  });

  test("a crash during the rollback is finished by render", async () => {
    const steps: string[] = [];
    const probe = await hostWithProject();
    probe.sys.groupadd("someone", 70000);
    probe.checkpoint = (s) => void steps.push(s);
    await createBranch(probe, { project: "shop", name: "dev" }).catch(() => {});
    const teardown = steps.slice(steps.indexOf("group") + 1);
    expect(teardown).toEqual(["unlink", "processes", "env-file", "tree", "user", "commit"]);

    for (const at of teardown) {
      const host = await hostWithProject();
      host.sys.groupadd("someone", 70000);
      host.checkpoint = (s) => {
        if (s === at) throw new SimulatedCrash(s);
      };
      await expect(createBranch(host, { project: "shop", name: "dev" })).rejects.toBeInstanceOf(SimulatedCrash);
      delete host.checkpoint;
      const [branch] = host.registry.listBranches();
      expect(branch!.phase).toBe("deleting");
      const report = await renderHost(host);
      expect(report.deleted).toEqual([branch!.id]);
      gone(host, host.registry.getBranch(branch!.id)!);
      host.close();
    }
  });
});

describe("deleteBranch", () => {
  test("removes everything, sends production data to trash and keeps the row", async () => {
    const host = await hostWithProject();
    const prod = await createBranch(host, { project: "shop", name: "prod" });
    const dev = await createBranch(host, { project: "shop", name: "dev" });
    writeFileSync(join(host.layout.branch(prod.id).data, "data.db"), "prod data");

    await expect(deleteBranch(host, { project: "shop", name: "prod" })).rejects.toThrow(/protected: confirm with its hostname prod--shop.incibase.example.net/);
    await deleteBranch(host, { project: "shop", name: "prod", confirm: "prod--shop.incibase.example.net" });
    await deleteBranch(host, { project: "shop", name: "dev" });

    gone(host, prod);
    gone(host, dev);
    const trash = readdirSync(host.layout.trash);
    expect(trash).toEqual([expect.stringMatching(new RegExp(`^${prod.id}-\\d+$`))]);
    expect(host.sys.readFile(join(host.layout.trash, trash[0]!, "data", "data.db"))).toBe("prod data");
    expect(host.registry.getBranch(prod.id)!.phase).toBe("deleted");
    expect(host.registry.findBranch("shop", "prod")).toBeNull();
  });

  test("refuses while the branch's processes run, and render finishes it after they stop", async () => {
    const host = await hostWithProject();
    const dev = await createBranch(host, { project: "shop", name: "dev" });
    host.sys.processes.set(dev.os_uid, [4242]);
    await expect(deleteBranch(host, { project: "shop", name: "dev" })).rejects.toBeInstanceOf(BranchBusyError);
    expect(host.registry.getBranch(dev.id)!.phase).toBe("deleting");
    expect(existsSync(host.layout.branch(dev.id).data)).toBe(true);
    host.sys.processes.clear();
    expect((await renderHost(host)).deleted).toEqual([dev.id]);
    gone(host, dev);
  });

  test("a crash before any change of the delete is finished by render", async () => {
    const clean = await hostWithProject();
    await createBranch(clean, { project: "shop", name: "dev" });
    const before = clean.sys.changeCount;
    await deleteBranch(clean, { project: "shop", name: "dev" });
    const total = clean.sys.changeCount - before;

    for (let k = 0; k < total; k++) {
      const host = await hostWithProject();
      const dev = await createBranch(host, { project: "shop", name: "dev" });
      host.sys.crashAt = host.sys.changeCount + k;
      await expect(deleteBranch(host, { project: "shop", name: "dev" })).rejects.toBeInstanceOf(SimulatedCrash);
      host.sys.crashAt = null;
      expect((await renderHost(host)).deleted).toEqual([dev.id]);
      gone(host, dev);
      host.close();
    }
  });

  test("only removes links that point at the branch", async () => {
    const host = await hostWithProject();
    const old = await createBranch(host, { project: "shop", name: "dev" });
    host.sys.processes.set(old.os_uid, [1]);
    await expect(deleteBranch(host, { project: "shop", name: "dev" })).rejects.toBeInstanceOf(BranchBusyError);
    host.sys.processes.clear();
    // Meanwhile something else took the link name.
    host.sys.symlink("../branches/bother000/run/http", host.layout.hostLink("dev--shop"));
    expect((await renderHost(host)).deleted).toEqual([old.id]);
    expect(host.sys.readlink(host.layout.hostLink("dev--shop"))).toBe("../branches/bother000/run/http");
  });
});

describe("env file rendering", () => {
  test("quotes what systemd would otherwise read differently", () => {
    expect(quoteEnvValue("plain-value_1.2:/x")).toBe("plain-value_1.2:/x");
    expect(quoteEnvValue("")).toBe("");
    expect(quoteEnvValue("has space")).toBe('"has space"');
    expect(quoteEnvValue('a "b" \\c $HOME')).toBe('"a \\"b\\" \\\\c $HOME"');
    expect(() => quoteEnvValue("a\0b")).toThrow(/NUL/);
    expect(() => envFileContent([["BAD-NAME", "x"]])).toThrow(/Invalid environment variable name/);
    const tricky = { A: 'q"uote', B: "back\\slash\\n", C: "line1\nline2", D: "  padded  ", E: "#hash", F: "ünï", G: "$X ${Y}" };
    expect(parseEnvFile(envFileContent(Object.entries(tricky)))).toEqual(tricky);
  });
});
