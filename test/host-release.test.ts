// The release pipeline (design section 3.2 D.2-D.3) against FakeDriver: every
// outcome of snapshot, preflight, switch and gate, the revert rules around
// migration_committed, pruning, rollback and runtime upgrades.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { FakeOutcome, FakeRun } from "../src/host/fake-driver.ts";
import * as ops from "../src/host/ops.ts";
import { Registry, type BranchRow } from "../src/host/registry.ts";
import { closeOpsHosts, fakeBundle, fakeOpsHost, seedDatabase, type OpsTestHost } from "./host-helpers.ts";

afterEach(closeOpsHosts);

async function shop(branches = ["prod", "dev"]) {
  const host = await fakeOpsHost();
  await ops.createProject(host, { slug: "shop", branches });
  return host;
}

const branchOf = (host: OpsTestHost, name: string) => host.registry.findBranch("shop", name)!;
const release = (host: OpsTestHost, name: string, file: string, extra: Partial<Parameters<typeof ops.addRelease>[1]> = {}) =>
  ops.addRelease(host, { project: "shop", branch: name, file, ...extra });

/** What starts of release `seq` (of the given unit kind) do; everything else serves. */
function when(host: OpsTestHost, seq: number, kind: FakeRun["kind"], outcome: FakeOutcome) {
  const previous = host.driver.behavior;
  host.driver.behavior = (run) => (run.kind === kind && run.bundle?.endsWith(`/releases/${seq}/app.ib`) ? outcome : previous(run));
}

const branchCalls = (host: OpsTestHost, b: BranchRow, from = 0) =>
  host.driver.calls.slice(from).filter((c) => c.endsWith(host.layout.units.branch(b.id)) && !c.startsWith("reset-failed"));
const actions = (host: OpsTestHost, b: BranchRow) => host.registry.listAudit(b.id).map((a) => a.action);

describe("a release that goes live", () => {
  test("dev: no snapshot or preflight; drop-in, generation, gate, then live", async () => {
    const host = await shop();
    const dev = branchOf(host, "dev");
    const { release: r, unit } = await release(host, "dev", fakeBundle(host.dir, "v1"));
    expect(unit).toBe(`incibase-release-${dev.id}-1.service`);
    expect(r).toMatchObject({ seq: 1, status: "live", preflight: 0, snapshot: null, error: null });
    const after = branchOf(host, "dev");
    expect(after).toMatchObject({ release_seq: 1, desired_state: "running", busy_unit: null });
    expect(after.generation).toMatch(/^1\.[0-9a-f]{12}$/);
    expect(r.generation).toBe(after.generation);

    const stored = host.layout.releaseFile(dev.id, 1);
    expect(host.sys.lstat(stored)).toMatchObject({ type: "file", uid: 0, gid: dev.os_uid, mode: 0o640 });
    expect(host.sys.lstat(host.layout.releaseDir(dev.id, 1))).toMatchObject({ uid: 0, gid: dev.os_uid, mode: 0o750 });
    expect(readFileSync(stored, "utf8")).toBe(readFileSync(join(host.dir, "v1.ib"), "utf8"));
    const dropIn = readFileSync(host.layout.dropIn(host.layout.units.branch(dev.id)), "utf8");
    expect(dropIn).toContain(`--bundle ${stored} `);
    expect(dropIn).toContain(`Environment=INCIBASE_GENERATION=${after.generation}\n`);
    // Started at boot now; the job ran as a transient unit with the host's root.
    expect(host.sys.readlink(host.layout.wantsLink(dev.id).path)).toBe(host.layout.wantsLink(dev.id).target);
    expect(host.driver.calls).toContain(`run ${unit} /usr/local/bin/incibase host _job --root ${host.layout.root} release ${dev.id} 1`);
    expect(branchCalls(host, dev)).toEqual([`restart ${host.layout.units.branch(dev.id)}`]);
    expect(actions(host, dev)).toEqual(["branch.create", "branch.provisioned", "release.add", "release.live"]);
    expect(host.lines).toContain(`release shop/dev#1 is live`);
  });

  test("prod: snapshot while running, preflight on the copy, then live", async () => {
    const host = await shop();
    const prod = branchOf(host, "prod");
    seedDatabase(host, prod, 5);
    const preflights: FakeRun[] = [];
    host.driver.behavior = (run) => {
      if (run.kind === "preflight") {
        preflights.push(run);
        // The copy is in preflight/, the branch's, while the preflight runs.
        const copy = join(host.layout.branch(prod.id).preflight, "data.db");
        expect(host.sys.lstat(copy)).toMatchObject({ uid: prod.os_uid, gid: prod.os_uid, mode: 0o600 });
        expect(new Database(copy, { readonly: true }).query("SELECT count(*) AS n FROM docs").get()).toEqual({ n: 5 });
      }
      return {};
    };
    const { release: r } = await release(host, "prod", fakeBundle(host.dir, "v1"));
    expect(r).toMatchObject({ status: "live", preflight: 1, snapshot: host.layout.snapshot(prod.id, "pre-1") });
    expect(r.preflight_ms).toBeNumber();
    expect(host.sys.lstat(r.snapshot!)).toMatchObject({ type: "file", uid: 0, gid: 0, mode: 0o600 });
    expect(new Database(r.snapshot!, { readonly: true }).query("SELECT count(*) AS n FROM docs").get()).toEqual({ n: 5 });
    expect(preflights).toHaveLength(1);
    expect(preflights[0]!.argv).toContain("--migrate-only");
    expect(preflights[0]!.argv).not.toContain("--allow-empty");
    expect(preflights[0]!.bundle).toBe(host.layout.releaseFile(prod.id, 1));
    // The copy is gone afterwards.
    expect(readdirSync(host.layout.branch(prod.id).preflight)).toEqual([]);
    expect(host.driver.calls.indexOf(`start ${host.layout.units.preflight(prod.id)}`)).toBeLessThan(
      host.driver.calls.indexOf(`restart ${host.layout.units.branch(prod.id)}`),
    );
  });

  test("the first release of a branch without data runs its preflight with --allow-empty", async () => {
    const host = await shop();
    const runs: FakeRun[] = [];
    host.driver.behavior = (run) => (runs.push(run), {});
    const { release: r } = await release(host, "prod", fakeBundle(host.dir, "v1"));
    expect(r).toMatchObject({ status: "live", snapshot: null });
    expect(runs.find((x) => x.kind === "preflight")!.argv).toContain("--allow-empty");
  });

  test("dev opts in to the preflight; prod can skip it", async () => {
    const host = await shop();
    const dev = branchOf(host, "dev");
    seedDatabase(host, dev);
    await ops.setBranch(host, { project: "shop", branch: "dev", config: { preflight: true } });
    const runs: FakeRun[] = [];
    host.driver.behavior = (run) => (runs.push(run), {});
    expect((await release(host, "dev", fakeBundle(host.dir, "v1"))).release).toMatchObject({ preflight: 1, snapshot: null, status: "live" });
    expect(runs.map((r) => r.kind)).toEqual(["preflight", "branch"]);
    // A dev preflight copies the live data straight into preflight/, no backup is kept.
    expect(existsSync(host.layout.branch(dev.id).backups)).toBe(false);
    expect((await release(host, "prod", fakeBundle(host.dir, "v2"), { preflight: false })).release).toMatchObject({ preflight: 0, status: "live" });
  });

  test("--allow-field-removal is in the drop-in for the first start only", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    const seen: string[][] = [];
    host.driver.behavior = (run) => (seen.push(run.argv), {});
    await release(host, "dev", fakeBundle(host.dir, "v1"), { allowFieldRemoval: true });
    expect(seen[0]).toContain("--allow-field-removal");
    expect(readFileSync(host.layout.dropIn(host.layout.units.branch(dev.id)), "utf8")).not.toContain("--allow-field-removal");
  });
});

describe("a preflight that fails leaves the live branch alone", () => {
  for (const [name, outcome, exitCode, text] of [
    ["exit 64", { exit: 64 }, 64, /exited with 64 \(configuration error\)/],
    ["exit 65", { exit: 65 }, 65, /exited with 65 \(migration refused\).*live branch is untouched/s],
    ["exit 78", { exit: 78 }, 78, /exited with 78 \(invalid app definition\)/],
    ["an OOM", { oom: true }, 137, /ran out of memory/],
  ] as const) {
    test(name, async () => {
      const host = await shop(["prod"]);
      const prod = branchOf(host, "prod");
      await release(host, "prod", fakeBundle(host.dir, "v1"));
      seedDatabase(host, prod);
      const live = branchOf(host, "prod");
      const calls = host.driver.calls.length;
      when(host, 2, "preflight", outcome);
      host.driver.log(host.layout.units.preflight(prod.id), '{"ev":"fatal","msg":"\u001b[31mred"}');
      const { release: r } = await release(host, "prod", fakeBundle(host.dir, "v2"));
      expect(r).toMatchObject({ seq: 2, status: "failed", exit_code: exitCode, snapshot: host.layout.snapshot(prod.id, "pre-2") });
      expect(r.error).toMatch(text);
      expect(r.error).not.toContain("\u001b");
      // Same release, generation and process: no restart, no drop-in change.
      expect(branchOf(host, "prod")).toMatchObject({ release_seq: 1, generation: live.generation, busy_unit: null });
      expect(branchCalls(host, prod, calls)).toEqual([]);
      expect(host.registry.getRelease(prod.id, 1)!.status).toBe("live");
      expect(readdirSync(host.layout.branch(prod.id).preflight)).toEqual([]);
      expect(actions(host, prod).slice(-2)).toEqual(["release.add", "release.failed"]);
    });
  }

  test("too little disk for the snapshot fails before anything runs", async () => {
    const host = await shop(["prod"]);
    const prod = branchOf(host, "prod");
    await release(host, "prod", fakeBundle(host.dir, "v1"));
    seedDatabase(host, prod);
    host.sys.free = 50 * 1024 * 1024;
    const calls = host.driver.calls.length;
    const { release: r } = await release(host, "prod", fakeBundle(host.dir, "v2"));
    expect(r).toMatchObject({ status: "failed", snapshot: null });
    expect(r.error).toMatch(/Not enough free space for a snapshot/);
    expect(host.driver.calls.slice(calls).filter((c) => c.startsWith("start") || c.startsWith("restart"))).toEqual([]);
  });
});

describe("a release that does not become healthy", () => {
  test("before a migration committed (gate timeout): the previous release runs again", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    when(host, 2, "branch", { hang: true });
    const { release: r } = await release(host, "dev", fakeBundle(host.dir, "v2"));
    expect(r).toMatchObject({ status: "failed", migration_committed: 0 });
    expect(r.error).toMatch(/did not report generation 2\.[0-9a-f]+ within/);
    const after = branchOf(host, "dev");
    expect(after).toMatchObject({ release_seq: 1, busy_unit: null, desired_state: "running" });
    expect(after.generation).toMatch(/^1\./);
    expect(readFileSync(host.layout.dropIn(host.layout.units.branch(dev.id)), "utf8")).toContain("/releases/1/app.ib");
    expect(await host.driver.health(host.layout.branch(dev.id).adminSock)).toMatchObject({ generation: after.generation });
    expect(actions(host, dev).slice(-3)).toEqual(["release.add", "release.revert", "release.failed"]);
    expect(host.registry.getRelease(dev.id, 1)!.status).toBe("live");
  });

  test("exit 65 at the live start (no preflight): reverted", async () => {
    const host = await shop(["dev"]);
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    when(host, 2, "branch", { exit: 65 });
    const { release: r } = await release(host, "dev", fakeBundle(host.dir, "v2"));
    expect(r).toMatchObject({ status: "failed", exit_code: 65, migration_committed: 0 });
    expect(r.error).toMatch(/exited with 65 \(migration refused\)/);
    expect(branchOf(host, "dev").release_seq).toBe(1);
  });

  test("a crash loop that ends at the start limit, before any commit: reverted", async () => {
    const host = await shop(["dev"]);
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    when(host, 2, "branch", { exit: 1 });
    const { release: r } = await release(host, "dev", fakeBundle(host.dir, "v2"));
    expect(r).toMatchObject({ status: "failed", exit_code: 1, migration_committed: 0 });
    expect(r.error).toMatch(/start limit/);
    expect(branchOf(host, "dev").release_seq).toBe(1);
  });

  test("the first release fails: the branch is stopped and not started at boot", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    when(host, 1, "branch", { exit: 78 });
    const { release: r } = await release(host, "dev", fakeBundle(host.dir, "v1"));
    expect(r).toMatchObject({ status: "failed", exit_code: 78 });
    expect(branchOf(host, "dev")).toMatchObject({ release_seq: null, generation: null, desired_state: "stopped", busy_unit: null });
    expect(readFileSync(host.layout.dropIn(host.layout.units.branch(dev.id)), "utf8")).not.toContain("ExecStart");
    expect(host.sys.readlink(host.layout.wantsLink(dev.id).path)).toBeNull();
    expect(host.driver.calls.at(-2)).toBe(`stop ${host.layout.units.branch(dev.id)}`);
  });

  test("after its migration committed: it stays, with an alert and the --restore way back", async () => {
    const host = await shop(["prod"]);
    const prod = branchOf(host, "prod");
    await release(host, "prod", fakeBundle(host.dir, "v1"));
    seedDatabase(host, prod);
    when(host, 2, "branch", { migrationCommitted: true, exit: 1 });
    const { release: r } = await release(host, "prod", fakeBundle(host.dir, "v2"));
    expect(r).toMatchObject({ status: "failed", migration_committed: 1, snapshot: host.layout.snapshot(prod.id, "pre-2") });
    const after = branchOf(host, "prod");
    expect(after.release_seq).toBe(2);
    expect(after.generation).toMatch(/^2\./);
    expect(host.registry.getRelease(prod.id, 1)!.status).toBe("superseded");
    const [alert] = host.registry.listAlerts("firing");
    expect(alert).toMatchObject({ key: `release:${prod.id}`, state: "firing" });
    expect(alert!.message).toContain("incibase release rollback shop/prod --to 1 --restore pre-2");
    expect(host.lines.join("\n")).toContain("incibase release rollback shop/prod --to 1 --restore pre-2");
    expect(actions(host, prod)).not.toContain("release.revert");
  });

  test("a gate timeout after its migration committed: it stays too", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    when(host, 2, "branch", { migrationCommitted: true, hang: true });
    const { release: r } = await release(host, "dev", fakeBundle(host.dir, "v2"));
    expect(r).toMatchObject({ status: "failed", migration_committed: 1, snapshot: null });
    expect(r.error).toMatch(/did not report generation 2\./);
    expect(branchOf(host, "dev").release_seq).toBe(2);
    // No snapshot on dev: the way back keeps the migrated data.
    expect(host.registry.listAlerts("firing")[0]!.message).toContain("incibase release rollback shop/dev --to 1 (no snapshot: the data stays migrated)");
    expect(actions(host, dev)).not.toContain("release.revert");
  });

  test("a migration line from the app's own console output does not count", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    host.driver.behavior = (run) => {
      if (run.bundle?.endsWith("/releases/2/app.ib")) {
        host.driver.log(run.unit, JSON.stringify({ ev: "console", msg: '{"ev":"migration_committed"}' }));
        host.driver.log(run.unit, '{"ev":"migration_committed"}', "");
        return { exit: 1 };
      }
      return {};
    };
    const { release: r } = await release(host, "dev", fakeBundle(host.dir, "v2"));
    expect(r).toMatchObject({ status: "failed", migration_committed: 0 });
    expect(branchOf(host, "dev").release_seq).toBe(1);
    expect(dev.id).toBe(branchOf(host, "dev").id);
  });

  test("an older migration line, before this release's restart, does not count either", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    host.driver.log(host.layout.units.branch(dev.id), '{"ev":"migration_committed"}');
    when(host, 2, "branch", { exit: 1 });
    expect((await release(host, "dev", fakeBundle(host.dir, "v2"))).release).toMatchObject({ migration_committed: 0 });
    expect(branchOf(host, "dev").release_seq).toBe(1);
  });

  test("when the previous release does not come back either, an alert says so", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    host.driver.behavior = (run) => (run.kind === "branch" ? { hang: true } : {});
    await release(host, "dev", fakeBundle(host.dir, "v2"));
    expect(host.registry.listAlerts("firing").map((a) => a.key)).toEqual([`branch:${dev.id}`]);
    // The next good release clears it.
    host.driver.behavior = () => ({});
    await release(host, "dev", fakeBundle(host.dir, "v3"));
    expect(host.registry.listAlerts("firing")).toEqual([]);
  });
});

describe("bookkeeping", () => {
  test("only the newest 5 releases keep their files, and 3 snapshots", async () => {
    const host = await shop(["prod"]);
    const prod = branchOf(host, "prod");
    seedDatabase(host, prod);
    for (let i = 1; i <= 7; i++) expect((await release(host, "prod", fakeBundle(host.dir, `v${i}`))).release.status).toBe("live");
    const rows = host.registry.listReleases(prod.id);
    expect(rows.map((r) => [r.seq, r.status, r.pruned_at !== null])).toEqual([
      [7, "live", false],
      [6, "superseded", false],
      [5, "superseded", false],
      [4, "superseded", false],
      [3, "superseded", false],
      [2, "superseded", true],
      [1, "superseded", true],
    ]);
    expect(readdirSync(host.layout.branch(prod.id).releases).sort()).toEqual(["3", "4", "5", "6", "7"]);
    expect(readdirSync(host.layout.branch(prod.id).backups).sort()).toEqual(["pre-5.db", "pre-6.db", "pre-7.db"]);
  });

  test("a file that is not a bundle, or a tampered one, never becomes a release", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await expect(release(host, "dev", host.dir)).rejects.toThrow(/is not a file/);
    await expect(release(host, "dev", join(host.dir, "missing.ib"))).rejects.toThrow(/is not a file/);
    const bad = join(host.dir, "bad.ib");
    writeFileSync(bad, "console.log('pwned')\n");
    await expect(release(host, "dev", bad)).rejects.toThrow(/not an incibase bundle/);
    const tampered = fakeBundle(host.dir, "t");
    writeFileSync(tampered, readFileSync(tampered, "utf8") + "globalThis.x = 1;\n");
    await expect(release(host, "dev", tampered)).rejects.toThrow(/sha256 mismatch/);
    expect(host.registry.listReleases(dev.id)).toEqual([]);
    expect(branchOf(host, "dev").busy_unit).toBeNull();
    // Changed after it was stored: the job refuses it.
    host.driver.onTransient = null;
    const { unit } = await release(host, "dev", fakeBundle(host.dir, "v1"), { wait: false });
    writeFileSync(host.layout.releaseFile(dev.id, 1), "changed");
    const { runReleaseJob } = await import("../src/host/release.ts");
    const r = await runReleaseJob(host, dev.id, 1);
    expect(r).toMatchObject({ status: "failed" });
    expect(r.error).toMatch(/does not match the sha256/);
    expect(unit).toBe(`incibase-release-${dev.id}-1.service`);
  });

  test("the branch is busy while a job runs; the job holds the lock only for moments", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    const other = Registry.open(host.layout);
    let during: unknown = null;
    host.driver.behavior = (run) => {
      if (run.kind === "branch" && run.bundle?.endsWith("/2/app.ib")) {
        // Mid-release: another command may take the lock, and finds the branch busy.
        during = other.withLock(() => other.getBranch(dev.id)!.busy_unit, { timeoutMs: 100 });
      }
      return {};
    };
    const job = release(host, "dev", fakeBundle(host.dir, "v2"));
    await expect(ops.addRelease(host, { project: "shop", branch: "dev", file: fakeBundle(host.dir, "v3") })).rejects.toMatchObject({ code: "BUSY" });
    await job;
    expect(await during).toBe(`incibase-release-${dev.id}-2.service`);
    other.close();
  });

  test("render frees a branch whose job died and marks its release interrupted", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    host.driver.onTransient = () => new Promise(() => {});
    const { unit } = await release(host, "dev", fakeBundle(host.dir, "v1"), { wait: false });
    // While the job runs, render leaves it alone.
    expect((await ops.render(host)).interrupted).toEqual([]);
    expect(branchOf(host, "dev").busy_unit).toBe(unit);
    // The job's unit is gone (killed, machine rebooted).
    host.driver.stop(unit);
    expect((await ops.render(host)).interrupted).toEqual([dev.id]);
    expect(branchOf(host, "dev").busy_unit).toBeNull();
    expect(host.registry.getRelease(dev.id, 1)).toMatchObject({ status: "interrupted" });
    expect(actions(host, dev)).toContain("job.interrupted");
  });

  test("a release needs its runtime installed", async () => {
    const host = await shop([]);
    await ops.createBranch(host, { project: "shop", name: "dev", runtimeVersion: "9.9.9" });
    await expect(release(host, "dev", fakeBundle(host.dir, "v1"))).rejects.toThrow(/runtime 9\.9\.9 .* is not installed/);
  });
});

describe("rollback", () => {
  test("to the previous release, with the gate", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    await release(host, "dev", fakeBundle(host.dir, "v2"));
    const result = await ops.rollback(host, { project: "shop", branch: "dev" });
    expect(result).toMatchObject({ ok: true, to: 1 });
    expect(branchOf(host, "dev")).toMatchObject({ release_seq: 1, busy_unit: null });
    expect(host.registry.getRelease(dev.id, 1)!.status).toBe("live");
    expect(host.registry.getRelease(dev.id, 2)!.status).toBe("superseded");
    expect(readFileSync(host.layout.dropIn(host.layout.units.branch(dev.id)), "utf8")).toContain("/releases/1/app.ib");
    await expect(ops.rollback(host, { project: "shop", branch: "dev", to: 1 })).rejects.toThrow(/already runs release 1/);
    await expect(ops.rollback(host, { project: "shop", branch: "dev", to: 9 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("--restore puts the snapshot back; a protected branch needs its hostname", async () => {
    const host = await shop(["prod"]);
    const prod = branchOf(host, "prod");
    seedDatabase(host, prod, 2);
    await release(host, "prod", fakeBundle(host.dir, "v1"));
    // The release after it migrated the data, then failed.
    seedDatabase(host, prod, 3);
    when(host, 2, "branch", { migrationCommitted: true, exit: 1 });
    await release(host, "prod", fakeBundle(host.dir, "v2"));
    seedDatabase(host, prod, 4);
    const input = { project: "shop", branch: "prod", to: 1, restore: "pre-2" };
    await expect(ops.rollback(host, input)).rejects.toMatchObject({ code: "CONFIRM" });
    const result = await ops.rollback(host, { ...input, confirm: "prod--shop.incibase.example.net" });
    expect(result).toMatchObject({ ok: true, to: 1 });
    const data = host.layout.branch(prod.id).data;
    // The database the snapshot had (2 + 3 rows), owned by the branch, without the old WAL.
    expect(new Database(join(data, "data.db"), { readonly: true }).query("SELECT count(*) AS n FROM docs").get()).toEqual({ n: 5 });
    expect(host.sys.lstat(join(data, "data.db"))).toMatchObject({ uid: prod.os_uid, gid: prod.os_uid, mode: 0o600 });
    const kept = readdirSync(host.layout.branch(prod.id).backups).filter((n) => n.startsWith("replaced-"));
    expect(kept).toHaveLength(1);
    expect(new Database(join(host.layout.branch(prod.id).backups, kept[0]!, "data.db"), { readonly: true }).query("SELECT count(*) AS n FROM docs").get()).toEqual({
      n: 9,
    });
    const stop = host.driver.calls.lastIndexOf(`stop ${host.layout.units.branch(prod.id)}`);
    expect(stop).toBeGreaterThan(-1);
    expect(host.driver.calls.lastIndexOf(`restart ${host.layout.units.branch(prod.id)}`)).toBeGreaterThan(stop);
    expect(host.registry.listAlerts("firing")).toEqual([]);
    await expect(ops.rollback(host, { project: "shop", branch: "prod", to: 1, restore: "pre-9", confirm: "prod--shop.incibase.example.net" })).rejects.toThrow(
      /No snapshot pre-9/,
    );
  });
});

describe("runtime upgrades", () => {
  async function withRuntime(host: OpsTestHost, version: string) {
    const binary = join(host.dir, `incibase-${version}`);
    writeFileSync(binary, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    await ops.installRuntime(host, { binary, version });
  }

  test("switch the pinned runtime with the gate; revert when it fails", async () => {
    const host = await shop(["dev"]);
    const dev = branchOf(host, "dev");
    await release(host, "dev", fakeBundle(host.dir, "v1"));
    const before = branchOf(host, "dev").runtime_version;
    await expect(ops.upgradeBranch(host, { project: "shop", branch: "dev", runtimeVersion: "0.4.0" })).rejects.toThrow(/not installed/);
    await withRuntime(host, "0.4.0");
    await withRuntime(host, "0.5.0");
    expect(await ops.upgradeBranch(host, { project: "shop", branch: "dev", runtimeVersion: "0.4.0" })).toMatchObject({ ok: true });
    expect(readFileSync(host.layout.dropIn(host.layout.units.branch(dev.id)), "utf8")).toContain(`${host.layout.runtimeRoot}/0.4.0/incibase serve`);
    host.driver.behavior = (run) => (run.runtime === "0.5.0" && run.kind === "branch" ? { exit: 64 } : {});
    expect(await ops.upgradeBranch(host, { project: "shop", branch: "dev", runtimeVersion: "0.5.0" })).toMatchObject({ ok: false });
    expect(branchOf(host, "dev").runtime_version).toBe("0.4.0");
    expect(readFileSync(host.layout.dropIn(host.layout.units.branch(dev.id)), "utf8")).toContain(`${host.layout.runtimeRoot}/0.4.0/incibase serve`);
    expect(before).not.toBe("0.4.0");
  });

  test("installRuntime checks what the binary says it is", async () => {
    const host = await shop([]);
    const binary = join(host.dir, "liar");
    writeFileSync(binary, "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
    await expect(ops.installRuntime(host, { binary, version: "2.0.0" })).rejects.toThrow(/says it is "1.0.0", not 2.0.0/);
    expect(existsSync(host.layout.runtimeBinary("2.0.0"))).toBe(false);
    await expect(ops.installRuntime(host, { binary, version: "2.0.0; rm -rf /" })).rejects.toMatchObject({ code: "INVALID" });
    await withRuntime(host, "1.0.0");
    expect(host.sys.lstat(host.layout.runtimeBinary("1.0.0"))).toMatchObject({ type: "file", uid: 0, gid: 0, mode: 0o755 });
  });
});
