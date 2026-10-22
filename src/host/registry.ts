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
import type { HostLayout } from "./layout.ts";
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

export interface AuditEntry {
  actor: string;
  action: string;
  branchId?: string | null;
  /** Never secret values. */
  detail?: unknown;
  ok: boolean;
}

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
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX branches_live_label ON branches(label) WHERE phase <> 'deleted';
  CREATE TABLE releases (
    branch_id TEXT NOT NULL REFERENCES branches(id),
    seq INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('staged', 'preflight', 'live', 'failed', 'superseded', 'interrupted')),
    snapshot TEXT,
    migration_committed INTEGER,
    exit_code INTEGER,
    error TEXT,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL,
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
  CREATE TABLE alerts (key TEXT PRIMARY KEY, state TEXT NOT NULL, since INTEGER NOT NULL, notified_at INTEGER);
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
}

export class Registry {
  readonly db: Database;
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
  async withLock<T>(fn: () => T | Promise<T>, { timeoutMs = LOCK_TIMEOUT_MS } = {}): Promise<T> {
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
      if (key === "domain" && this.getSetting("domain") !== value && this.countBranches() > 0) {
        throw new RegistryError("The domain is fixed once a branch exists: its hostnames and cookies depend on it");
      }
      this.db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, value]);
    });
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
    });
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
           runtime_version, busy_unit, s3_prefix, limits_json, config_json, copied_from_branch_id, created_at, updated_at)
         VALUES ($id, $project, $name, $kind, $protected, $label, $os_uid, $tunnel_port, $phase, $desired_state, $release_seq,
           $runtime_version, $busy_unit, $s3_prefix, $limits_json, $config_json, $copied_from_branch_id, $created_at, $updated_at)`,
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

  listServiceKeys(branchId: string): ServiceKeyRow[] {
    return this.db.query(`SELECT * FROM service_keys WHERE branch_id = ? ORDER BY id`).all(branchId) as ServiceKeyRow[];
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
