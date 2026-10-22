// Problems that only show when M1's features run together (a review of the
// merged steps 1-8): drain and the client's retry, migrations and the
// database cap, uploads and the quota, and serve's start order.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { IncibaseClient } from "incibase/client";
import { action, defineSchema, defineTable, mutation, query, z } from "incibase/server";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { startServer } from "../src/engine/http.ts";
import { memoryStorage, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const engines: Engine[] = [];
const servers: { stop: (force?: boolean) => unknown }[] = [];

function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

function open(app: AppDefinition, dataDir = dir(), options: Partial<ConstructorParameters<typeof Engine>[1]> = {}) {
  const engine = new Engine(app, { dataDir, quiet: true, publicUrl: "http://localhost", ...options });
  engines.push(engine);
  return engine;
}

function serve(engine: Engine) {
  const server = startServer(engine, { port: 0, hostname: "127.0.0.1" });
  servers.push(server);
  engine.options.publicUrl = server.url.origin;
  return server.url.origin;
}

async function until(check: () => unknown, what: string, timeoutMs = 5000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const e of engines.splice(0)) await e.stop().catch(() => {});
});

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A drain that runs out, and the client's retry of unprocessed calls

describe("calls a drain cuts", () => {
  const started = { hang: 0 };
  const app: AppDefinition = {
    schema: defineSchema({ notes: defineTable({ body: z.string() }) }),
    modules: {
      app: {
        hang: mutation({
          args: { body: z.string() },
          handler: async (ctx: any, { body }: { body: string }) => {
            await ctx.db.insert("notes", { body });
            started.hang++;
            await new Promise(() => {});
          },
        }),
        add: mutation({ args: { body: z.string() }, handler: (ctx: any, { body }: { body: string }) => ctx.db.insert("notes", { body }) }),
        notes: query({ handler: async (ctx: any) => (await ctx.db.query("notes").collect()).map((n: { body: string }) => n.body) }),
        slowAction: action({ handler: () => new Promise(() => {}) }),
      },
    },
  };

  test("a cut mutation is a 503 marked unprocessed, which the client sends again; a cut action is not marked", async () => {
    started.hang = 0;
    const stopping = open(app);
    const stoppingUrl = serve(stopping);
    // The process that comes back after the restart: same app, its own data.
    const next = open(app);
    const nextUrl = serve(next);

    const raw = fetch(`${stoppingUrl}/api/mutation`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ path: "app:hang", args: { body: "raw" } }),
    });
    const action = fetch(`${stoppingUrl}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "app:slowAction" }),
    });
    await until(() => started.hang === 1 && stopping.runningCalls().includes("app:slowAction"), "the calls to start");
    stopping.cutCalls();
    const res = await raw;
    expect(res.status).toBe(503);
    expect(res.headers.get("x-incibase-unprocessed")).toBe("1");
    expect(res.headers.get("retry-after")).toBe("1");
    // A browser may read it.
    expect(res.headers.get("access-control-expose-headers")).toContain("x-incibase-unprocessed");
    expect((await res.json()).error).toMatchObject({ code: "SERVER_STOPPING", data: { unprocessed: true } });
    const interrupted = await action;
    expect(interrupted.status).toBe(503);
    expect(interrupted.headers.get("x-incibase-unprocessed")).toBeNull();
    expect((await interrupted.json()).error.code).toBe("ACTION_INTERRUPTED");

    // The client: its first attempt reaches the stopping server and is cut; it sends the mutation again, to the next one.
    started.hang = 0;
    const stopping2 = open(app);
    const stopping2Url = serve(stopping2);
    const sentTo: string[] = [];
    const client = new IncibaseClient(stopping2Url, {
      tokenStorage: memoryStorage(),
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const target = sentTo.length === 0 ? url : url.replace(stopping2Url, nextUrl);
        sentTo.push(target.startsWith(nextUrl) ? "next" : "stopping");
        // The stopping server gets the hanging mutation; the next one gets the same call as a plain add.
        const body = sentTo.length === 1 ? init?.body : String(init?.body).replace("app:hang", "app:add");
        return fetch(target, { ...init, body });
      }) as typeof fetch,
    });
    const call = client.mutation("app:hang" as any, { body: "resent" });
    await until(() => started.hang === 1, "the first attempt to start");
    stopping2.cutCalls();
    expect(await call).toBeString();
    expect(sentTo).toEqual(["stopping", "next"]);
    // Nothing of the cut attempt was kept; the resent one was.
    expect((await stopping2.readTx((s) => s.query("notes").collect())).result).toEqual([]);
    expect((await next.readTx((s) => s.query("notes").collect())).result.map((n) => n.body)).toEqual(["resent"]);
  });
});
