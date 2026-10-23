import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { HostLayout } from "../src/host/layout.ts";
import { createBranch, createProject, deleteBranch } from "../src/host/provision.ts";
import { currentActor, Registry, REGISTRY_VERSION, RegistryError, RegistryLockedError, UID_LIMIT } from "../src/host/registry.ts";
import { tempDir } from "./helpers.ts";
import { closeHosts, fakeHost } from "./host-helpers.ts";

const dirs: string[] = [];
const open: Registry[] = [];

function registryAt(root = join(dirOf(), "root")) {
  const registry = Registry.open(new HostLayout({ root }));
  open.push(registry);
  return registry;
}

function dirOf() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const r of open.splice(0)) r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  closeHosts();
});

describe("registry database", () => {
  test("is created root-only, in WAL mode, at the current version, with the design's tables", () => {
    const registry = registryAt();
    expect(registry.version).toBe(REGISTRY_VERSION);
    expect(statSync(registry.layout.registry).mode & 0o777).toBe(0o600);
    expect(statSync(registry.layout.control).mode & 0o777).toBe(0o700);
    expect((registry.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    const tables = (registry.db.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(["alerts", "audit_log", "branches", "env", "projects", "releases", "runtimes", "service_keys", "settings"]);
    const columns = (registry.db.query(`PRAGMA table_info(branches)`).all() as { name: string }[]).map((r) => r.name);
    for (const c of ["phase", "desired_state", "release_seq", "runtime_version", "busy_unit", "s3_prefix", "limits_json", "config_json", "os_uid", "tunnel_port", "label"]) {
      expect(columns).toContain(c);
    }
  });

  test("migrations are idempotent and keep the data", () => {
    const root = join(dirOf(), "root");
    const first = registryAt(root);
    first.db.run(`INSERT INTO settings (key, value) VALUES ('domain', 'a.example.net')`);
    first.close();
    open.splice(0);
    const again = registryAt(root);
    expect(again.version).toBe(REGISTRY_VERSION);
    expect(again.getSetting("domain")).toBe("a.example.net");
    again.close();
    open.splice(0);
    expect(registryAt(root).version).toBe(REGISTRY_VERSION);
  });

  test("refuses a registry a newer incibase migrated", () => {
    const root = join(dirOf(), "root");
    registryAt(root).close();
    open.splice(0);
    const db = new Database(join(root, "control", "registry.db"));
    db.run(`PRAGMA user_version = ${REGISTRY_VERSION + 1}`);
    db.close();
    expect(() => Registry.open(new HostLayout({ root }))).toThrow(/newer incibase/);
  });

  test("changes need control/LOCK", async () => {
    const registry = registryAt();
    expect(() => registry.initSettings()).toThrow(RegistryError);
    await registry.withLock(() => registry.initSettings({ uidBase: 71000 }));
    expect(registry.getSetting("uid_next")).toBe("71000");
    expect(registry.locked).toBe(false);
  });

  test("init settings keep what is already set; counters cannot be set by hand", async () => {
    const registry = registryAt();
    await registry.withLock(() => {
      registry.initSettings({ uidBase: 71000, domain: "a.example.net", timezone: "Europe/Istanbul" });
      registry.initSettings({ uidBase: 75000, domain: "b.example.net" });
      expect(registry.getSetting("uid_next")).toBe("71000");
      expect(registry.getSetting("domain")).toBe("a.example.net");
      expect(registry.getSetting("tunnel_port_next")).toBe("7101");
      expect(registry.getSetting("timezone")).toBe("Europe/Istanbul");
      expect(() => registry.setSetting("uid_next", "70000")).toThrow(RegistryError);
      registry.setSetting("alert_webhook", "https://ntfy.sh/x");
      expect(registry.getSetting("alert_webhook")).toBe("https://ntfy.sh/x");
    });
    await registry.withLock(() => {
      expect(() => registry.initSettings({ uidBase: 1000 })).toThrow(/uid base/);
      expect(() => registry.initSettings({ uidBase: UID_LIMIT })).toThrow(/uid base/);
    });
  });

  test("the actor names the sudo user", () => {
    expect(currentActor({ SUDO_USER: "omer" })).toBe("root:omer");
    expect(currentActor({})).toBe("root");
    expect(currentActor({ SUDO_USER: "x;rm -rf" })).toBe("root");
  });
});

describe("uid allocation", () => {
  test("is monotonic and never reuses a uid, also across deletes", async () => {
    const host = await fakeHost({ uidBase: 71000 });
    await createProject(host, { slug: "shop" });
    const a = await createBranch(host, { project: "shop", name: "dev" });
    const b = await createBranch(host, { project: "shop", name: "feature" });
    expect([a.os_uid, b.os_uid]).toEqual([71000, 71001]);
    expect([a.tunnel_port, b.tunnel_port]).toEqual([7101, 7102]);
    await deleteBranch(host, { project: "shop", name: "feature" });
    await deleteBranch(host, { project: "shop", name: "dev" });
    expect(host.registry.getBranch(a.id)!.phase).toBe("deleted");
    // Same names again: new ids, new uids, new ports.
    const a2 = await createBranch(host, { project: "shop", name: "dev" });
    const b2 = await createBranch(host, { project: "shop", name: "feature" });
    expect(a2.id).not.toBe(a.id);
    expect([a2.os_uid, b2.os_uid]).toEqual([71002, 71003]);
    expect([a2.tunnel_port, b2.tunnel_port]).toEqual([7103, 7104]);
    expect(host.registry.getSetting("uid_next")).toBe("71004");
  });

  test("a failed phase 1 commits nothing, and a counter behind the table is skipped forward", async () => {
    const host = await fakeHost({ uidBase: 71000 });
    await createProject(host, { slug: "shop" });
    let calls = 0;
    host.random = (n) => {
      if (++calls === 3) throw new Error("no entropy");
      return crypto.getRandomValues(new Uint8Array(n));
    };
    await expect(createBranch(host, { project: "shop", name: "dev" })).rejects.toThrow("no entropy");
    expect(host.registry.listBranches()).toEqual([]);
    expect(host.registry.db.query(`SELECT count(*) AS n FROM env`).get()).toEqual({ n: 0 });
    delete host.random;
    const a = await createBranch(host, { project: "shop", name: "dev" });
    expect(a.os_uid).toBe(71000);
    // Someone rolled uid_next back by hand: allocation still goes past every uid ever used.
    host.registry.db.run(`UPDATE settings SET value = '71000' WHERE key = 'uid_next'`);
    const b = await createBranch(host, { project: "shop", name: "next" });
    expect(b.os_uid).toBe(71001);
  });

  test("labels are unique among live branches only", async () => {
    const host = await fakeHost();
    await createProject(host, { slug: "shop" });
    await createBranch(host, { project: "shop", name: "dev" });
    await expect(createBranch(host, { project: "shop", name: "dev" })).rejects.toThrow(/already exists/);
    await expect(createBranch(host, { project: "nope", name: "dev" })).rejects.toThrow(/No project/);
    await expect(createProject(host, { slug: "shop" })).rejects.toThrow(/already exists/);
    // The unique index itself, not only the check in createBranch.
    const row = host.registry.findBranch("shop", "dev")!;
    await host.registry.withLock(() => {
      expect(() => host.registry.insertBranch({ ...row, id: "bzzzzzzz", os_uid: 79999, tunnel_port: 9999, s3_prefix: "x/" })).toThrow(/UNIQUE/);
    });
  });

  test("the domain is fixed once a branch exists", async () => {
    const host = await fakeHost();
    await host.registry.withLock(() => host.registry.setSetting("domain", "other.example.net"));
    await createProject(host, { slug: "shop" });
    await createBranch(host, { project: "shop", name: "dev" });
    await host.registry.withLock(() => {
      expect(() => host.registry.setSetting("domain", "third.example.net")).toThrow(/fixed/);
    });
  });
});

describe("control/LOCK", () => {
  /** A second process that holds the lock of `root` until its stdin closes. */
  async function holder(root: string) {
    const code = `
      import { HostLayout } from ${JSON.stringify(join(import.meta.dir, "..", "src", "host", "layout.ts"))};
      import { Registry } from ${JSON.stringify(join(import.meta.dir, "..", "src", "host", "registry.ts"))};
      const registry = Registry.open(new HostLayout({ root: ${JSON.stringify(root)} }));
      await registry.withLock(async () => {
        console.log("locked");
        for await (const _ of Bun.stdin.stream()) {}
      });
    `;
    const proc = Bun.spawn(["bun", "-e", code], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("locked");
    return proc;
  }

  test("a concurrent mutating command waits for it", async () => {
    const host = await fakeHost();
    const proc = await holder(host.layout.root);
    const started = Date.now();
    setTimeout(() => proc.stdin.end(), 400);
    const project = await createProject(host, { slug: "shop" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(project.slug).toBe("shop");
    await proc.exited;
  });

  test("gives up after the timeout", async () => {
    const host = await fakeHost();
    const proc = await holder(host.layout.root);
    try {
      await expect(host.registry.withLock(() => 1, { timeoutMs: 200 })).rejects.toThrow(RegistryLockedError);
    } finally {
      proc.stdin.end();
      await proc.exited;
    }
    expect(await host.registry.withLock(() => 2)).toBe(2);
  });

  test("is re-entrant in one process and released after an error", async () => {
    const host = await fakeHost();
    await expect(
      host.registry.withLock(async () => {
        await host.registry.withLock(() => expect(host.registry.locked).toBe(true));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(host.registry.locked).toBe(false);
    expect(await host.registry.withLock(() => "again")).toBe("again");
  });
});
