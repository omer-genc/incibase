// The control registry, `<root>/control/registry.db` (design section 5.1):
// root-only SQLite holding what the owner asked for. What actually runs comes
// from systemd; every derived file (env files, links, units) is rendered from
// this database and can be rendered again (`host render`).
//
// Every change happens under `control/LOCK`, in a short IMMEDIATE
// transaction. uids and tunnel ports come from counters that only grow, so a
// new branch never inherits a deleted branch's files or dashboard origin.
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DataDirLock, DataDirLockedError } from "../engine/store.ts";
import type { HostLayout, SavedLayout } from "./layout.ts";
import type { BranchKind } from "./names.ts";

/** uids below this are left to the distribution and the admin. */
export const MIN_UID_BASE = 70000;
/** uids from here up are Ubuntu's subordinate ids (SUB_UID_MIN) for user namespaces; branches stay below. */
export const UID_LIMIT = 100000;
export const DEFAULT_UID_BASE = MIN_UID_BASE;
export const DEFAULT_TUNNEL_PORT_BASE = 7101;
const TUNNEL_PORT_LIMIT = 65536;
/** How long a mutating command waits for another one to release control/LOCK. */
export const LOCK_TIMEOUT_MS = 30_000;

export type BranchPhase = "provisioning" | "ready" | "deleting" | "deleted";
export type DesiredState = "running" | "stopped";
export type ReleaseStatus = "staged" | "preflight" | "live" | "failed" | "superseded" | "interrupted";

export interface BranchRow {
  id: string;
  project: string;
  name: string;
  kind: BranchKind;
  protected: number;
  label: string;
  os_uid: number;
  tunnel_port: number;
  phase: BranchPhase;
  desired_state: DesiredState;
  release_seq: number | null;
  runtime_version: string;
  busy_unit: string | null;
  s3_prefix: string;
  limits_json: string;
  config_json: string;
  copied_from_branch_id: string | null;
  created_at: number;
  updated_at: number;
  /** INCIBASE_GENERATION of the process the unit runs: `<seq>.<nonce>`, new for every start the host asks for. */
  generation: string | null;
}

export interface ReleaseRow {
  branch_id: string;
  seq: number;
  sha256: string;
  bytes: number;
  manifest_json: string;
  status: ReleaseStatus;
  /** Whether this release runs a preflight before it goes live. */
  preflight: number;
  allow_field_removal: number;
  snapshot: string | null;
  generation: string | null;
  preflight_ms: number | null;
  migration_committed: number | null;
  exit_code: number | null;
  error: string | null;
  origin: string;
  created_at: number;
  finished_at: number | null;
  /** When its files were removed (beyond the last 5); the row stays. */
  pruned_at: number | null;
}

export interface AlertRow {
  key: string;
  state: string;
  since: number;
  notified_at: number | null;
  message: string | null;
}

export interface ProjectRow {
  slug: string;
  name: string;
  created_at: number;
}

export interface EnvRow {
  branch_id: string;
  name: string;
  value: string;
  system: number;
}

export interface ServiceKeyRow {
  id: string;
  branch_id: string;
  sha256: string;
  scopes: string;
  label: string;
  created_at: number;
  revoked_at: number | null;
}

/** An installed runtime: `<runtime root>/<version>/incibase`, checked against its sha256 when it was installed. */
export interface RuntimeRow {
  version: string;
  sha256: string;
  bytes: number;
  /** Where it came from: `file:<path>` or the download URL. */
  source: string;
  /** What `incibase --version` printed (differs from `version` only when the check was skipped). */
  reported: string;
  installed_at: number;
}

export interface AuditEntry {
  actor: string;
  action: string;
  branchId?: string | null;
  /** Never secret values. */
  detail?: unknown;
  ok: boolean;
}

type BranchPatchKey = "desired_state" | "release_seq" | "runtime_version" | "busy_unit" | "limits_json" | "config_json" | "generation" | "protected";
const BRANCH_PATCH_KEYS: readonly BranchPatchKey[] = [
  "desired_state",
  "release_seq",
  "runtime_version",
  "busy_unit",
  "limits_json",
  "config_json",
  "generation",
  "protected",
];
const RELEASE_COLUMNS = new Set([
  "bytes",
  "manifest_json",
  "status",
  "preflight",
  "allow_field_removal",
  "snapshot",
  "generation",
  "preflight_ms",
  "migration_committed",
  "exit_code",
  "error",
  "finished_at",
  "pruned_at",
]);

/** Schema migrations; `PRAGMA user_version` is the number applied. Never edit a released one: add the next. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE projects (slug TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE branches (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL REFERENCES projects(slug),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('prod', 'dev', 'preview')),
    protected INTEGER NOT NULL,
    label TEXT NOT NULL CHECK (length(label) <= 63),
    os_uid INTEGER NOT NULL UNIQUE CHECK (os_uid >= ${MIN_UID_BASE} AND os_uid < ${UID_LIMIT}),
    tunnel_port INTEGER NOT NULL UNIQUE,
    phase TEXT NOT NULL CHECK (phase IN ('provisioning', 'ready', 'deleting', 'deleted')),
    desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
    release_seq INTEGER,
    runtime_version TEXT NOT NULL,
    busy_unit TEXT,
    s3_prefix TEXT NOT NULL UNIQUE,
    limits_json TEXT NOT NULL,
    config_json TEXT NOT NULL,
    copied_from_branch_id TEXT REFERENCES branches(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    generation TEXT
  );
  CREATE UNIQUE INDEX branches_live_label ON branches(label) WHERE phase <> 'deleted';
  CREATE TABLE releases (
    branch_id TEXT NOT NULL REFERENCES branches(id),
    seq INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    manifest_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('staged', 'preflight', 'live', 'failed', 'superseded', 'interrupted')),
    preflight INTEGER NOT NULL,
    allow_field_removal INTEGER NOT NULL DEFAULT 0,
    snapshot TEXT,
    generation TEXT,
    preflight_ms INTEGER,
    migration_committed INTEGER,
    exit_code INTEGER,
    error TEXT,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    pruned_at INTEGER,
    PRIMARY KEY (branch_id, seq)
  );
  CREATE TABLE env (
    branch_id TEXT NOT NULL REFERENCES branches(id),
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    system INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (branch_id, name)
  );
  CREATE TABLE service_keys (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id),
    sha256 TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL DEFAULT 'internal',
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE alerts (key TEXT PRIMARY KEY, state TEXT NOT NULL, since INTEGER NOT NULL, notified_at INTEGER, message TEXT);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    branch_id TEXT,
    detail_json TEXT,
    ok INTEGER NOT NULL
  );
  CREATE INDEX audit_by_branch ON audit_log(branch_id, at);
  `,
  // Step 14: the runtimes installed under the runtime root, with their checksums.
  `
  CREATE TABLE runtimes (
    version TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    bytes INTEGER NOT NULL,
    source TEXT NOT NULL,
    reported TEXT NOT NULL,
    installed_at INTEGER NOT NULL
  );
  `,
];

/** The newest registry schema this binary knows. */
export const REGISTRY_VERSION = MIGRATIONS.length;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

export class RegistryLockedError extends RegistryError {
  constructor(lock: string, waitedMs: number) {
    super(`Another incibase host command holds ${lock}; gave up after ${Math.round(waitedMs / 1000)} s. Try again when it has finished.`);
    this.name = "RegistryLockedError";
  }
}

/** Who runs a command, for the audit log: `root:<SUDO_USER>` under sudo. */
export function currentActor(env: Record<string, string | undefined> = process.env): string {
  const user = env.SUDO_USER;
  return user && /^[a-z_][a-z0-9_-]{0,31}\$?$/i.test(user) ? `root:${user}` : "root";
}

export interface InitSettings {
  /** The first branch uid; ignored once the registry has one. */
  uidBase?: number;
  tunnelPortBase?: number;
  domain?: string;
  timezone?: string;
  /** Bytes the slice of all branches may use (incibase.slice MemoryMax). */
  sliceMemoryMax?: number;
}

export class Registry {
  readonly db: Database;
  /** How long withLock waits for another command by default. */
  lockTimeoutMs = LOCK_TIMEOUT_MS;
  private lock: DataDirLock | null = null;
  private lockDepth = 0;

  private constructor(
    readonly layout: HostLayout,
    db: Database,
  ) {
    this.db = db;
  }

  /** Opens (creating it if needed) and migrates the registry. Migrations are idempotent. */
  static open(layout: HostLayout): Registry {
    if (!existsSync(layout.control)) mkdirSync(layout.control, { recursive: true, mode: 0o700 });
    chmodSync(layout.control, 0o700);
    // SQLite gives -wal and -shm the mode of the database file.
    if (!existsSync(layout.registry)) writeFileSync(layout.registry, "", { flag: "wx", mode: 0o600 });
    chmodSync(layout.registry, 0o600);
    const db = new Database(layout.registry, { create: true, strict: true });
    try {
      db.run("PRAGMA busy_timeout = 5000");
      db.run("PRAGMA journal_mode = WAL");
      db.run("PRAGMA synchronous = FULL");
      db.run("PRAGMA foreign_keys = ON");
      migrate(db, layout.registry);
    } catch (err) {
      db.close();
      throw err;
    }
    return new Registry(layout, db);
  }

  close() {
    this.db.close();
    this.releaseLock();
  }

  get version(): number {
    return userVersion(this.db);
  }

  /** Whether this process holds control/LOCK. */
  get locked(): boolean {
    return this.lockDepth > 0;
  }

  /**
   * Runs `fn` holding control/LOCK, waiting up to `timeoutMs` for another
   * command to release it. Re-entrant within this Registry.
   */
  async withLock<T>(fn: () => T | Promise<T>, { timeoutMs = this.lockTimeoutMs } = {}): Promise<T> {
    if (this.lockDepth === 0) {
      const started = Date.now();
      for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
        try {
          this.lock = new DataDirLock(this.layout.control);
          break;
        } catch (err) {
          if (!(err instanceof DataDirLockedError)) throw err;
          const waited = Date.now() - started;
          if (waited >= timeoutMs) throw new RegistryLockedError(this.layout.lock, waited);
          await Bun.sleep(Math.min(delay, timeoutMs - waited));
        }
      }
    }
    this.lockDepth++;
    try {
      return await fn();
    } finally {
      if (--this.lockDepth === 0) this.releaseLock();
    }
  }

  private releaseLock() {
    this.lock?.release();
    this.lock = null;
    this.lockDepth = 0;
  }

  /** A short IMMEDIATE transaction; changes need control/LOCK. */
  tx<T>(fn: () => T): T {
    if (!this.locked) throw new RegistryError("Registry changes need control/LOCK (use withLock)");
    return this.db.transaction(fn).immediate();
  }

  // ---- settings ----------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.query(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.tx(() => {
      if (key === "uid_next" || key === "tunnel_port_next" || key === "uid_base") {
        throw new RegistryError(`${key} only grows through allocation`);
      }
      if (key === "layout") throw new RegistryError("The layout is fixed when the host is initialized");
      if (key === "domain" && this.getSetting("domain") !== value && this.countBranches() > 0) {
        throw new RegistryError("The domain is fixed once a branch exists: its hostnames and cookies depend on it");
      }
      this.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, value]);
    });
  }

  /** Removes an owner setting (such as alert_webhook); the ones `host init` fixes cannot be removed. */
  deleteSetting(key: string): boolean {
    if (["uid_next", "tunnel_port_next", "uid_base", "layout", "domain", "timezone"].includes(key)) throw new RegistryError(`${key} cannot be removed`);
    return this.tx(() => this.db.run(`DELETE FROM settings WHERE key = ?`, [key]).changes === 1);
  }

  /** Writes the settings a new host starts with; keys already set keep their value. */
  initSettings(init: InitSettings = {}) {
    const uidBase = init.uidBase ?? DEFAULT_UID_BASE;
    if (!Number.isInteger(uidBase) || uidBase < MIN_UID_BASE || uidBase >= UID_LIMIT) {
      throw new RegistryError(`The uid base must be an integer from ${MIN_UID_BASE} to ${UID_LIMIT - 1}, got ${uidBase}`);
    }
    const portBase = init.tunnelPortBase ?? DEFAULT_TUNNEL_PORT_BASE;
    if (!Number.isInteger(portBase) || portBase < 1024 || portBase >= TUNNEL_PORT_LIMIT) {
      throw new RegistryError(`The tunnel port base must be an integer from 1024 to ${TUNNEL_PORT_LIMIT - 1}, got ${portBase}`);
    }
    this.tx(() => {
      const put = this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`);
      put.run("uid_base", String(uidBase));
      put.run("uid_next", String(uidBase));
      put.run("tunnel_port_next", String(portBase));
      put.run("timezone", init.timezone ?? "UTC");
      if (init.domain !== undefined) put.run("domain", init.domain);
      if (init.sliceMemoryMax !== undefined) put.run("slice_memory_max", String(init.sliceMemoryMax));
      const saved = JSON.stringify(this.layout.saved());
      const current = this.getSetting("layout");
      if (current !== null && current !== saved) {
        throw new RegistryError(`This host was initialized with the layout ${current}; it cannot change to ${saved}`);
      }
      put.run("layout", saved);
    });
  }

  /** The layout options the host was initialized with, or null before `host init`. */
  savedLayout(): SavedLayout | null {
    const value = this.getSetting("layout");
    return value === null ? null : (JSON.parse(value) as SavedLayout);
  }

  private counter(key: string): number {
    const value = Number(this.getSetting(key));
    if (!Number.isInteger(value)) throw new RegistryError(`The registry has no ${key}: run \`incibase host init\` first`);
    return value;
  }

  /**
   * The next branch uid. Never one a branch ever had, deleted ones included:
   * a new branch must not find files a deleted one left behind.
   */
  allocateUid(): number {
    return this.tx(() => {
      const highest = (this.db.query(`SELECT max(os_uid) AS uid FROM branches`).get() as { uid: number | null }).uid;
      const uid = Math.max(this.counter("uid_next"), (highest ?? 0) + 1);
      if (uid >= UID_LIMIT) throw new RegistryError(`No branch uids left: the next would be ${uid}, and branches stay below ${UID_LIMIT}`);
      this.db.run(`UPDATE settings SET value = ? WHERE key = 'uid_next'`, [String(uid + 1)]);
      return uid;
    });
  }

  /** The next tunnel port (the laptop side of `incibase tunnel`), also never reused. */
  allocateTunnelPort(): number {
    return this.tx(() => {
      const highest = (this.db.query(`SELECT max(tunnel_port) AS port FROM branches`).get() as { port: number | null }).port;
      const port = Math.max(this.counter("tunnel_port_next"), (highest ?? 0) + 1);
      if (port >= TUNNEL_PORT_LIMIT) throw new RegistryError("No tunnel ports left");
      this.db.run(`UPDATE settings SET value = ? WHERE key = 'tunnel_port_next'`, [String(port + 1)]);
      return port;
    });
  }

  // ---- projects ----------------------------------------------------------

  insertProject(slug: string, name: string, at: number) {
    this.tx(() => this.db.run(`INSERT INTO projects (slug, name, created_at) VALUES (?, ?, ?)`, [slug, name, at]));
  }

  getProject(slug: string): ProjectRow | null {
    return this.db.query(`SELECT * FROM projects WHERE slug = ?`).get(slug) as ProjectRow | null;
  }

  listProjects(): ProjectRow[] {
    return this.db.query(`SELECT * FROM projects ORDER BY slug`).all() as ProjectRow[];
  }

  // ---- branches ----------------------------------------------------------

  insertBranch(row: BranchRow) {
    this.tx(() => {
      this.db
        .query(
          `INSERT INTO branches (id, project, name, kind, protected, label, os_uid, tunnel_port, phase, desired_state, release_seq,
           runtime_version, busy_unit, s3_prefix, limits_json, config_json, copied_from_branch_id, created_at, updated_at, generation)
         VALUES ($id, $project, $name, $kind, $protected, $label, $os_uid, $tunnel_port, $phase, $desired_state, $release_seq,
           $runtime_version, $busy_unit, $s3_prefix, $limits_json, $config_json, $copied_from_branch_id, $created_at, $updated_at, $generation)`,
        )
        .run(row as unknown as Record<string, string | number | null>);
    });
  }

  getBranch(id: string): BranchRow | null {
    return this.db.query(`SELECT * FROM branches WHERE id = ?`).get(id) as BranchRow | null;
  }

  /** The branch `project/name` that is not deleted. */
  findBranch(project: string, name: string): BranchRow | null {
    return this.db.query(`SELECT * FROM branches WHERE project = ? AND name = ? AND phase <> 'deleted'`).get(project, name) as BranchRow | null;
  }

  listBranches(filter: { phase?: BranchPhase | BranchPhase[]; project?: string } = {}): BranchRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.phase !== undefined) {
      const phases = Array.isArray(filter.phase) ? filter.phase : [filter.phase];
      where.push(`phase IN (${phases.map(() => "?").join(", ")})`);
      params.push(...phases);
    }
    if (filter.project !== undefined) {
      where.push("project = ?");
      params.push(filter.project);
    }
    const sql = `SELECT * FROM branches${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY project, name, created_at`;
    return this.db.query(sql).all(...params) as BranchRow[];
  }

  private countBranches(): number {
    return (this.db.query(`SELECT count(*) AS n FROM branches WHERE phase <> 'deleted'`).get() as { n: number }).n;
  }

  /** Moves a branch from one phase to the next; false when it was not in `from` (someone else moved it). */
  setPhase(id: string, from: BranchPhase | BranchPhase[], to: BranchPhase, at: number): boolean {
    const phases = Array.isArray(from) ? from : [from];
    return this.tx(() => {
      const result = this.db.run(
        `UPDATE branches SET phase = ?, updated_at = ? WHERE id = ? AND phase IN (${phases.map(() => "?").join(", ")})`,
        [to, at, id, ...phases],
      );
      return result.changes === 1;
    });
  }

  /** Changes some of a branch's columns; updated_at follows. */
  updateBranch(id: string, patch: Partial<Pick<BranchRow, BranchPatchKey>>, at: number) {
    const keys = Object.keys(patch) as BranchPatchKey[];
    for (const key of keys) if (!BRANCH_PATCH_KEYS.includes(key)) throw new RegistryError(`Cannot change ${key}`);
    this.tx(() => {
      const sets = keys.map((k) => `${k} = $${k}`).join(", ");
      const result = this.db
        .query(`UPDATE branches SET ${sets}${sets ? ", " : ""}updated_at = $updated_at WHERE id = $id`)
        .run({ ...(patch as Record<string, string | number | null>), updated_at: at, id });
      if (result.changes !== 1) throw new RegistryError(`No branch ${id}`);
    });
  }

  /**
   * Marks a ready branch busy with a long operation (a release job), unless
   * it already is: then null. Every op that changes the branch refuses while
   * `busy_unit` is set.
   */
  claimBusy(id: string, unit: string, at: number): boolean {
    return this.tx(
      () => this.db.run(`UPDATE branches SET busy_unit = ?, updated_at = ? WHERE id = ? AND phase = 'ready' AND busy_unit IS NULL`, [unit, at, id]).changes === 1,
    );
  }

  /** Clears `busy_unit` if it is still `unit`. */
  releaseBusy(id: string, unit: string, at: number): boolean {
    return this.tx(() => this.db.run(`UPDATE branches SET busy_unit = NULL, updated_at = ? WHERE id = ? AND busy_unit = ?`, [at, id, unit]).changes === 1);
  }

  // ---- releases ------------------------------------------------------------

  insertRelease(row: ReleaseRow) {
    this.tx(() => {
      this.db
        .query(
          `INSERT INTO releases (branch_id, seq, sha256, bytes, manifest_json, status, preflight, allow_field_removal, snapshot, generation,
             preflight_ms, migration_committed, exit_code, error, origin, created_at, finished_at, pruned_at)
           VALUES ($branch_id, $seq, $sha256, $bytes, $manifest_json, $status, $preflight, $allow_field_removal, $snapshot, $generation,
             $preflight_ms, $migration_committed, $exit_code, $error, $origin, $created_at, $finished_at, $pruned_at)`,
        )
        .run(row as unknown as Record<string, string | number | null>);
    });
  }

  getRelease(branchId: string, seq: number): ReleaseRow | null {
    return this.db.query(`SELECT * FROM releases WHERE branch_id = ? AND seq = ?`).get(branchId, seq) as ReleaseRow | null;
  }

  /** Newest first. */
  listReleases(branchId: string): ReleaseRow[] {
    return this.db.query(`SELECT * FROM releases WHERE branch_id = ? ORDER BY seq DESC`).all(branchId) as ReleaseRow[];
  }

  /** The next release number; numbers are never reused. */
  nextReleaseSeq(branchId: string): number {
    const row = this.db.query(`SELECT max(seq) AS seq FROM releases WHERE branch_id = ?`).get(branchId) as { seq: number | null };
    return (row.seq ?? 0) + 1;
  }

  updateRelease(branchId: string, seq: number, patch: Partial<Omit<ReleaseRow, "branch_id" | "seq" | "sha256" | "origin" | "created_at">>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    for (const key of keys) if (!/^[a-z_0-9]+$/.test(key) || !RELEASE_COLUMNS.has(key)) throw new RegistryError(`Cannot change ${key}`);
    this.tx(() => {
      const result = this.db
        .query(`UPDATE releases SET ${keys.map((k) => `${k} = $${k}`).join(", ")} WHERE branch_id = $branch_id AND seq = $seq`)
        .run({ ...(patch as Record<string, string | number | null>), branch_id: branchId, seq });
      if (result.changes !== 1) throw new RegistryError(`No release ${branchId}#${seq}`);
    });
  }

  // ---- alerts --------------------------------------------------------------

  raiseAlert(key: string, message: string, at: number) {
    this.tx(() =>
      this.db.run(
        `INSERT INTO alerts (key, state, since, notified_at, message) VALUES (?, 'firing', ?, NULL, ?)
         ON CONFLICT (key) DO UPDATE SET message = excluded.message,
           since = CASE WHEN alerts.state = 'firing' THEN alerts.since ELSE excluded.since END,
           notified_at = CASE WHEN alerts.state = 'firing' THEN alerts.notified_at ELSE NULL END, state = 'firing'`,
        [key, at, message],
      ),
    );
  }

  resolveAlert(key: string, at: number) {
    this.tx(() => this.db.run(`UPDATE alerts SET state = 'resolved', since = ? WHERE key = ? AND state = 'firing'`, [at, key]));
  }

  /**
   * After the owner was told: a firing alert gets `notified_at`, a resolved
   * one becomes 'closed'. Only when the row is still the episode that was
   * sent (same state and `since`); false otherwise. An open that went out
   * while the episode resolved (resolving moves `since`) still marks it, so
   * its resolve is sent too instead of the row closing silently.
   */
  markAlertNotified(key: string, state: "firing" | "resolved", since: number, at: number): boolean {
    return this.tx(() => {
      if (state === "resolved") {
        return this.db.run(`UPDATE alerts SET state = 'closed', notified_at = ? WHERE key = ? AND state = 'resolved' AND since = ?`, [at, key, since]).changes === 1;
      }
      if (this.db.run(`UPDATE alerts SET notified_at = ? WHERE key = ? AND state = 'firing' AND since = ?`, [at, key, since]).changes === 1) return true;
      return this.db.run(`UPDATE alerts SET notified_at = ? WHERE key = ? AND state = 'resolved' AND notified_at IS NULL AND since >= ?`, [at, key, since]).changes === 1;
    });
  }

  listAlerts(state?: string): AlertRow[] {
    return (
      state === undefined ? this.db.query(`SELECT * FROM alerts ORDER BY key`).all() : this.db.query(`SELECT * FROM alerts WHERE state = ? ORDER BY key`).all(state)
    ) as AlertRow[];
  }

  // ---- env, service keys -------------------------------------------------

  setEnv(branchId: string, name: string, value: string, system: boolean) {
    this.tx(() =>
      this.db.run(
        `INSERT INTO env (branch_id, name, value, system) VALUES (?, ?, ?, ?)
         ON CONFLICT (branch_id, name) DO UPDATE SET value = excluded.value, system = excluded.system`,
        [branchId, name, value, system ? 1 : 0],
      ),
    );
  }

  listEnv(branchId: string): EnvRow[] {
    return this.db.query(`SELECT * FROM env WHERE branch_id = ? ORDER BY system DESC, name`).all(branchId) as EnvRow[];
  }

  getEnv(branchId: string, name: string): EnvRow | null {
    return this.db.query(`SELECT * FROM env WHERE branch_id = ? AND name = ?`).get(branchId, name) as EnvRow | null;
  }

  /** Removes an app env row; system rows stay. */
  deleteEnv(branchId: string, name: string): boolean {
    return this.tx(() => this.db.run(`DELETE FROM env WHERE branch_id = ? AND name = ? AND system = 0`, [branchId, name]).changes === 1);
  }

  /** Branches (not deleted) whose env has `name` = `value`. */
  branchesWithEnv(name: string, value: string): string[] {
    return (
      this.db
        .query(`SELECT e.branch_id AS id FROM env e JOIN branches b ON b.id = e.branch_id WHERE e.name = ? AND e.value = ? AND b.phase <> 'deleted'`)
        .all(name, value) as { id: string }[]
    ).map((r) => r.id);
  }

  listServiceKeys(branchId: string): ServiceKeyRow[] {
    return this.db.query(`SELECT * FROM service_keys WHERE branch_id = ? ORDER BY id`).all(branchId) as ServiceKeyRow[];
  }

  getServiceKey(id: string): ServiceKeyRow | null {
    return this.db.query(`SELECT * FROM service_keys WHERE id = ?`).get(id) as ServiceKeyRow | null;
  }

  insertServiceKey(row: ServiceKeyRow) {
    this.tx(() =>
      this.db.run(`INSERT INTO service_keys (id, branch_id, sha256, scopes, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
        row.id,
        row.branch_id,
        row.sha256,
        row.scopes,
        row.label,
        row.created_at,
        row.revoked_at,
      ]),
    );
  }

  revokeServiceKey(id: string, at: number): boolean {
    return this.tx(() => this.db.run(`UPDATE service_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [at, id]).changes === 1);
  }

  // ---- runtimes ----------------------------------------------------------

  getRuntime(version: string): RuntimeRow | null {
    return this.db.query(`SELECT * FROM runtimes WHERE version = ?`).get(version) as RuntimeRow | null;
  }

  listRuntimes(): RuntimeRow[] {
    return this.db.query(`SELECT * FROM runtimes ORDER BY installed_at, version`).all() as RuntimeRow[];
  }

  /** Records an installed runtime (replacing the row of a reinstall). */
  putRuntime(row: RuntimeRow) {
    this.tx(() =>
      this.db
        .query(
          `INSERT INTO runtimes (version, sha256, bytes, source, reported, installed_at) VALUES ($version, $sha256, $bytes, $source, $reported, $installed_at)
           ON CONFLICT (version) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes, source = excluded.source,
             reported = excluded.reported, installed_at = excluded.installed_at`,
        )
        .run(row as unknown as Record<string, string | number>),
    );
  }

  deleteRuntime(version: string): boolean {
    return this.tx(() => this.db.run(`DELETE FROM runtimes WHERE version = ?`, [version]).changes === 1);
  }

  /** The runtime versions branches that are not deleted pin, with the branches (`project/name`). */
  pinnedRuntimes(): Map<string, string[]> {
    const rows = this.db.query(`SELECT runtime_version, project, name FROM branches WHERE phase <> 'deleted' ORDER BY project, name`).all() as {
      runtime_version: string;
      project: string;
      name: string;
    }[];
    const pinned = new Map<string, string[]>();
    for (const row of rows) pinned.set(row.runtime_version, [...(pinned.get(row.runtime_version) ?? []), `${row.project}/${row.name}`]);
    return pinned;
  }

  // ---- audit -------------------------------------------------------------

  audit(entry: AuditEntry, at: number) {
    this.tx(() =>
      this.db.run(`INSERT INTO audit_log (at, actor, action, branch_id, detail_json, ok) VALUES (?, ?, ?, ?, ?, ?)`, [
        at,
        entry.actor,
        entry.action,
        entry.branchId ?? null,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
        entry.ok ? 1 : 0,
      ]),
    );
  }

  listAudit(branchId?: string): { id: number; at: number; actor: string; action: string; branch_id: string | null; detail_json: string | null; ok: number }[] {
    return (
      branchId === undefined
        ? this.db.query(`SELECT * FROM audit_log ORDER BY id`).all()
        : this.db.query(`SELECT * FROM audit_log WHERE branch_id = ? ORDER BY id`).all(branchId)
    ) as never;
  }
}

function userVersion(db: Database): number {
  return (db.query(`PRAGMA user_version`).get() as { user_version: number }).user_version;
}

function migrate(db: Database, path: string) {
  const apply = db.transaction(() => {
    // Read again inside the write transaction: another process may have migrated meanwhile.
    const current = userVersion(db);
    if (current > MIGRATIONS.length) {
      throw new RegistryError(
        `${path} has registry version ${current}; this incibase supports up to ${MIGRATIONS.length}. A newer incibase has used it: run that version.`,
      );
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.run(MIGRATIONS[v]!);
      db.run(`PRAGMA user_version = ${v + 1}`);
    }
  });
  if (userVersion(db) === MIGRATIONS.length) return;
  apply.immediate();
}
