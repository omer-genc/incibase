// Step 4 of M1: graceful drain on SIGTERM/SIGINT, interrupted jobs, skipped crons.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { action, cronJobs, defineSchema, defineTable, internalAction, internalMutation, mutation, query, z } from "incibase/server";
import { DEV_DRAIN_TIMEOUT_MS, DRAIN_TIMEOUT_MS, parseDrainTimeout, REPEAT_SIGNAL_MS, stopSignals } from "../src/engine/drain.ts";
import { Engine, toErrorPayload, type AppDefinition } from "../src/engine/engine.ts";
import { ConfigError, DefinitionError, ExitCode } from "../src/engine/exit-codes.ts";
import { INTERRUPT_RETRIES } from "../src/engine/scheduler.ts";
import { Deadline, FunctionTimeoutError, ServerStoppingError } from "../src/engine/timeouts.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const dirs: string[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill("SIGKILL");
    await p.exited;
  }
  for (const e of engines.splice(0)) await e.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

async function until(check: () => unknown, what: string, timeoutMs = 5000) {
  for (const end = Date.now() + timeoutMs; !(await check()); await Bun.sleep(10)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

const SCHEMA = `import { defineSchema, defineTable, z } from "incibase/server";
export default defineSchema({ notes: defineTable({ body: z.string() }) });
`;

const APP = `import { action, internalAction, internalMutation, mutation, query, z } from "incibase/server";

export const slowAdd = mutation({
  args: { ms: z.number() },
  handler: async (ctx, { ms }) => {
    console.log("slowAdd started");
    await Bun.sleep(ms);
    await ctx.db.insert("notes", { body: "slow" });
    return "committed";
  },
});

export const hang = mutation({
  handler: async (ctx) => {
    await ctx.db.insert("notes", { body: "hung" });
    console.log("hang started");
    await new Promise(() => {});
  },
});

export const add = mutation({ args: { body: z.string() }, handler: async (ctx, { body }) => { await ctx.db.insert("notes", { body }); } });

export const notes = query({ handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.body) });

export const startJob = mutation({ handler: async (ctx) => ctx.scheduler.runAfter(0, "app:slowJob" as any) });

export const slowJob = internalAction({
  handler: async (ctx) => {
    console.log("slowJob started");
    await Bun.sleep(700);
    await ctx.runMutation("app:add" as any, { body: "from job" });
  },
});

export const crashLater = mutation({ handler: async (ctx) => ctx.scheduler.runAfter(0, "app:crash" as any) });

export const crash = internalAction({
  retryOnInterrupt: true,
  handler: async () => {
    console.log("crash started");
    await Bun.sleep(50);
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => {});
  },
});

export const tick = internalMutation({ handler: async (ctx) => { await ctx.db.insert("notes", { body: "tick" }); } });

export const writeThenHang = action({
  handler: async (ctx) => {
    await ctx.runMutation("app:add" as any, { body: "from action" });
    console.log("action wrote");
    await new Promise(() => {});
  },
});

export const slowJobAdd = internalMutation({
  args: { body: z.string() },
  handler: async (ctx, { body }) => {
    console.log("job " + body + " started");
    await Bun.sleep(800);
    await ctx.db.insert("notes", { body });
  },
});

export const queueThree = mutation({
  handler: async (ctx) => {
    for (const body of ["j1", "j2", "j3"]) await ctx.scheduler.runAfter(0, "app:slowJobAdd" as any, { body });
  },
});

export const queueHangingAction = mutation({ handler: async (ctx) => ctx.scheduler.runAfter(0, "app:writeThenHang" as any) });
`;

const CRONS = `import { cronJobs } from "incibase/server";
const crons = cronJobs();
crons.interval("hourly", { hours: 1 }, "app:tick" as any);
crons.cron("top", "0 * * * *", "app:tick" as any, undefined, { tz: "UTC" });
crons.interval("changed", { hours: 2 }, "app:tick" as any);
export default crons;
`;

function project(files: Record<string, string> = {}) {
  const root = dir();
  const source = join(root, "app");
  mkdirSync(source);
  for (const [name, text] of Object.entries({ "schema.ts": SCHEMA, "app.ts": APP, ...files })) writeFileSync(join(source, name), text);
  return { root, source, data: join(root, "data") };
}

function childEnv(extra: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("INCIBASE_") && k !== "NO_COLOR" && k !== "FORCE_COLOR"));
  return { ...env, ...extra };
}

/** Starts the CLI with json logs and collects its output. */
function spawn(args: string[], env: Record<string, string> = {}, prefix: string[] = []) {
  return spawnCommand([...prefix, process.execPath, CLI, ...args, "--log-format", "json"], env);
}

/** Starts `cmd` (which runs the CLI with json logs) and collects its output. */
function spawnCommand(cmd: string[], env: Record<string, string> = {}, cwd?: string) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: childEnv(env), cwd });
  procs.push(proc);
  const out = { stdout: "", stderr: "" };
  const done = Promise.all(
    (["stdout", "stderr"] as const).map(async (name) => {
      const decoder = new TextDecoder();
      for await (const chunk of proc[name] as ReadableStream<Uint8Array>) out[name] += decoder.decode(chunk, { stream: true });
    }),
  );
  const events = () =>
    out.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, any>);
  const waitFor = async (match: (e: Record<string, any>) => boolean, what: string) => {
    for (const end = Date.now() + 15_000; !events().some(match); await Bun.sleep(10)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}:\n${out.stdout}\n${out.stderr}`);
    }
    return events().find(match)!;
  };
  return {
    proc,
    out,
    events,
    waitFor,
    /** The ready event's listen address. */
    ready: async () => (await waitFor((e) => e.ev === "ready", "the ready line")).listen as string,
    async exit() {
      const code = await proc.exited;
      await done;
      return { ...out, code, events: events() };
    },
  };
}

function serve(p: ReturnType<typeof project>, ...extra: string[]) {
  return spawn(["serve", "--dir", p.source, "--data", p.data, "--port", "0", "--host", "127.0.0.1", ...extra]);
}

const call = (url: string, kind: string, path: string, args: unknown = {}, init: RequestInit = {}) =>
  fetch(`${url}/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args }), ...init });

/** The notes in a stopped server's database. */
function notesIn(data: string): string[] {
  const db = new Database(join(data, "data.db"), { readonly: true });
  try {
    return (db.query(`SELECT data FROM notes ORDER BY _creationTime`).all() as { data: string }[]).map((r) => JSON.parse(r.data).body);
  } finally {
    db.close();
  }
}

function jobsIn(data: string): Record<string, any>[] {
  const db = new Database(join(data, "data.db"), { readonly: true });
  try {
    return (db.query(`SELECT _id, data FROM _scheduled ORDER BY _creationTime`).all() as { _id: string; data: string }[]).map((r) => ({
      _id: r._id,
      ...JSON.parse(r.data),
    }));
  } finally {
    db.close();
  }
}

describe("drain on SIGTERM", () => {
  test("a mutation in flight is answered 200 and committed, while new connections are refused", async () => {
    const p = project();
    const run = serve(p, "--drain-timeout", "5");
    const url = await run.ready();
    const slow = call(url, "mutation", "app:slowAdd", { ms: 600 });
    await run.waitFor((e) => e.msg === "slowAdd started", "the mutation to start");
    run.proc.kill("SIGTERM");
    await run.waitFor((e) => e.ev === "draining", "the draining line");
    // A new connection (not a pooled one) is refused while the old request still runs.
    const refused = await call(url, "query", "app:notes", {}, { keepalive: false }).then(
      (res) => `status ${res.status}`,
      (err) => (err as { code?: string }).code ?? String(err),
    );
    expect(refused).toBe("ECONNREFUSED");
    const res = await slow;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: "committed" });
    const { code, events } = await run.exit();
    expect(code).toBe(0);
    expect(notesIn(p.data)).toEqual(["slow"]);
    const draining = events.find((e) => e.ev === "draining")!;
    expect(draining).toMatchObject({ signal: "SIGTERM", timeoutMs: 5000 });
    const drained = events.find((e) => e.ev === "drained")!;
    expect(drained.forced).toBe(false);
    expect(drained.ms).toBeGreaterThan(300);
    expect(drained.ms).toBeLessThan(5000);
    expect(events.map((e) => e.ev).filter((ev) => ["draining", "drained", "stopping", "stopped"].includes(ev))).toEqual([
      "draining",
      "drained",
      "stopping",
      "stopped",
    ]);
  }, 30_000);

  test("WebSocket clients get close code 1012 and do not hold the stop up", async () => {
    const p = project();
    const run = serve(p, "--drain-timeout", "10");
    const url = await run.ready();
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/api/ws`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => (ws.onclose = (e) => resolve({ code: e.code, reason: e.reason })));
    const first = new Promise((resolve) => (ws.onmessage = resolve));
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: "sub", id: "1", path: "app:notes" }));
    await first;
    const sent = performance.now();
    run.proc.kill("SIGTERM");
    expect(await closed).toEqual({ code: 1012, reason: "server restarting" });
    const { code, events } = await run.exit();
    expect(code).toBe(0);
    expect(performance.now() - sent).toBeLessThan(5000);
    expect(events.find((e) => e.ev === "drained")!.forced).toBe(false);
  }, 30_000);

  test("a scheduled job running at SIGTERM is awaited and its outcome stored", async () => {
    const p = project();
    const run = serve(p, "--drain-timeout", "5");
    const url = await run.ready();
    expect((await call(url, "mutation", "app:startJob")).status).toBe(200);
    await run.waitFor((e) => e.msg === "slowJob started", "the job to start");
    run.proc.kill("SIGTERM");
    const { code, events } = await run.exit();
    expect(code).toBe(0);
    expect(events.find((e) => e.ev === "drained")!.forced).toBe(false);
    expect(notesIn(p.data)).toEqual(["from job"]);
    expect(jobsIn(p.data)).toMatchObject([{ name: "app:slowJob", state: "success", attempts: 1 }]);
  }, 30_000);

  test("a hung mutation is cut at the drain deadline: 503, rolled back, exit 0, data dir free", async () => {
    const p = project();
    const run = serve(p, "--drain-timeout", "1");
    const url = await run.ready();
    const hung = call(url, "mutation", "app:hang");
    await run.waitFor((e) => e.msg === "hang started", "the mutation to hang");
    const sent = performance.now();
    run.proc.kill("SIGTERM");
    const res = await hung;
    expect(res.status).toBe(503);
    // Marked as the front proxy marks a call that never arrived: clients resend it.
    expect(res.headers.get("x-incibase-unprocessed")).toBe("1");
    expect(res.headers.get("retry-after")).toBe("1");
    expect((await res.json()).error.code).toBe("SERVER_STOPPING");
    const { code, events } = await run.exit();
    const took = performance.now() - sent;
    expect(code).toBe(0);
    expect(took).toBeGreaterThan(900);
    expect(took).toBeLessThan(2500);
    const drained = events.find((e) => e.ev === "drained")!;
    expect(drained).toMatchObject({ forced: true, cut: ["app:hang"], level: "warn" });
    expect(drained.ms).toBeGreaterThanOrEqual(1000);
    expect(drained.ms).toBeLessThan(2000);
    expect(notesIn(p.data)).toEqual([]);
    // The LOCK was released: the next server starts on the same data dir.
    const next = serve(p);
    await next.ready();
    next.proc.kill("SIGTERM");
    expect((await next.exit()).code).toBe(0);
  }, 30_000);

  test("a second SIGTERM cuts the drain at once", async () => {
    const p = project();
    const run = serve(p, "--drain-timeout", "30");
    const url = await run.ready();
    const hung = call(url, "mutation", "app:hang");
    await run.waitFor((e) => e.msg === "hang started", "the mutation to hang");
    run.proc.kill("SIGTERM");
    await run.waitFor((e) => e.ev === "draining", "the draining line");
    // Past REPEAT_SIGNAL_MS: a second request, not the first one delivered twice.
    await Bun.sleep(REPEAT_SIGNAL_MS + 100);
    const second = performance.now();
    run.proc.kill("SIGTERM");
    expect((await hung).status).toBe(503);
    const { code, events } = await run.exit();
    expect(code).toBe(0);
    expect(performance.now() - second).toBeLessThan(1500);
    const drained = events.find((e) => e.ev === "drained")!;
    expect(drained.forced).toBe(true);
    expect(drained.ms).toBeLessThan(2000);
    expect(notesIn(p.data)).toEqual([]);
  }, 30_000);

  test("on a unix socket: the request in flight is answered and the socket file is removed", async () => {
    const p = project();
    const socket = join(p.root, "http.sock");
    const run = spawn(["serve", "--dir", p.source, "--data", p.data, "--socket", socket, "--url", "https://shop.example"]);
    await run.ready();
    expect(existsSync(socket)).toBe(true);
    const slow = fetch("http://localhost/api/mutation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "app:slowAdd", args: { ms: 400 } }),
      unix: socket,
    } as RequestInit);
    await run.waitFor((e) => e.msg === "slowAdd started", "the mutation to start");
    run.proc.kill("SIGTERM");
    expect((await slow).status).toBe(200);
    expect((await run.exit()).code).toBe(0);
    expect(existsSync(socket)).toBe(false);
    expect(notesIn(p.data)).toEqual(["slow"]);
  }, 30_000);

  test("dev drains for 1s by default", async () => {
    const p = project();
    const run = spawn(["dev", "--dir", p.source, "--data", p.data, "--port", "0", "--host", "127.0.0.1"]);
    const url = await run.ready();
    const hung = call(url, "mutation", "app:hang");
    await run.waitFor((e) => e.msg === "hang started", "the mutation to hang");
    run.proc.kill("SIGTERM");
    expect((await hung).status).toBe(503);
    const { code, events } = await run.exit();
    expect(code).toBe(0);
    expect(events.find((e) => e.ev === "draining")!.timeoutMs).toBe(DEV_DRAIN_TIMEOUT_MS);
    const drained = events.find((e) => e.ev === "drained")!;
    expect(drained.forced).toBe(true);
    expect(drained.ms).toBeGreaterThanOrEqual(1000);
    expect(drained.ms).toBeLessThan(2000);
  }, 30_000);

  // perl starts dev in a process group of its own, so the test can signal the group as a terminal's Ctrl-C does.
  test.skipIf(!Bun.which("perl"))("Ctrl-C on dev is one stop for its server, so its drain is not cut short", async () => {
    const p = project();
    const run = spawn(["dev", "--dir", p.source, "--data", p.data, "--port", "0", "--host", "127.0.0.1"], {}, [
      "perl",
      "-e",
      "setpgrp(0, 0); exec @ARGV",
    ]);
    const url = await run.ready();
    const slow = call(url, "mutation", "app:slowAdd", { ms: 500 });
    await run.waitFor((e) => e.msg === "slowAdd started", "the mutation to start");
    process.kill(-run.proc.pid, "SIGINT");
    expect((await slow).status).toBe(200);
    const { code, events } = await run.exit();
    expect(code).toBe(0);
    expect(events.find((e) => e.ev === "draining")!.signal).toBe("SIGINT");
    expect(events.find((e) => e.ev === "drained")!.forced).toBe(false);
    expect(notesIn(p.data)).toEqual(["slow"]);
  }, 30_000);

  test("the same signal delivered twice within REPEAT_SIGNAL_MS is one stop, not a forced one", async () => {
    const p = project();
    const run = serve(p, "--drain-timeout", "5");
    const url = await run.ready();
    const slow = call(url, "mutation", "app:slowAdd", { ms: 800 });
    await run.waitFor((e) => e.msg === "slowAdd started", "the mutation to start");
    run.proc.kill("SIGINT");
    await Bun.sleep(30);
    run.proc.kill("SIGINT");
    expect((await slow).status).toBe(200);
    const { code, events } = await run.exit();
    expect(code).toBe(0);
    expect(events.filter((e) => e.ev === "draining")).toHaveLength(1);
    expect(events.find((e) => e.ev === "drained")!.forced).toBe(false);
    expect(notesIn(p.data)).toEqual(["slow"]);
  }, 30_000);

  /**
   * Runs the CLI as `bun run start` does, the usual way to start it, in a
   * process group of its own (perl), so the test can signal the group as a
   * terminal's Ctrl-C does. The wrapper passes the signal on as well, so the
   * CLI gets it twice.
   */
  function viaBunRun(p: ReturnType<typeof project>, args: string[]) {
    const script = [process.execPath, CLI, ...args, "--log-format", "json"].map((a) => `'${a}'`).join(" ");
    writeFileSync(join(p.root, "package.json"), JSON.stringify({ name: "drain-app", private: true, scripts: { start: script } }));
    return spawnCommand(["perl", "-e", "setpgrp(0, 0); exec @ARGV", process.execPath, "run", "start"], {}, p.root);
  }

  for (const command of ["serve", "dev"] as const) {
    test.skipIf(!Bun.which("perl"))(`Ctrl-C on ${command} under bun run drains instead of cutting at once`, async () => {
      const p = project();
      const run = viaBunRun(p, [command, "--dir", p.source, "--data", p.data, "--port", "0", "--host", "127.0.0.1"]);
      const url = await run.ready();
      const slow = call(url, "mutation", "app:slowAdd", { ms: 600 });
      await run.waitFor((e) => e.msg === "slowAdd started", "the mutation to start");
      process.kill(-run.proc.pid, "SIGINT");
      const res = await slow;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: "committed" });
      const { code, events } = await run.exit();
      expect(code).toBe(0);
      expect(events.filter((e) => e.ev === "draining")).toHaveLength(1);
      expect(events.find((e) => e.ev === "drained")).toMatchObject({ forced: false });
      expect(notesIn(p.data)).toEqual(["slow"]);
    }, 30_000);
  }

  test("dev passes a signal sent to it alone on at once, and ignores file changes while it stops", async () => {
    const p = project();
    const run = spawn(["dev", "--dir", p.source, "--data", p.data, "--port", "0", "--host", "127.0.0.1"]);
    const url = await run.ready();
    const slow = call(url, "mutation", "app:slowAdd", { ms: 800 });
    await run.waitFor((e) => e.msg === "slowAdd started", "the mutation to start");
    const sent = performance.now();
    // Only the dev process, as `kill -INT <pid>` or a supervisor would: its server did not get it.
    run.proc.kill("SIGINT");
    await run.waitFor((e) => e.ev === "draining", "the server to drain");
    writeFileSync(join(p.source, "app.ts"), `${APP}\n// changed while stopping\n`);
    expect((await slow).status).toBe(200);
    const { code, events } = await run.exit();
    expect(code).toBe(0);
    // Not drain + 2s of waiting for a signal the server never got.
    expect(performance.now() - sent).toBeLessThan(2000);
    expect(events.find((e) => e.ev === "draining")!.signal).toBe("SIGINT");
    expect(events.find((e) => e.ev === "drained")!.forced).toBe(false);
    // No restart, so no second server racing the first for the data dir.
    expect(events.some((e) => e.ev === "restarting")).toBe(false);
    expect(events.filter((e) => e.ev === "ready")).toHaveLength(1);
    expect(notesIn(p.data)).toEqual(["slow"]);
  }, 30_000);

  test("an action cut at the drain deadline is ACTION_INTERRUPTED, not unprocessed: what it ran is kept", async () => {
    const p = project();
    const run = serve(p, "--drain-timeout", "500ms");
    const url = await run.ready();
    const pending = call(url, "action", "app:writeThenHang");
    await run.waitFor((e) => e.msg === "action wrote", "the action to write");
    run.proc.kill("SIGTERM");
    const res = await pending;
    expect(res.status).toBe(503);
    const { error } = await res.json();
    expect(error.code).toBe("ACTION_INTERRUPTED");
    expect(error.data.unprocessed).toBe(false);
    expect(error.message).toContain("may have partly run");
    expect((await run.exit()).code).toBe(0);
    expect(notesIn(p.data)).toEqual(["from action"]);
  }, 30_000);

  test("scheduled mutations cut at the drain deadline go back to pending and run on the next start; a cut action is interrupted", async () => {
    const p = project();
    const args = ["--drain-timeout", "1.2"];
    const first = serve(p, ...args);
    const url = await first.ready();
    expect((await call(url, "mutation", "app:queueHangingAction")).status).toBe(200);
    await first.waitFor((e) => e.msg === "action wrote", "the scheduled action to write");
    // Each job sleeps 800ms holding the write lock: at the deadline j2 runs and j3 waits for the lock.
    expect((await call(url, "mutation", "app:queueThree")).status).toBe(200);
    await first.waitFor((e) => e.msg === "job j1 started", "the first job");
    first.proc.kill("SIGTERM");
    const stopped = await first.exit();
    expect(stopped.code).toBe(0);
    const drained = stopped.events.find((e) => e.ev === "drained")!;
    expect(drained.forced).toBe(true);
    expect([...drained.cut].sort()).toEqual(["app:slowJobAdd", "app:slowJobAdd", "app:writeThenHang"]);
    const byBody = (jobs: Record<string, any>[]) => Object.fromEntries(jobs.map((j) => [j.args.body ?? j.name, j]));
    let jobs = byBody(jobsIn(p.data));
    expect(jobs.j1).toMatchObject({ state: "success", attempts: 1 });
    // Rolled back (j2) or never started (j3): pending again, the claim's attempt taken back.
    for (const body of ["j2", "j3"]) {
      expect(jobs[body].state).toBe("pending");
      expect(jobs[body].attempts).toBeUndefined();
      expect(jobs[body].startedAt).toBeUndefined();
    }
    // The action may have done part of its work: left running for the next start to judge.
    expect(jobs["app:writeThenHang"]).toMatchObject({ state: "running", attempts: 1 });
    expect(notesIn(p.data)).toEqual(["from action", "j1"]);

    const second = serve(p, ...args);
    const url2 = await second.ready();
    await until(
      async () => ((await (await call(url2, "query", "app:notes")).json()).value as string[]).length === 4,
      "the requeued jobs to run",
      10_000,
    );
    second.proc.kill("SIGTERM");
    const { code, events } = await second.exit();
    expect(code).toBe(0);
    expect(events.filter((e) => e.ev === "job_interrupted").map((e) => e.name)).toEqual(["app:writeThenHang"]);
    expect(notesIn(p.data)).toEqual(["from action", "j1", "j2", "j3"]);
    jobs = byBody(jobsIn(p.data));
    for (const body of ["j1", "j2", "j3"]) expect(jobs[body]).toMatchObject({ state: "success", attempts: 1 });
    expect(jobs["app:writeThenHang"]).toMatchObject({ state: "interrupted" });
  }, 60_000);

  test("an invalid --drain-timeout exits 64", async () => {
    const p = project();
    const { code, events } = await serve(p, "--drain-timeout", "soon").exit();
    expect(code).toBe(ExitCode.CONFIG);
    expect(events.find((e) => e.ev === "fatal")!.msg).toContain("drain timeout");
    expect(existsSync(join(p.data, "data.db"))).toBe(false);
  }, 30_000);
});

describe("--drain-timeout", () => {
  test("takes seconds or a duration, with 10s (dev 1s) by default", () => {
    expect(parseDrainTimeout(undefined)).toBe(DRAIN_TIMEOUT_MS);
    expect(DRAIN_TIMEOUT_MS).toBe(10_000);
    expect(parseDrainTimeout(undefined, true)).toBe(1000);
    expect(parseDrainTimeout("10")).toBe(10_000);
    expect(parseDrainTimeout("0.5")).toBe(500);
    expect(parseDrainTimeout("0")).toBe(0);
    expect(parseDrainTimeout("250ms")).toBe(250);
    expect(parseDrainTimeout("2m")).toBe(120_000);
    for (const bad of ["", "soon", "-1", "10 seconds", "1h", "9999999999"]) expect(() => parseDrainTimeout(bad)).toThrow(ConfigError);
  });
});

describe("stopSignals", () => {
  test("a signal within the window of the first is a repeat; a later one forces", async () => {
    expect(REPEAT_SIGNAL_MS).toBe(500);
    const next = stopSignals(100);
    expect(next()).toBe("stop");
    expect(next()).toBe("repeat");
    await Bun.sleep(130);
    expect(next()).toBe("force");
    expect(next()).toBe("force");
  });
});

describe("Deadline.abort", () => {
  test("ends every race on it with the error, without the timeout callback", async () => {
    let timedOut = 0;
    const deadline = new Deadline("mutation", "app:x", Infinity, () => timedOut++).start();
    const cleaned: unknown[] = [];
    const a = deadline.race(() => new Promise(() => {}), (err) => cleaned.push(err)).catch((e) => e);
    const b = deadline.race(() => new Promise(() => {})).catch((e) => e);
    const err = new ServerStoppingError();
    deadline.abort(err);
    expect(await a).toBe(err);
    expect(await b).toBe(err);
    expect(cleaned).toEqual([err]);
    expect(() => deadline.check()).toThrow(err);
    // Ended once: a later abort or timeout changes nothing.
    deadline.abort(new ServerStoppingError());
    expect(() => deadline.checkTime()).toThrow(err);
    expect(timedOut).toBe(0);
    expect(deadline.expired).toBe(true);
  });

  test("an infinite deadline never passes by itself", async () => {
    const deadline = new Deadline("action", "app:y", Infinity);
    expect(await deadline.race(async () => {
      await Bun.sleep(30);
      return "done";
    })).toBe("done");
    expect(deadline.expired).toBe(false);
  });

  test("a deadline that passed keeps its timeout error", async () => {
    const deadline = new Deadline("query", "app:z", 10);
    const raced = await deadline.race(() => new Promise(() => {})).catch((e) => e);
    expect(raced).toBeInstanceOf(FunctionTimeoutError);
    deadline.abort(new ServerStoppingError());
    expect(() => deadline.check()).toThrow(FunctionTimeoutError);
  });
});

describe("engine cut", () => {
  test("cutCalls rolls a hung mutation back and frees the write lock; idle then resolves", async () => {
    let started = false;
    const app: AppDefinition = {
      schema: defineSchema({ notes: defineTable({ body: z.string() }) }),
      modules: {
        app: {
          hang: internalMutation({
            handler: async (ctx) => {
              await ctx.db.insert("notes", { body: "hung" });
              started = true;
              await new Promise(() => {});
            },
          }),
          ok: internalMutation({ handler: async () => "ok" }),
        },
      },
    };
    const engine = new Engine(app, { dataDir: dir(), quiet: true, publicUrl: "http://localhost" });
    engines.push(engine);
    const system = { userId: null, admin: false, system: true };
    const hung = engine.call("app:hang", {}, system, { allowInternal: true }).catch((e) => e);
    await until(() => started, "the mutation to start");
    const queued = engine.call("app:ok", {}, system, { allowInternal: true }).catch((e) => e);
    let idle = false;
    void engine.idle().then(() => (idle = true));
    await Bun.sleep(30);
    expect(idle).toBe(false);
    expect(engine.runningCalls().sort()).toEqual(["app:hang", "app:ok"]);
    engine.cutCalls();
    expect(await hung).toBeInstanceOf(ServerStoppingError);
    expect(await queued).toBeInstanceOf(ServerStoppingError);
    // Rolled back or never run: unprocessed, so a client may send them again.
    for (const err of [await hung, await queued]) {
      expect((err as ServerStoppingError).data).toMatchObject({ code: "SERVER_STOPPING", unprocessed: true });
      expect(toErrorPayload(err, false).status).toBe(503);
    }
    await until(() => idle, "idle");
    expect(engine.store.write.inTransaction).toBe(false);
    expect(engine.store.read.query(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 0 });
    // Calls after the cut are cut as they start; engine-internal writes still run.
    expect(await engine.call("app:ok", {}, system, { allowInternal: true }).catch((e) => e)).toBeInstanceOf(ServerStoppingError);
    expect(await engine.writeTx(() => "written")).toBe("written");
  });
});

describe("engine cut of actions", () => {
  test("a cut action or httpAction gets ACTION_INTERRUPTED; the mutation it ran stays committed", async () => {
    let wrote = 0;
    const app: AppDefinition = {
      schema: defineSchema({ notes: defineTable({ body: z.string() }) }),
      modules: {
        app: {
          add: internalMutation({ handler: async (ctx) => void (await ctx.db.insert("notes", { body: "from action" })) }),
          writeThenHang: internalAction({
            handler: async (ctx) => {
              await ctx.runMutation("app:add" as never, {} as never);
              wrote++;
              await new Promise(() => {});
            },
          }),
          ok: internalAction({ handler: async () => "ok" }),
        },
      },
    };
    const engine = new Engine(app, { dataDir: dir(), quiet: true, publicUrl: "http://localhost" });
    engines.push(engine);
    const system = { userId: null, admin: false, system: true };
    const cutAction = engine.call("app:writeThenHang", {}, system, { allowInternal: true }).catch((e) => e);
    const cutHttp = engine
      .runHttpAction(
        async (ctx) => {
          await ctx.runMutation("app:add" as never, {} as never);
          wrote++;
          return new Promise<Response>(() => {});
        },
        system,
        new Request("http://localhost/hook"),
        "POST /hook",
      )
      .catch((e) => e);
    await until(() => wrote === 2, "both to write");
    engine.cutCalls();
    for (const err of [await cutAction, await cutHttp]) {
      expect(err).toBeInstanceOf(ServerStoppingError);
      expect((err as ServerStoppingError).unprocessed).toBe(false);
      expect(toErrorPayload(err, false)).toMatchObject({
        status: 503,
        error: { code: "ACTION_INTERRUPTED", data: { code: "ACTION_INTERRUPTED", unprocessed: false } },
      });
    }
    expect(engine.store.read.query(`SELECT count(*) AS n FROM notes`).get()).toEqual({ n: 2 });
    // An action that starts after the cut never runs: that one is unprocessed.
    const late = await engine.call("app:ok", {}, system, { allowInternal: true }).catch((e) => e);
    expect((late as ServerStoppingError).data).toMatchObject({ code: "SERVER_STOPPING", unprocessed: true });
  });
});

describe("interrupted jobs", () => {
  function open(app: AppDefinition, dataDir: string) {
    const engine = new Engine(app, { dataDir, quiet: true, publicUrl: "http://localhost" });
    engines.push(engine);
    return engine;
  }

  async function close(engine: Engine) {
    engines.splice(engines.indexOf(engine), 1);
    await engine.stop();
  }

  function job(engine: Engine, id: string): Record<string, any> {
    const row = engine.store.read.query(`SELECT data FROM _scheduled WHERE _id = ?`).get(id) as { data: string };
    return JSON.parse(row.data);
  }

  /** As if the process had died while the job ran: it is left "running". */
  async function crashWhileRunning(engine: Engine, id: string, attempts?: number) {
    await engine.writeTx((s) =>
      s.conn
        .query(`UPDATE _scheduled SET data = json_set(data, '$.state', 'running', '$.attempts', ?) WHERE _id = ?`)
        .run(attempts ?? null, id),
    );
    if (attempts === undefined) {
      await engine.writeTx((s) => s.conn.query(`UPDATE _scheduled SET data = json_remove(data, '$.attempts') WHERE _id = ?`).run(id));
    }
    await close(engine);
  }

  const ran: string[] = [];
  const app: AppDefinition = {
    modules: {
      jobs: {
        plain: internalAction({ handler: async () => void ran.push("plain") }),
        retried: internalAction({ retryOnInterrupt: true, handler: async () => void ran.push("retried") }),
      },
    },
  };
  const schedule = (engine: Engine, path: string, delayMs = 60_000) =>
    engine.writeTx((s) => engine.scheduler.forSession(s).runAfter(delayMs, path as never));

  test("a job left running is marked interrupted on the next start, not failed and not run again", async () => {
    ran.length = 0;
    const data = dir();
    const first = open(app, data);
    const id = await schedule(first, "jobs:plain");
    await crashWhileRunning(first, id);
    const engine = open(app, data);
    engine.start();
    await until(() => job(engine, id).state !== "running", "recovery");
    expect(job(engine, id)).toMatchObject({ state: "interrupted", error: "Interrupted by server restart" });
    expect(typeof job(engine, id).completedAt).toBe("number");
    await Bun.sleep(50);
    expect(ran).toEqual([]);
  });

  test("retryOnInterrupt queues the job again once, counting attempts, and then leaves it interrupted", async () => {
    ran.length = 0;
    expect(INTERRUPT_RETRIES).toBe(1);
    const data = dir();
    let engine = open(app, data);
    engine.start();
    const id = await schedule(engine, "jobs:retried", 0);
    await until(() => job(engine, id).state === "success", "the first run");
    expect(job(engine, id).attempts).toBe(1);
    // Interrupted on its first attempt: queued again on the next start, and runs.
    await crashWhileRunning(engine, id, 1);
    ran.length = 0;
    engine = open(app, data);
    engine.start();
    await until(() => job(engine, id).state === "success", "the retry");
    expect(job(engine, id)).toMatchObject({ state: "success", attempts: 2 });
    expect(job(engine, id).error).toBeUndefined();
    expect(ran).toEqual(["retried"]);
    // Interrupted again: the limit is reached, so it stays interrupted.
    await crashWhileRunning(engine, id, 2);
    ran.length = 0;
    engine = open(app, data);
    engine.start();
    await until(() => job(engine, id).state !== "running", "recovery");
    expect(job(engine, id)).toMatchObject({ state: "interrupted", attempts: 2, error: "Interrupted by server restart" });
    await Bun.sleep(50);
    expect(ran).toEqual([]);
  });

  test("a job from before attempts were counted counts as one attempt", async () => {
    ran.length = 0;
    const data = dir();
    const first = open(app, data);
    const id = await schedule(first, "jobs:retried", 0);
    await crashWhileRunning(first, id);
    const engine = open(app, data);
    engine.start();
    await until(() => job(engine, id).state === "success", "the retry");
    expect(job(engine, id).attempts).toBe(2);
  });

  test("a job that crashes the process every time is retried once, then left interrupted", async () => {
    const p = project();
    const boot = async () => {
      const run = serve(p);
      return { run, url: await run.ready() };
    };
    // 1st run: the job kills the server.
    const first = await boot();
    expect((await call(first.url, "mutation", "app:crashLater")).status).toBe(200);
    expect((await first.run.exit()).code).not.toBe(0);
    expect(jobsIn(p.data)).toMatchObject([{ name: "app:crash", state: "running", attempts: 1 }]);
    // 2nd start: queued again, and it kills the server again.
    const second = serve(p);
    const secondExit = await second.exit();
    expect(secondExit.code).not.toBe(0);
    expect(secondExit.events.some((e) => e.ev === "job_requeued" && e.name === "app:crash")).toBe(true);
    expect(jobsIn(p.data)).toMatchObject([{ name: "app:crash", state: "running", attempts: 2 }]);
    // 3rd start: interrupted for good, and the server stays up.
    const third = await boot();
    await third.run.waitFor((e) => e.ev === "job_interrupted", "the job to be marked interrupted");
    await Bun.sleep(200);
    third.run.proc.kill("SIGTERM");
    const thirdExit = await third.run.exit();
    expect(thirdExit.code).toBe(0);
    expect(thirdExit.events.some((e) => e.msg === "crash started")).toBe(false);
    expect(jobsIn(p.data)).toMatchObject([{ name: "app:crash", state: "interrupted", attempts: 2, error: "Interrupted by server restart" }]);
  }, 60_000);

  test("retryOnInterrupt is refused on a query", () => {
    expect(() => query({ retryOnInterrupt: true, handler: async () => 1 } as never)).toThrow(DefinitionError);
  });

  test("interrupted jobs are pruned like finished ones", async () => {
    const data = dir();
    const first = open(app, data);
    const id = await schedule(first, "jobs:plain");
    await crashWhileRunning(first, id);
    const engine = open(app, data);
    engine.start();
    await until(() => job(engine, id).state === "interrupted", "recovery");
    await engine.writeTx((s) => s.conn.query(`UPDATE _scheduled SET data = json_set(data, '$.completedAt', 0) WHERE _id = ?`).run(id));
    await (engine.scheduler as unknown as { prune(): Promise<void> }).prune();
    expect(engine.store.read.query(`SELECT count(*) AS n FROM _scheduled`).get()).toEqual({ n: 0 });
  });
});

describe("skipped crons", () => {
  test("runs missed while the server was down are logged once per cron and not run late", async () => {
    const p = project({ "crons.ts": CRONS });
    const first = serve(p);
    await first.ready();
    first.proc.kill("SIGTERM");
    expect((await first.exit()).code).toBe(0);
    expect((await first.exit()).events.some((e) => e.ev === "cron_skipped")).toBe(false);

    // As if the server had been down for a while: move the saved next runs into the past.
    const now = Date.now();
    const topOfHour = Math.floor(now / 3_600_000) * 3_600_000;
    const db = new Database(join(p.data, "data.db"));
    const saved = (name: string) =>
      JSON.parse((db.query(`SELECT value FROM _incibase_meta WHERE key = ?`).get(`cron_next:${name}`) as { value: string }).value);
    expect(saved("hourly")).toEqual({ schedule: "every 3600000ms", next: expect.any(Number) });
    expect(saved("hourly").next).toBeGreaterThan(now);
    expect(saved("top").schedule).toBe("0 * * * * UTC");
    const set = (name: string, value: unknown) =>
      db.query(`UPDATE _incibase_meta SET value = ? WHERE key = ?`).run(JSON.stringify(value), `cron_next:${name}`);
    set("hourly", { schedule: "every 3600000ms", next: now - 2.5 * 3_600_000 });
    set("top", { schedule: "0 * * * * UTC", next: topOfHour - 2 * 3_600_000 });
    // Saved under another schedule: not this cron's missed runs.
    set("changed", { schedule: "every 60000ms", next: now - 3_600_000 });
    db.close();

    const second = serve(p);
    await second.ready();
    await Bun.sleep(300);
    second.proc.kill("SIGTERM");
    const { code, events } = await second.exit();
    expect(code).toBe(0);
    const skipped = events.filter((e) => e.ev === "cron_skipped");
    expect(skipped.map(({ name, missed }) => ({ name, missed }))).toEqual([
      { name: "hourly", missed: 3 },
      { name: "top", missed: 3 },
    ]);
    expect(skipped[0]).toMatchObject({ level: "warn", since: new Date(now - 2.5 * 3_600_000).toISOString() });
    // Not run late.
    expect(notesIn(p.data)).toEqual([]);
    // The next runs are in the future again.
    const after = new Database(join(p.data, "data.db"), { readonly: true });
    for (const name of ["hourly", "top", "changed"]) {
      const row = after.query(`SELECT value FROM _incibase_meta WHERE key = ?`).get(`cron_next:${name}`) as { value: string };
      expect(JSON.parse(row.value).next).toBeGreaterThan(now);
    }
    after.close();
  }, 30_000);

  test("the engine saves each cron's next run as it arms it", async () => {
    const crons = cronJobs();
    crons.interval("beat", { seconds: 1 }, "jobs:tick" as never, {} as never);
    let ticks = 0;
    const app: AppDefinition = { modules: { jobs: { tick: internalMutation({ handler: async () => void ticks++ }) }, crons: { default: crons } } };
    const engine = new Engine(app, { dataDir: dir(), quiet: true, publicUrl: "http://localhost" });
    engines.push(engine);
    engine.start();
    const next = () => JSON.parse(engine.store.getMeta("cron_next:beat") ?? "null")?.next as number | undefined;
    await until(() => next() !== undefined, "the first save");
    const first = next()!;
    await until(() => ticks > 0 && next()! > first, "a run and the next save", 4000);
    expect(next()! - first).toBeGreaterThanOrEqual(900);
  });
});
