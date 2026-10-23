// A Driver for tests without systemd. It reads the unit files the host
// rendered (the template must exist; a branch needs an ExecStart in its
// drop-in) and plays what the process would do: `behavior` decides, per
// start, whether it serves, exits with a code, runs out of memory, logs
// migration_committed or keeps crashing until the start limit. `health`
// answers the gate's probe for the generation a healthy process runs. A
// snapshot unit really copies (`snapshot`, by default the `_snapshot`
// command in this process), and with a FakeSystem its file is recorded as
// the branch user's, as systemd's User= would make it.
import { existsSync, readFileSync } from "node:fs";
import { CLD_EXITED, CLD_KILLED, type Driver, type JournalEntry, type JournalQuery, type KillSignal, type TransientJob, type UnitStatus } from "./driver.ts";
import type { FakeSystem } from "./fake-system.ts";
import type { HostLayout } from "./layout.ts";
import { SNAPSHOT_EXIT, SnapshotCommandError, takeSnapshot } from "./snapshot-command.ts";
import { checkUnitName } from "./systemd.ts";

/** One start of a unit, as the rendered files describe it. */
export interface FakeRun {
  unit: string;
  kind: "branch" | "preflight" | "snapshot" | "other";
  id: string | null;
  /** The command's words (ExecStart). */
  argv: string[];
  /** User= of the drop-in. */
  user: string | null;
  bundle: string | null;
  runtime: string | null;
  generation: string | null;
}

export interface FakeOutcome {
  /** Exit with this code right away (64, 65 and 78 are not restarted; others are, until the start limit). */
  exit?: number;
  /** Killed by the OOM killer. */
  oom?: boolean;
  /** Logs `{ev:"migration_committed"}` before what follows. */
  migrationCommitted?: boolean;
  /** Runs, but never answers the health probe. */
  hang?: boolean;
}

interface FakeUnit {
  status: UnitStatus;
  run: FakeRun | null;
  healthy: boolean;
  serviceKeysSha256: string | null;
}

const idle = (): UnitStatus => ({
  loadState: "loaded",
  activeState: "inactive",
  subState: "dead",
  result: "success",
  mainPid: 0,
  execMainCode: 0,
  execMainStatus: 0,
  nRestarts: 0,
  memoryCurrent: null,
  invocationId: "",
});

export class FakeDriver implements Driver {
  /** Every call, e.g. `restart incibase-branch@b1234567.service`. */
  readonly calls: string[] = [];
  readonly entries: (JournalEntry & { unit: string })[] = [];
  /** What a start does; by default every process serves. */
  behavior: (run: FakeRun) => FakeOutcome = () => ({});
  /** Runs a transient job; its unit is active until the promise settles. */
  onTransient: ((job: TransientJob) => Promise<unknown>) | null = null;
  /** What a snapshot unit's process does when `behavior` lets it run; returns its exit code. */
  snapshot: (run: FakeRun) => number = (run) => this.copySnapshot(run);
  private readonly units = new Map<string, FakeUnit>();
  private nextPid = 1000;
  private nextCursor = 1;
  private nextInvocation = 1;

  constructor(
    readonly layout: HostLayout,
    readonly sys: FakeSystem | null = null,
  ) {}

  /** `_snapshot --data … --out …` in this process; the file it leaves is the unit user's. */
  copySnapshot(run: FakeRun): number {
    const flag = (f: string) => (run.argv.includes(f) ? run.argv[run.argv.indexOf(f) + 1]! : "");
    const out = flag("--out");
    try {
      takeSnapshot(flag("--data"), out);
    } catch (err) {
      this.log(run.unit, (err as Error).message);
      return err instanceof SnapshotCommandError ? err.exitCode : SNAPSHOT_EXIT.FAILED;
    }
    const uid = run.user ? this.sys?.getpwnam(run.user)?.uid : undefined;
    if (uid !== undefined) this.sys!.own(out, uid, uid, 0o600);
    return SNAPSHOT_EXIT.OK;
  }

  private unit(name: string): FakeUnit {
    let unit = this.units.get(checkUnitName(name));
    if (!unit) this.units.set(name, (unit = { status: idle(), run: null, healthy: false, serviceKeysSha256: null }));
    return unit;
  }

  private templateOf(name: string): string | null {
    const at = name.indexOf("@");
    return at < 0 ? null : `${name.slice(0, at + 1)}${name.slice(name.lastIndexOf("."))}`;
  }

  /** Whether systemd would find the unit: its own file, or its template's. */
  private loaded(name: string): boolean {
    const template = this.templateOf(name);
    return existsSync(this.layout.unitFile(name)) || (template !== null && existsSync(this.layout.unitFile(template)));
  }

  /** Logs a line as the unit's process would. */
  log(unit: string, message: string, invocationId = this.unit(unit).status.invocationId || "fake") {
    this.entries.push({ unit, message, invocationId, cursor: `c${this.nextCursor++}`, time: Date.now() * 1000 });
  }

  private describe(name: string): FakeRun {
    const units = this.layout.units;
    const match = /@([a-z0-9]+)\.service$/.exec(name);
    const id = match ? match[1]! : null;
    const kind = id && name === units.branch(id) ? "branch" : id && name === units.preflight(id) ? "preflight" : id && name === units.snapshot(id) ? "snapshot" : "other";
    const path = this.layout.dropIn(name);
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const exec = [...text.matchAll(/^ExecStart=(.*)$/gm)].map((m) => m[1]!).filter(Boolean).pop() ?? "";
    const argv = exec ? exec.split(" ") : [];
    const flag = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1]! : null);
    const runtime = argv[0] ? (/\/([^/]+)\/incibase$/.exec(argv[0])?.[1] ?? null) : null;
    const generation = /^Environment=INCIBASE_GENERATION=(\S+)$/m.exec(text)?.[1] ?? null;
    const user = /^User=(\S+)$/m.exec(text)?.[1] ?? null;
    return { unit: name, kind, id, argv, user, bundle: flag("--bundle"), runtime, generation };
  }

  private launch(name: string) {
    if (!this.loaded(name)) throw new Error(`Unit ${name} not found.`);
    const unit = this.unit(name);
    const run = this.describe(name);
    if (run.kind !== "other" && !run.argv.length) throw new Error(`Unit ${name} has a bad unit file setting (no ExecStart).`);
    let outcome = this.behavior(run);
    if (run.kind === "snapshot" && outcome.exit === undefined && !outcome.oom && !outcome.hang) outcome = { ...outcome, exit: this.snapshot(run) };
    // A new id for every start, as systemd gives (the host's check tells processes apart by it).
    const invocationId = `inv${this.nextInvocation++}`;
    unit.run = run;
    unit.healthy = false;
    unit.status = { ...idle(), invocationId, nRestarts: 0 };
    if (outcome.migrationCommitted) this.log(name, JSON.stringify({ t: new Date().toISOString(), level: "info", ev: "migration_committed" }), invocationId);
    if (outcome.oom) {
      unit.status = { ...unit.status, activeState: "failed", subState: "failed", result: "oom-kill", execMainCode: CLD_KILLED, execMainStatus: 9 };
    } else if (outcome.exit !== undefined && outcome.exit !== 0) {
      const prevented = [64, 65, 78].includes(outcome.exit) || run.kind !== "branch";
      unit.status = {
        ...unit.status,
        activeState: "failed",
        subState: "failed",
        result: prevented ? "exit-code" : "start-limit-hit",
        execMainCode: CLD_EXITED,
        execMainStatus: outcome.exit,
        nRestarts: prevented ? 0 : 7,
      };
    } else if (run.kind === "preflight" || (run.kind === "snapshot" && !outcome.hang) || outcome.exit === 0) {
      // As systemd 255 shows it once deactivated: no exec status left.
      unit.status = { ...unit.status, activeState: "inactive", subState: "dead", result: "success", execMainCode: 0, execMainStatus: 0 };
    } else {
      unit.status = { ...unit.status, activeState: "active", subState: "running", mainPid: this.nextPid++, memoryCurrent: 50 * 1024 * 1024 };
      unit.healthy = !outcome.hang;
      if (run.kind === "branch" && run.id) unit.serviceKeysSha256 = this.serviceKeysSha256(run.id);
    }
  }

  private serviceKeysSha256(id: string): string | null {
    const path = this.layout.branch(id).serviceKeys;
    return existsSync(path) ? new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex") : null;
  }

  daemonReload() {
    this.calls.push("daemon-reload");
  }

  start(name: string) {
    this.calls.push(`start ${name}`);
    if (this.unit(name).status.activeState === "active") return;
    if (this.unit(name).status.result === "start-limit-hit") throw new Error(`Start request repeated too quickly for ${name}`);
    this.launch(name);
  }

  stop(name: string) {
    this.calls.push(`stop ${name}`);
    const unit = this.unit(name);
    if (unit.status.activeState === "active") unit.status = { ...unit.status, activeState: "inactive", subState: "dead", mainPid: 0, memoryCurrent: null };
    unit.healthy = false;
  }

  restart(name: string) {
    this.calls.push(`restart ${name}`);
    if (this.unit(name).status.result === "start-limit-hit") throw new Error(`Start request repeated too quickly for ${name}`);
    this.launch(name);
  }

  reload(name: string) {
    this.calls.push(`reload ${name}`);
    const unit = this.unit(name);
    if (unit.status.activeState !== "active") throw new Error(`Unit ${name} cannot be reloaded because it is inactive.`);
    if (unit.run?.id) unit.serviceKeysSha256 = this.serviceKeysSha256(unit.run.id);
  }

  resetFailed(name: string) {
    this.calls.push(`reset-failed ${name}`);
    const unit = this.unit(name);
    if (unit.status.activeState === "failed") unit.status = { ...unit.status, activeState: "inactive", subState: "dead", result: "success" };
  }

  /** SIGKILL: the process dies and systemd (Restart=on-failure) starts it again; SIGTERM: it drains and exits cleanly. */
  killMain(name: string, signal: KillSignal) {
    this.calls.push(`kill ${signal} ${name}`);
    const unit = this.unit(name);
    if (unit.status.activeState !== "active") throw new Error(`Failed to kill unit ${name}: No main process to kill`);
    if (signal === "SIGTERM") {
      unit.status = { ...unit.status, activeState: "inactive", subState: "dead", mainPid: 0, memoryCurrent: null };
      unit.healthy = false;
      return;
    }
    const restarts = unit.status.nRestarts + 1;
    this.launch(name);
    unit.status = { ...unit.status, nRestarts: restarts };
  }

  show(name: string): UnitStatus {
    const unit = this.units.get(checkUnitName(name));
    if (!unit) return this.loaded(name) ? idle() : { ...idle(), loadState: "not-found" };
    return { ...unit.status };
  }

  isActive(name: string): boolean {
    return this.units.get(name)?.status.activeState === "active";
  }

  runTransient(job: TransientJob) {
    this.calls.push(`run ${job.unit} ${job.argv.join(" ")}`);
    const unit = this.unit(job.unit);
    if (unit.status.activeState === "active") throw new Error(`Unit ${job.unit} was already loaded or has a fragment file.`);
    unit.status = { ...idle(), activeState: "active", subState: "running", invocationId: `job${this.nextCursor}` };
    const done = () => {
      // --collect: a finished transient unit is gone.
      this.units.delete(job.unit);
    };
    void (this.onTransient ? this.onTransient(job) : Promise.resolve()).then(done, (err) => {
      done();
      this.log(job.unit, `job failed: ${(err as Error).message}`);
    });
  }

  journal(query: JournalQuery): JournalEntry[] {
    let entries = this.entries.filter((e) => e.unit === query.unit);
    if (query.afterCursor !== undefined) {
      const after = Number(query.afterCursor.slice(1));
      entries = entries.filter((e) => Number(e.cursor.slice(1)) > after);
    }
    if (query.grep !== undefined) {
      const re = new RegExp(query.grep);
      entries = entries.filter((e) => re.test(e.message));
    }
    if (query.lines !== undefined) entries = entries.slice(-query.lines);
    return entries.map(({ unit: _unit, ...e }) => e);
  }

  journalCursor(): string | null {
    return this.nextCursor > 1 ? `c${this.nextCursor - 1}` : null;
  }

  syncJournal() {
    this.calls.push("sync-journal");
  }

  journalCommand(query: { unit: string; follow?: boolean; lines?: number; since?: string; json?: boolean; grep?: string }): string[] {
    return [
      "journalctl",
      "--unit",
      query.unit,
      ...(query.json ? ["--output", "json"] : []),
      ...(query.lines !== undefined ? ["--lines", String(query.lines)] : []),
      ...(query.since !== undefined ? ["--since", query.since] : []),
      ...(query.grep !== undefined ? ["--grep", query.grep] : []),
      ...(query.follow ? ["--follow"] : []),
    ];
  }

  /** The admin socket's /api/health of the branch whose socket this is, when its process serves. */
  async health(socket: string): Promise<{ generation: string | null; serviceKeys?: { sha256: string | null } } | null> {
    for (const unit of this.units.values()) {
      if (unit.run?.kind !== "branch" || !unit.run.id || unit.status.activeState !== "active" || !unit.healthy) continue;
      if (this.layout.branch(unit.run.id).adminSock !== socket) continue;
      return { generation: unit.run.generation, serviceKeys: { sha256: unit.serviceKeysSha256 } };
    }
    return null;
  }
}
