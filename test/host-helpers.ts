import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestLine, sha256Hex, type BundleManifest } from "../src/engine/manifest.ts";
import { VERSION } from "../src/engine/version.ts";
import type { OpsContext } from "../src/host/context.ts";
import { FakeDriver } from "../src/host/fake-driver.ts";
import { FakeSystem } from "../src/host/fake-system.ts";
import { HostLayout } from "../src/host/layout.ts";
import * as ops from "../src/host/ops.ts";
import { initHost, type HostContext } from "../src/host/provision.ts";
import { Registry, type BranchRow, type InitSettings } from "../src/host/registry.ts";
import { runJob } from "../src/host/release.ts";

export interface TestHost extends HostContext {
  sys: FakeSystem;
  dir: string;
  close(): void;
}

const hosts: TestHost[] = [];

/** A host on a temp root with a FakeSystem, initialized like `host init` would. */
export async function fakeHost(init: InitSettings = {}): Promise<TestHost> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "incibase-host-")));
  const layout = new HostLayout({ root: join(dir, "root") });
  const sys = new FakeSystem();
  let t = 1_800_000_000_000;
  const ctx = { layout, sys, now: () => (t += 1000), actor: "root:test" } as HostContext & { sys: FakeSystem };
  sys.mkdir(layout.root, 0o755);
  ctx.registry = Registry.open(layout);
  await initHost(ctx, { uidBase: 70000, domain: "incibase.example.net", timezone: "Europe/Istanbul", ...init });
  const host: TestHost = {
    ...ctx,
    dir,
    close() {
      ctx.registry.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  hosts.push(host);
  return host;
}

export function closeHosts() {
  for (const host of hosts.splice(0)) host.close();
}

/** Parses an env file the way systemd reads what the renderer writes (unquoted, or double quotes with \" and \\). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\n") {
      i++;
      continue;
    }
    if (text[i] === "#") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    const eq = text.indexOf("=", i);
    if (eq < 0) throw new Error(`no "=" after ${JSON.stringify(text.slice(i, i + 20))}`);
    const name = text.slice(i, eq);
    i = eq + 1;
    let value = "";
    if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) {
          value += text[i + 1];
          i += 2;
        } else value += text[i++];
      }
      if (text[i] !== '"') throw new Error(`unterminated value of ${name}`);
      i++;
    } else {
      const end = text.indexOf("\n", i);
      value = text.slice(i, end < 0 ? undefined : end);
      i = end < 0 ? text.length : end;
    }
    out[name] = value;
  }
  return out;
}

// ---- ops on a fake host --------------------------------------------------------

export interface OpsTestHost extends OpsContext {
  sys: FakeSystem;
  driver: FakeDriver;
  dir: string;
  /** What the ops and jobs logged. */
  lines: string[];
  close(): void;
}

/**
 * A host for the owner operations: FakeSystem, FakeDriver (whose transient
 * jobs run in this process), unit files under a temp dir with the
 * production names, the current runtime installed and its own CLI link
 * pointing at it (as `host use-cli` leaves it; `cli: false` for none), and
 * gates that poll every millisecond and give up after `gateFloorMs` (200 ms).
 */
export async function fakeOpsHost(options: { unitPrefix?: string; cli?: boolean } = {}): Promise<OpsTestHost> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "incibase-ops-")));
  const layout = new HostLayout({
    root: join(dir, "root"),
    runtimeRoot: join(dir, "runtime"),
    systemdDir: join(dir, "systemd"),
    // Never the machine's own incibase on PATH.
    cliLink: join(dir, "bin", "incibase"),
    ...(options.unitPrefix ? { unitPrefix: options.unitPrefix } : {}),
  });
  mkdirSync(join(dir, "bin"));
  const sys = new FakeSystem();
  const driver = new FakeDriver(layout, sys);
  let t = 1_800_000_000_000;
  const lines: string[] = [];
  const ctx = {
    layout,
    sys,
    driver,
    self: ["/usr/local/bin/incibase"],
    now: () => (t += 1000),
    actor: "root:test",
    log: (line: string) => void lines.push(line),
    pollMs: 1,
    settleMs: 0,
    gateFloorMs: 200,
    sleep: () => Bun.sleep(1),
    health: (socket: string) => driver.health(socket),
  } as unknown as OpsTestHost;
  sys.mkdir(layout.root, 0o755);
  ctx.registry = Registry.open(layout);
  ctx.registry.lockTimeoutMs = 500;
  driver.onTransient = (job) => runJob(ctx, job.argv.slice(job.argv.indexOf("_job") + 3));
  await ops.initHost(ctx, { domain: "incibase.example.net", timezone: "Europe/Istanbul", uidBase: 70000, sliceMemoryMax: 3 * 1024 ** 3 });
  const binary = join(dir, "incibase-bin");
  writeFileSync(binary, `#!/bin/sh\necho ${VERSION}\n`, { mode: 0o755 });
  await ops.installRuntime(ctx, { binary, version: VERSION, sha256: sha256Hex(readFileSync(binary)) });
  if (options.cli !== false) await ops.useCli(ctx, { version: VERSION });
  Object.assign(ctx, {
    dir,
    lines,
    close() {
      ctx.registry.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
  opsHosts.push(ctx);
  return ctx;
}

const opsHosts: OpsTestHost[] = [];

export function closeOpsHosts() {
  for (const host of opsHosts.splice(0)) host.close();
}

/** A valid release bundle that nothing runs (the fake driver only reads its path); `body` makes each one different. */
export function fakeBundle(dir: string, name: string, body = `export default ${JSON.stringify(name)};\n`): string {
  const manifest: BundleManifest = {
    format: 1,
    incibaseVersion: VERSION,
    sha256: sha256Hex(body),
    createdAt: new Date().toISOString(),
    app: { functions: [], tables: {}, crons: [], http: [] },
    envNames: [],
  };
  const path = join(dir, `${name}.ib`);
  writeFileSync(path, `${manifestLine(manifest)}\n${body}`);
  return path;
}

/** A real SQLite database in the branch's data dir, as serve would leave it. */
export function seedDatabase(host: OpsTestHost, branch: BranchRow, rows = 3) {
  const path = join(host.layout.branch(branch.id).data, "data.db");
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY, body TEXT)");
  for (let i = 0; i < rows; i++) db.run("INSERT INTO docs (body) VALUES (?)", [`doc ${i}`]);
  db.close();
  host.sys.own(path, branch.os_uid, branch.os_uid, 0o600);
  return path;
}
