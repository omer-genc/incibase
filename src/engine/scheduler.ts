import { getFunctionPath } from "../api.ts";
import { IncibaseError } from "../errors.ts";
import type { CronJob } from "../server.ts";
import type { DbSession } from "./database.ts";
import type { Engine, Identity } from "./engine.ts";
import { quoteIdent, rowToDoc, type DocumentRow } from "./store.ts";

const SYSTEM_IDENTITY: Identity = { userId: null, admin: false };
const MAX_TIMEOUT = 2 ** 31 - 1;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT = 8;

interface ScheduledDoc {
  _id: string;
  name: string;
  args: Record<string, unknown>;
  runAt: number;
  state: string;
}

/**
 * Runs `_scheduled` jobs (from ctx.scheduler) and cron jobs (from crons.ts).
 * Scheduling inside a mutation is part of its transaction.
 */
export class Scheduler {
  private timer: Timer | null = null;
  private cronTimers: Timer[] = [];
  private pruneTimer: Timer | null = null;
  private running = 0;
  private stopped = true;

  constructor(private readonly engine: Engine) {}

  start() {
    this.stopped = false;
    // Jobs left "running" by a crash never finished; mark them failed rather than run twice.
    void this.engine.writeTx((session) => {
      for (const job of this.jobsInState(session, "running", 10_000)) {
        this.update(session, job, { state: "failed", completedAt: Date.now(), error: "Interrupted by server restart" });
      }
    });
    for (const job of this.engine.crons?.jobs ?? []) this.startCron(job);
    this.pruneTimer = setInterval(() => void this.prune(), 60 * 60 * 1000);
    this.poke();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    for (const t of this.cronTimers) clearTimeout(t);
    this.cronTimers = [];
  }

  private table() {
    return this.engine.store.tables.get("_scheduled")!;
  }

  private jobsInState(session: DbSession, state: string, limit: number, dueBefore = Infinity): ScheduledDoc[] {
    const rows = session.conn
      .query(
        `SELECT _id, _creationTime, data FROM _scheduled
         WHERE json_extract(data, '$.state') = ? AND json_extract(data, '$.runAt') <= ?
         ORDER BY json_extract(data, '$.state'), json_extract(data, '$.runAt'), _creationTime, _id LIMIT ?`,
      )
      .all(state, Number.isFinite(dueBefore) ? dueBefore : Number.MAX_VALUE, limit) as DocumentRow[];
    return rows.map((r) => rowToDoc(r) as unknown as ScheduledDoc);
  }

  private update(session: DbSession, job: ScheduledDoc, patch: Record<string, unknown>) {
    const { _id, _creationTime, ...data } = job as unknown as Record<string, unknown>;
    session.updateRaw(this.table(), job._id, JSON.stringify({ ...data, ...patch }));
  }

  private schedule(session: DbSession, runAt: number | Date, ref: unknown, args: unknown): string {
    const path = getFunctionPath(ref as any);
    const fn = this.engine.functions.get(path);
    if (!fn) throw new Error(`Cannot schedule unknown function "${path}"`);
    if (fn.type === "query") throw new Error(`Cannot schedule query "${path}"; schedule a mutation or action`);
    const parsedArgs = args ?? {};
    this.engine.parseArgs(fn, parsedArgs);
    const time = runAt instanceof Date ? runAt.getTime() : runAt;
    if (!Number.isFinite(time)) throw new Error("Invalid scheduled time");
    const id = session.insertRaw(
      this.table(),
      JSON.stringify({ name: path, args: parsedArgs, runAt: time, state: "pending" }),
    );
    session.onCommit(() => this.poke());
    return id;
  }

  private cancel(session: DbSession, id: string) {
    const doc = session.conn.query(`SELECT _id, _creationTime, data FROM _scheduled WHERE _id = ?`).get(id) as DocumentRow | null;
    if (!doc) throw new IncibaseError({ code: "NOT_FOUND", message: `Scheduled job "${id}" not found` });
    const job = rowToDoc(doc) as unknown as ScheduledDoc;
    if (job.state === "pending") this.update(session, job, { state: "canceled", completedAt: Date.now() });
  }

  /** `ctx.scheduler` inside a mutation: writes join the mutation's transaction. */
  forSession(session: DbSession) {
    return {
      runAfter: async (delayMs: number, ref: unknown, args?: unknown) => this.schedule(session, Date.now() + delayMs, ref, args),
      runAt: async (time: number | Date, ref: unknown, args?: unknown) => this.schedule(session, time, ref, args),
      cancel: async (id: string) => this.cancel(session, id),
    };
  }

  /** `ctx.scheduler` inside an action: each call is its own transaction. */
  standalone() {
    const tx = <T>(fn: (s: DbSession) => T) => this.engine.writeTx(fn);
    return {
      runAfter: (delayMs: number, ref: unknown, args?: unknown) => tx((s) => this.schedule(s, Date.now() + delayMs, ref, args)),
      runAt: (time: number | Date, ref: unknown, args?: unknown) => tx((s) => this.schedule(s, time, ref, args)),
      cancel: (id: string) => tx((s) => this.cancel(s, id)),
    };
  }

  /** Re-arms the timer for the earliest pending job. */
  poke() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const row = this.engine.store.write
      .query(
        `SELECT json_extract(data, '$.runAt') AS runAt FROM _scheduled WHERE json_extract(data, '$.state') = 'pending'
         ORDER BY json_extract(data, '$.state'), json_extract(data, '$.runAt') LIMIT 1`,
      )
      .get() as { runAt: number } | null;
    if (!row) return;
    const delay = Math.max(0, Math.min(row.runAt - Date.now(), MAX_TIMEOUT));
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick() {
    if (this.stopped || this.running >= MAX_CONCURRENT) return;
    const claimed = await this.engine.writeTx((session) => {
      const jobs = this.jobsInState(session, "pending", MAX_CONCURRENT - this.running, Date.now());
      for (const job of jobs) this.update(session, job, { state: "running", startedAt: Date.now() });
      return jobs;
    });
    this.running += claimed.length;
    await Promise.all(claimed.map((job) => this.execute(job)));
    this.running -= claimed.length;
    this.poke();
  }

  private async execute(job: ScheduledDoc) {
    const started = performance.now();
    let error: string | undefined;
    try {
      await this.engine.call(job.name, job.args, SYSTEM_IDENTITY, { allowInternal: true });
    } catch (err) {
      error = (err as Error)?.message ?? String(err);
    }
    this.engine.log({ type: "scheduled", path: job.name, durationMs: performance.now() - started, ok: !error, error });
    await this.engine.writeTx((session) => {
      const row = session.conn.query(`SELECT _id, _creationTime, data FROM _scheduled WHERE _id = ?`).get(job._id) as DocumentRow | null;
      if (row) {
        this.update(session, rowToDoc(row) as unknown as ScheduledDoc, {
          state: error ? "failed" : "success",
          completedAt: Date.now(),
          ...(error ? { error } : {}),
        });
      }
    });
  }

  private startCron(job: CronJob) {
    let busy = false;
    const next = (): number => {
      if (job.schedule.kind === "interval") return Date.now() + job.schedule.ms;
      const date = Bun.cron.parse(job.schedule.expression, Date.now() + 1000, job.schedule.tz ? { tz: job.schedule.tz } : undefined);
      if (!date) throw new Error(`Cron "${job.name}" never fires: ${job.schedule.expression}`);
      return date.getTime();
    };
    const arm = () => {
      if (this.stopped) return;
      const timer = setTimeout(
        async () => {
          this.cronTimers = this.cronTimers.filter((t) => t !== timer);
          arm();
          if (busy) return; // previous run still going; skip this tick
          busy = true;
          const started = performance.now();
          try {
            await this.engine.call(job.path, job.args, SYSTEM_IDENTITY, { allowInternal: true });
            this.engine.log({ type: "cron", path: `${job.name} → ${job.path}`, durationMs: performance.now() - started, ok: true });
          } catch (err) {
            this.engine.log({
              type: "cron",
              path: `${job.name} → ${job.path}`,
              durationMs: performance.now() - started,
              ok: false,
              error: (err as Error)?.message ?? String(err),
            });
          } finally {
            busy = false;
          }
        },
        Math.max(0, Math.min(next() - Date.now(), MAX_TIMEOUT)),
      );
      this.cronTimers.push(timer);
    };
    if (!this.engine.functions.has(job.path)) throw new Error(`Cron "${job.name}" points to unknown function "${job.path}"`);
    arm();
  }

  private async prune() {
    const cutoff = Date.now() - RETENTION_MS;
    await this.engine.writeTx((session) => {
      const result = session.conn
        .query(
          `DELETE FROM ${quoteIdent("_scheduled")} WHERE json_extract(data, '$.state') IN ('success', 'failed', 'canceled')
           AND json_extract(data, '$.completedAt') < ?`,
        )
        .run(cutoff);
      if (result.changes) session.writtenTables.add("_scheduled");
    });
  }
}
