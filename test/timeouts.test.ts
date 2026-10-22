import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IncibaseError } from "incibase";
import {
  action,
  defineSchema,
  defineTable,
  httpAction,
  httpRouter,
  internalMutation,
  mutation,
  query,
  z,
} from "incibase/server";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { ConfigError, exitCodeOf, ExitCode } from "../src/engine/exit-codes.ts";
import { startServer } from "../src/engine/http.ts";
import { FunctionTimeoutError, parseDuration, parseTimeouts, type Timeouts } from "../src/engine/timeouts.ts";
import { nextValue, tempDir } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

/** Resolves when `settle` is called; lets a test wait for an abandoned handler to finish. */
function signal<T = void>() {
  let settle!: (value: T) => void;
  const done = new Promise<T>((resolve) => (settle = resolve));
  return { done, settle };
}

const never = () => new Promise<never>(() => {});

const schema = defineSchema({
  notes: defineTable({ body: z.string() }),
  flags: defineTable({ hang: z.boolean() }),
});

/** What abandoned handlers ran into after their deadline, by name. */
let late: Record<string, ReturnType<typeof signal<unknown>>> = {};
const lateResult = (name: string) => (late[name] ??= signal<unknown>());

/** Runs `fn` after `ms` and records what it threw (or returned) under `name`. */
async function afterDeadline(name: string, ms: number, fn: () => Promise<unknown>) {
  await Bun.sleep(ms);
  try {
    lateResult(name).settle(await fn());
  } catch (err) {
    lateResult(name).settle(err);
    throw err;
  }
}

const http = httpRouter();
http.route({ path: "/hang", method: "GET", handler: httpAction(async () => never()) });
http.route({
  path: "/late",
  method: "GET",
  handler: httpAction(async (ctx) => {
    await afterDeadline("http", 120, () => ctx.runMutation("app:add" as any, { body: "from abandoned http action" }));
    return new Response("too late");
  }),
});
http.route({ path: "/quick", method: "GET", handler: httpAction(async () => new Response("ok")) });

const app: AppDefinition = {
  schema,
  modules: {
    app: {
      add: mutation({ args: { body: z.string() }, handler: async (ctx, { body }) => ctx.db.insert("notes", { body }) }),
      count: query({ handler: async (ctx) => (await ctx.db.query("notes").collect()).length }),
      hangMutation: mutation({ handler: async () => never() }),
      insertThenHang: mutation({
        handler: async (ctx) => {
          await ctx.db.insert("notes", { body: "before the deadline" });
          return never();
        },
      }),
      lateInsert: mutation({
        handler: async (ctx) => {
          await afterDeadline("mutation", 300, () => ctx.db.insert("notes", { body: "after the deadline" }));
        },
      }),
      lateScheduler: mutation({
        handler: async (ctx) => {
          await afterDeadline("mutationScheduler", 120, () => ctx.scheduler.runAfter(0, "app:add" as any, { body: "scheduled late" }));
        },
      }),
      slowMutation: mutation({
        args: { ms: z.number() },
        handler: async (ctx, { ms }) => {
          await Bun.sleep(ms);
          return ctx.db.insert("notes", { body: "slow" });
        },
      }),
      busyInserts: mutation({
        args: { ms: z.number() },
        handler: async (ctx, { ms }) => {
          // Only awaits ctx.db, which settles in microtasks: the deadline's timer never gets a turn.
          const started = performance.now();
          let n = 0;
          while (performance.now() - started < ms) {
            await ctx.db.insert("notes", { body: "busy" });
            n++;
          }
          return n;
        },
      }),
      hangQuery: query({ handler: async () => never() }),
      throws: query({
        handler: async () => {
          throw new IncibaseError("always fails");
        },
      }),
      lateRead: query({
        handler: async (ctx) => {
          await afterDeadline("query", 120, () => ctx.db.query("notes").collect());
        },
      }),
      hangAction: action({ handler: async () => never() }),
      lateAction: action({
        handler: async (ctx) => {
          await afterDeadline("action", 120, () => ctx.runMutation("app:add" as any, { body: "from abandoned action" }));
        },
      }),
      lateActionScheduler: action({
        handler: async (ctx) => {
          await afterDeadline("actionScheduler", 120, () => ctx.scheduler.runAfter(0, "app:add" as any, { body: "scheduled late" }));
        },
      }),
      hangJob: internalMutation({ handler: async () => never() }),
      okJob: internalMutation({ handler: async (ctx) => ctx.db.insert("notes", { body: "job ran" }) }),
      flagged: query({
        handler: async (ctx) => {
          const flags = await ctx.db.query("flags").collect();
          if (flags.some((f) => f.hang)) return never();
          return flags.length;
        },
      }),
      setFlag: mutation({
        args: { hang: z.boolean() },
        handler: async (ctx, { hang }) => {
          for (const f of await ctx.db.query("flags").collect()) await ctx.db.delete(f._id);
          await ctx.db.insert("flags", { hang });
        },
      }),
    },
    http: { default: http },
  },
};

async function start(timeouts?: Timeouts) {
  late = {};
  const engine = new Engine(app, { dataDir: dir(), quiet: true, publicUrl: "http://localhost", timeouts });
  engine.start();
  const server = startServer(engine, { port: 0, hostname: "127.0.0.1" });
  cleanups.push(async () => {
    server.stop(true);
    await engine.stop();
  });
  const url = server.url.origin;
  const call = async (type: "query" | "mutation" | "action", path: string, args: unknown = {}) => {
    const res = await fetch(`${url}/api/${type}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const notes = () => engine.store.read.query(`SELECT json_extract(data, '$.body') AS body FROM notes`).all() as { body: string }[];
  return { engine, url, call, notes };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

async function until(check: () => unknown, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected an error");
}

describe("parsing", () => {
  test("durations take ms, s and m", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("10s")).toBe(10_000);
    expect(parseDuration("1.5s")).toBe(1500);
    expect(parseDuration("2m")).toBe(120_000);
  });

  test("a full spec, a partial one and none", () => {
    expect(parseTimeouts("query=10s,mutation=10s,action=120s,http=120s")).toEqual({
      query: 10_000,
      mutation: 10_000,
      action: 120_000,
      http: 120_000,
    });
    expect(parseTimeouts(" mutation = 500ms ")).toEqual({ mutation: 500 });
    const saved = process.env.INCIBASE_TIMEOUTS;
    delete process.env.INCIBASE_TIMEOUTS;
    try {
      expect(parseTimeouts(undefined)).toEqual({});
      expect(parseTimeouts("")).toEqual({});
      process.env.INCIBASE_TIMEOUTS = "query=1s";
      expect(parseTimeouts(undefined)).toEqual({ query: 1000 });
      // The flag wins over the environment.
      expect(parseTimeouts("action=2s")).toEqual({ action: 2000 });
    } finally {
      if (saved === undefined) delete process.env.INCIBASE_TIMEOUTS;
      else process.env.INCIBASE_TIMEOUTS = saved;
    }
  });

  test("anything else is a config error (exit 64)", () => {
    for (const bad of ["query", "query=", "query=10", "query=10h", "query=-1s", "query=0s", "cron=1s", "query=1s=2s", "query=1s,", "query=99999999m"]) {
      const err = errorOf(() => parseTimeouts(bad));
      expect(err).toBeInstanceOf(ConfigError);
      expect(exitCodeOf(err)).toBe(ExitCode.CONFIG);
    }
  });
});

describe("mutations", () => {
  test("a never-settling mutation gets 504 and the next mutation runs at once", async () => {
    const t = await start({ mutation: 100 });
    const hung = await timed(() => t.call("mutation", "app:hangMutation"));
    expect(hung.value.status).toBe(504);
    expect(hung.value.body.error.code).toBe("FUNCTION_TIMEOUT");
    expect(hung.value.body.error.message).toContain("app:hangMutation");
    expect(hung.ms).toBeLessThan(1000);

    const next = await timed(() => t.call("mutation", "app:add", { body: "next" }));
    expect(next.value.status).toBe(200);
    expect(next.ms).toBeLessThan(200);
    expect(t.notes()).toEqual([{ body: "next" }]);
  });

  test("writes made before the deadline are rolled back", async () => {
    const t = await start({ mutation: 100 });
    expect((await t.call("mutation", "app:insertThenHang")).status).toBe(504);
    expect(t.notes()).toEqual([]);
    expect(t.engine.store.write.inTransaction).toBe(false);
  });

  test("an abandoned mutation's late ctx.db call throws and writes nothing", async () => {
    const t = await start({ mutation: 200 });
    expect((await t.call("mutation", "app:lateInsert")).status).toBe(504);
    // Another mutation holds the write lock while the abandoned one tries to write.
    const other = t.call("mutation", "app:slowMutation", { ms: 150 });
    const err = await lateResult("mutation").done;
    expect(err).toBeInstanceOf(FunctionTimeoutError);
    expect((await other).status).toBe(200);
    expect(t.notes()).toEqual([{ body: "slow" }]);
  });

  test("an abandoned mutation cannot schedule work", async () => {
    const t = await start({ mutation: 50 });
    expect((await t.call("mutation", "app:lateScheduler")).status).toBe(504);
    expect(await lateResult("mutationScheduler").done).toBeInstanceOf(FunctionTimeoutError);
    expect(t.engine.store.read.query(`SELECT COUNT(*) AS n FROM _scheduled`).get()).toEqual({ n: 0 });
  });

  test("a mutation queued behind a hung one runs once that one times out", async () => {
    const t = await start({ mutation: 150 });
    const hung = t.call("mutation", "app:hangMutation");
    // Its own deadline, counted from here, ends well after the hung one's.
    await Bun.sleep(75);
    const queued = await timed(() => t.call("mutation", "app:add", { body: "queued" }));
    expect(queued.value.status).toBe(200);
    expect(queued.ms).toBeLessThan(1000);
    expect((await hung).status).toBe(504);
    expect(t.notes()).toEqual([{ body: "queued" }]);
  });

  test("time spent queued counts: behind several hung mutations a call gets 504 at its own deadline and never runs", async () => {
    const t = await start({ mutation: 200 });
    const hung = [1, 2, 3, 4].map(() => t.call("mutation", "app:hangMutation"));
    const queued = await timed(() => t.call("mutation", "app:add", { body: "queued too long" }));
    expect(queued.value.status).toBe(504);
    expect(queued.value.body.error.code).toBe("FUNCTION_TIMEOUT");
    // One deadline, not one per hung mutation ahead of it (that was about 4 x 200ms).
    expect(queued.ms).toBeLessThan(600);
    for (const res of await Promise.all(hung)) expect(res.status).toBe(504);
    // Once it got the lock it was already late, so it did not start and nothing committed after its 504.
    await Bun.sleep(50);
    expect(t.notes()).toEqual([]);
    const next = await timed(() => t.call("mutation", "app:add", { body: "next" }));
    expect(next.value.status).toBe(200);
    expect(next.ms).toBeLessThan(200);
    expect(t.notes()).toEqual([{ body: "next" }]);
  });

  test("a mutation that only awaits ctx.db past its deadline is rolled back at commit", async () => {
    const t = await start({ mutation: 50 });
    const res = await t.call("mutation", "app:busyInserts", { ms: 150 });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("FUNCTION_TIMEOUT");
    expect(t.notes()).toEqual([]);
    expect(t.engine.store.write.inTransaction).toBe(false);
    // Within its deadline the same mutation commits.
    const ok = await t.call("mutation", "app:busyInserts", { ms: 5 });
    expect(ok.status).toBe(200);
    expect(t.notes().length).toBe(ok.body.value);
  });

  test("stop() does not wait past the deadline for a hung mutation", async () => {
    const engine = new Engine(app, { dataDir: dir(), quiet: true, publicUrl: "http://localhost", timeouts: { mutation: 100 } });
    const hung = engine.call("app:hangMutation", {}, { userId: null, admin: false }).catch((e) => e);
    await Bun.sleep(10);
    const stopped = await timed(() => engine.stop());
    expect(stopped.ms).toBeLessThan(1000);
    expect(await hung).toBeInstanceOf(FunctionTimeoutError);
  });
});

describe("queries", () => {
  test("a query timeout releases the read path", async () => {
    const t = await start({ query: 100 });
    const hung = await t.call("query", "app:hangQuery");
    expect(hung.status).toBe(504);
    expect(hung.body.error.code).toBe("FUNCTION_TIMEOUT");
    const next = await timed(() => t.call("query", "app:count"));
    expect(next.value).toEqual({ status: 200, body: { value: 0 } });
    expect(next.ms).toBeLessThan(200);
    expect(t.engine.store.read.inTransaction).toBe(false);
  });

  test("a query queued behind hung ones gets 504 at its own deadline", async () => {
    const t = await start({ query: 150 });
    const hung = [1, 2, 3].map(() => t.call("query", "app:hangQuery"));
    const queued = await timed(() => t.call("query", "app:count"));
    expect(queued.value.status).toBe(504);
    expect(queued.ms).toBeLessThan(400);
    for (const res of await Promise.all(hung)) expect(res.status).toBe(504);
    expect(await t.call("query", "app:count")).toEqual({ status: 200, body: { value: 0 } });
  });

  test("an abandoned query's late ctx.db call throws", async () => {
    const t = await start({ query: 50 });
    expect((await t.call("query", "app:lateRead")).status).toBe(504);
    expect(await lateResult("query").done).toBeInstanceOf(FunctionTimeoutError);
  });

  test("a timed-out subscription rerun sends an error and the subscription keeps working", async () => {
    const t = await start({ query: 100 });
    await t.engine.call("app:setFlag", { hang: false }, { userId: null, admin: false });
    const ws = new WebSocket(`${t.url.replace(/^http/, "ws")}/api/ws`);
    cleanups.push(() => ws.close());
    const inbox = nextValue<any>();
    ws.onmessage = (m) => inbox.push(JSON.parse(String(m.data)));
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: "sub", id: "s", path: "app:flagged" }));
    expect(await inbox.next()).toMatchObject({ id: "s", type: "data", value: 1 });

    await t.engine.call("app:setFlag", { hang: true }, { userId: null, admin: false });
    expect(await inbox.next()).toMatchObject({ id: "s", type: "error", error: { code: "FUNCTION_TIMEOUT" } });

    // Other queries were not held up, and the next change reruns the subscription.
    expect(await t.call("query", "app:count")).toMatchObject({ status: 200 });
    await t.engine.call("app:setFlag", { hang: false }, { userId: null, admin: false });
    expect(await inbox.next()).toMatchObject({ id: "s", type: "data", value: 1 });
  });
});

describe("subscriptions", () => {
  async function subscribe(t: Awaited<ReturnType<typeof start>>) {
    const ws = new WebSocket(`${t.url.replace(/^http/, "ws")}/api/ws`);
    cleanups.push(() => ws.close());
    const frames: any[] = [];
    ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: "sub", id: "s", path: "app:flagged" }));
    return frames;
  }
  const setFlag = (t: Awaited<ReturnType<typeof start>>, hang: boolean) =>
    t.engine.call("app:setFlag", { hang }, { userId: null, admin: false });

  test("a change committed while a rerun hangs reruns it after the timeout", async () => {
    const t = await start({ query: 300 });
    await setFlag(t, false);
    const frames = await subscribe(t);
    await until(() => frames.length === 1);
    await setFlag(t, true);
    await Bun.sleep(100);
    // The rerun is hanging now; this change lands while it runs.
    await setFlag(t, false);
    await until(() => frames.length === 3);
    expect(frames.map((f) => f.type)).toEqual(["data", "error", "data"]);
    expect(frames[1].error.code).toBe("FUNCTION_TIMEOUT");
    expect(frames[2].value).toBe(1);
  });

  test("a subscription whose first run timed out reruns on the next change", async () => {
    const t = await start({ query: 100 });
    await setFlag(t, true);
    const frames = await subscribe(t);
    await until(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ type: "error", error: { code: "FUNCTION_TIMEOUT" } });
    await setFlag(t, false);
    await until(() => frames.length === 2);
    expect(frames[1]).toMatchObject({ type: "data", value: 1 });
  });

  test("without a timeout, a query that throws on its first run is not rerun by changes (as before)", async () => {
    const t = await start();
    await t.engine.call("app:add", { body: "x" }, { userId: null, admin: false });
    const ws = new WebSocket(`${t.url.replace(/^http/, "ws")}/api/ws`);
    cleanups.push(() => ws.close());
    const frames: any[] = [];
    ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: "sub", id: "s", path: "app:throws" }));
    await until(() => frames.length === 1);
    expect(frames[0].type).toBe("error");
    await t.engine.call("app:add", { body: "y" }, { userId: null, admin: false });
    await Bun.sleep(100);
    expect(t.engine.realtime.stats()).toMatchObject([{ path: "app:throws", runs: 1 }]);
  });
});

describe("actions", () => {
  test("an action past its deadline gets 504", async () => {
    const t = await start({ action: 100 });
    const res = await t.call("action", "app:hangAction");
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("FUNCTION_TIMEOUT");
  });

  test("an abandoned action's later ctx calls throw and write nothing", async () => {
    const t = await start({ action: 50 });
    expect((await t.call("action", "app:lateAction")).status).toBe(504);
    expect(await lateResult("action").done).toBeInstanceOf(FunctionTimeoutError);
    expect((await t.call("action", "app:lateActionScheduler")).status).toBe(504);
    expect(await lateResult("actionScheduler").done).toBeInstanceOf(FunctionTimeoutError);
    expect(t.notes()).toEqual([]);
    expect(t.engine.store.read.query(`SELECT COUNT(*) AS n FROM _scheduled`).get()).toEqual({ n: 0 });
  });

  test("an httpAction past its deadline gets 504, and its late calls throw", async () => {
    const t = await start({ http: 50 });
    const res = await fetch(`${t.url}/hang`);
    expect(res.status).toBe(504);
    expect(((await res.json()) as any).error.code).toBe("FUNCTION_TIMEOUT");
    expect(await (await fetch(`${t.url}/quick`)).text()).toBe("ok");

    expect((await fetch(`${t.url}/late`)).status).toBe(504);
    expect(await lateResult("http").done).toBeInstanceOf(FunctionTimeoutError);
    expect(t.notes()).toEqual([]);
  });
});

describe("scheduled jobs", () => {
  test("a job past the mutation deadline is marked failed and the scheduler carries on", async () => {
    const t = await start({ mutation: 100 });
    // Both are claimed together, so okJob waits for the write lock behind hangJob: a job's deadline starts only once it holds the lock.
    const ids = await t.engine.writeTx(async (s) => [
      await t.engine.scheduler.forSession(s).runAfter(0, "app:hangJob"),
      await t.engine.scheduler.forSession(s).runAfter(0, "app:okJob"),
    ]);
    const job = (id: string) => {
      const row = t.engine.store.read.query(`SELECT data FROM _scheduled WHERE _id = ?`).get(id) as { data: string };
      return JSON.parse(row.data);
    };
    await until(() => ["failed", "success"].includes(job(ids[0]!).state) && job(ids[1]!).state === "success");
    expect(job(ids[0]!).state).toBe("failed");
    expect(job(ids[0]!).error).toContain("FUNCTION_TIMEOUT");
    expect(t.notes()).toEqual([{ body: "job ran" }]);

    const again = await t.engine.writeTx((s) => t.engine.scheduler.forSession(s).runAfter(0, "app:okJob"));
    await until(() => job(again).state === "success");
  });
});

describe("without --timeouts", () => {
  test("nothing times out", async () => {
    const t = await start();
    expect(t.engine.deadlineFor("mutation", "app:slowMutation")).toBeUndefined();
    expect(t.engine.deadlineFor("http", "GET /quick")).toBeUndefined();
    const res = await t.call("mutation", "app:slowMutation", { ms: 300 });
    expect(res.status).toBe(200);
    expect(t.notes()).toEqual([{ body: "slow" }]);
  });

  test("a deadline for one kind leaves the others alone", async () => {
    const t = await start({ query: 50 });
    expect((await t.call("mutation", "app:slowMutation", { ms: 200 })).status).toBe(200);
  });
});

describe("serve --timeouts", () => {
  const SCHEMA = `import { defineSchema, defineTable, z } from "incibase/server";
export default defineSchema({ notes: defineTable({ body: z.string() }) });
`;
  const APP = `import { mutation } from "incibase/server";
export const hang = mutation({ handler: () => new Promise(() => {}) });
export const add = mutation({ handler: async (ctx) => ctx.db.insert("notes", { body: "x" }) });
`;

  function project() {
    const root = dir();
    const source = join(root, "app");
    mkdirSync(source);
    writeFileSync(join(source, "schema.ts"), SCHEMA);
    writeFileSync(join(source, "app.ts"), APP);
    return { source, data: join(root, "data") };
  }

  function env(extra: Record<string, string> = {}) {
    const { INCIBASE_ADMIN_KEY: _k, INCIBASE_LOG_FORMAT: _f, INCIBASE_TIMEOUTS: _t, ...rest } = process.env;
    return { ...rest, ...extra };
  }

  async function serve(args: string[], extraEnv: Record<string, string> = {}) {
    const { source, data } = project();
    const proc = Bun.spawn([process.execPath, CLI, "serve", "--dir", source, "--data", data, "--port", "0", "--host", "127.0.0.1", "--log-format", "json", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: env(extraEnv),
    });
    cleanups.push(async () => {
      proc.kill("SIGKILL");
      await proc.exited;
    });
    let stdout = "";
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) stdout += decoder.decode(chunk, { stream: true });
    })();
    const events = () =>
      stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    return { proc, events };
  }

  test("a hung mutation gets 504 and a timeout event in the log", async () => {
    const { events } = await serve(["--timeouts", "mutation=100ms"]);
    await until(() => events().some((e) => e.ev === "ready"), 15_000);
    const ready = events().find((e) => e.ev === "ready");
    expect(ready.timeouts).toEqual({ mutation: 100 });
    const post = (path: string) =>
      fetch(`${ready.listen}/api/mutation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
    expect((await post("app:hang")).status).toBe(504);
    expect((await post("app:add")).status).toBe(200);
    await until(() => events().some((e) => e.ev === "timeout"));
    expect(events().find((e) => e.ev === "timeout")).toMatchObject({ level: "warn", type: "mutation", path: "app:hang", ms: 100 });
    expect(typeof events().find((e) => e.ev === "timeout").rid).toBe("string");
  });

  test("INCIBASE_TIMEOUTS applies when the flag is absent", async () => {
    const { events } = await serve([], { INCIBASE_TIMEOUTS: "mutation=100ms" });
    await until(() => events().some((e) => e.ev === "ready"), 15_000);
    const ready = events().find((e) => e.ev === "ready");
    expect(ready.timeouts).toEqual({ mutation: 100 });
    const res = await fetch(`${ready.listen}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "app:hang" }),
    });
    expect(res.status).toBe(504);
  });

  test("an invalid spec exits 64", async () => {
    const { proc, events } = await serve(["--timeouts", "mutation=10 seconds"]);
    expect(await proc.exited).toBe(ExitCode.CONFIG);
    await until(() => events().some((e) => e.ev === "fatal"));
    expect(events().find((e) => e.ev === "fatal").msg).toContain("mutation timeout");
  });

  test("without the flag the ready event has no timeouts", async () => {
    const { events } = await serve([]);
    await until(() => events().some((e) => e.ev === "ready"), 15_000);
    expect(events().find((e) => e.ev === "ready").timeouts).toBeUndefined();
  });
});
