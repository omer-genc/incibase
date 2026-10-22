import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLogFormat, ridFrom, stripQuery } from "../src/engine/log.ts";
import { readMeta } from "../src/engine/store.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const ADMIN_KEY = "ik_admin_logging_test_key_must_never_be_printed";
const CLIENT_RID = "client-rid-1234";

const dirs: string[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill("SIGKILL");
    await p.exited;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const APP = `import { IncibaseError, mutation, query, internalMutation, httpAction, httpRouter, z } from "incibase/server";

export const hello = query({
  args: { name: z.string() },
  handler: async (_ctx, { name }) => {
    console.log("hello %s", name, { n: 1 });
    console.warn("careful");
    console.error(new Error("tenant error object"));
    return name;
  },
});

export const consoles = query({
  handler: async () => {
    console.table([{ a: 1 }, { a: 2 }]);
    console.dir({ x: { y: { z: 1 } } }, { depth: 0 });
    console.trace("traced");
    console.count("c");
    console.count("c");
    console.time("t");
    console.timeEnd("t");
    console.group("grouped");
    console.groupEnd();
    console.assert(false, "asserted %d", 1);
    console.assert(true, "never printed");
    return 1;
  },
});

export const boom = mutation({ handler: async () => { throw new Error("kaboom internal"); } });

export const denied = query({ handler: async () => { throw new IncibaseError({ code: "FORBIDDEN", message: "nope" }); } });

export const me = query({ handler: async (ctx) => (await ctx.auth.getUserId()) !== null });

export const slow = query({ handler: async () => { await Bun.sleep(1100); return 1; } });

export const watch = query({
  handler: async (ctx) => {
    const notes = await ctx.db.query("notes").collect();
    console.log("watch ran with", notes.length);
    return notes.length;
  },
});

export const add = mutation({ handler: async (ctx) => { await ctx.db.insert("notes", { body: "x" }); } });

export const later = mutation({ handler: async (ctx) => { await ctx.scheduler.runAfter(0, "app:job" as any); } });

export const job = internalMutation({ handler: async () => { console.log("from job"); } });
`;

const HTTP = `import { httpAction, httpRouter } from "incibase/server";
const http = httpRouter();
http.route({ path: "/hook", method: "GET", handler: httpAction(async () => { console.info("hook called"); return new Response("ok"); }) });
export default http;
`;

const SCHEMA = `import { defineSchema, defineTable, z } from "incibase/server";
export default defineSchema({ notes: defineTable({ body: z.string() }) });
`;

function project(files: Record<string, string> = { "schema.ts": SCHEMA, "app.ts": APP, "http.ts": HTTP }) {
  const root = tempDir();
  dirs.push(root);
  const source = join(root, "app");
  mkdirSync(source);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  return { source, data: join(root, "data") };
}

/** The environment for child processes, without the caller's log settings. */
function childEnv(extra: Record<string, string> = {}) {
  const { INCIBASE_ADMIN_KEY: _k, INCIBASE_LOG_FORMAT: _f, INCIBASE_LOG_CALLS: _c, NO_COLOR: _n, FORCE_COLOR: _fc, ...env } = process.env;
  return { ...env, ...extra };
}

/** Starts the CLI and collects its output. */
function spawn(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe", env: childEnv(env) });
  procs.push(proc);
  const out = { stdout: "", stderr: "" };
  const done = Promise.all(
    (["stdout", "stderr"] as const).map(async (name) => {
      const decoder = new TextDecoder();
      for await (const chunk of proc[name] as ReadableStream<Uint8Array>) out[name] += decoder.decode(chunk, { stream: true });
    }),
  );
  const until = async (test: () => boolean, what: string) => {
    for (const end = Date.now() + 15_000; !test(); await Bun.sleep(25)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}:\n${out.stdout}\n${out.stderr}`);
    }
  };
  return {
    proc,
    out,
    until,
    /** Stops the process (`kill: false` waits for it to exit on its own) and returns everything it printed. */
    async stop({ kill = true } = {}) {
      if (kill) proc.kill("SIGTERM");
      const code = await proc.exited;
      await done;
      return { ...out, code };
    },
  };
}

const lines = (text: string) => text.split("\n").filter((l) => l.length > 0);
const events = (text: string) => lines(text).map((l) => JSON.parse(l) as Record<string, any>);

async function readyUrl(run: ReturnType<typeof spawn>): Promise<string> {
  await run.until(() => lines(run.out.stdout).some((l) => l.includes(`"ev":"ready"`)), "the ready line");
  return events(run.out.stdout).find((e) => e.ev === "ready")!.listen;
}

const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("json log format", () => {
  test("every line is JSON, console output carries the request id, and no secret is printed", async () => {
    const { source, data } = project();
    const run = spawn(["serve", "--dir", source, "--data", data, "--port", "0", "--host", "127.0.0.1", "--log-format", "json"], {
      INCIBASE_ADMIN_KEY: ADMIN_KEY,
    });
    const url = await readyUrl(run);

    const hello = await post(url, "/api/query", { path: "app:hello", args: { name: "world" } }, { "x-request-id": CLIENT_RID });
    expect(await hello.json()).toEqual({ value: "world" });
    expect(hello.headers.get("x-request-id")).toBe(CLIENT_RID);

    const generated = await post(url, "/api/query", { path: "app:hello", args: { name: "again" } });
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    // A header that is not a usable id is cleaned up, not echoed as is.
    const dirty = await post(url, "/api/query", { path: "app:hello", args: { name: "x" } }, { "x-request-id": `${"a".repeat(200)}` });
    expect(dirty.headers.get("x-request-id")).toBe("a".repeat(128));

    expect(await (await post(url, "/api/query", { path: "app:consoles" }, { "x-request-id": "consoles-rid" })).json()).toEqual({ value: 1 });
    expect((await post(url, "/api/mutation", { path: "app:boom" })).status).toBe(500);
    expect((await post(url, "/api/query", { path: "app:denied" })).status).toBe(403);
    expect((await post(url, "/api/query", { path: "app:hello", args: { name: 1 } })).status).toBe(400);
    expect((await post(url, "/api/query", { path: "app:slow" })).status).toBe(200);

    const signup = await post(url, "/api/auth/signup", { email: "a@example.com", password: "password123" });
    const { token } = (await signup.json()) as { token: string };
    expect(token.length).toBeGreaterThan(10);
    const me = await post(url, "/api/query", { path: "app:me" }, { authorization: `Bearer ${token}` });
    expect(await me.json()).toEqual({ value: true });

    const admin = { authorization: `Bearer ${ADMIN_KEY}` };
    expect((await post(url, "/api/admin/admin_overview", {}, admin)).status).toBe(200);
    expect((await post(url, "/api/admin/admin_get_document", { nope: 1 }, admin)).status).toBe(400);
    const badSql = await post(url, "/api/admin/admin_sql", { query: "SELECT p_ssw0rd_secret FROM notes" }, admin);
    expect(await badSql.text()).toContain("no such column: p_ssw0rd_secret");
    expect((await post(url, "/api/admin/admin_sql", { query: "SELECT count(*) AS n FROM notes" }, admin)).status).toBe(200);
    const mcp = await post(url, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "admin_schema", arguments: {} } }, admin);
    expect(mcp.status).toBe(200);

    expect(await (await fetch(`${url}/hook?token=secret-in-query`)).text()).toBe("ok");

    // A subscription reruns after a write, each run with an id of its own.
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/api/ws`);
    const pushed: unknown[] = [];
    ws.onmessage = (m) => pushed.push(JSON.parse(String(m.data)));
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: "sub", id: "s1", path: "app:watch" }));
    await run.until(() => pushed.length >= 1, "the first subscription result");
    await post(url, "/api/mutation", { path: "app:add" });
    await run.until(() => pushed.length >= 2, "the rerun");
    ws.close();

    await post(url, "/api/mutation", { path: "app:later" });
    await run.until(() => run.out.stdout.includes("from job"), "the scheduled job");

    const { stdout, stderr, code } = await run.stop();
    expect(code).toBe(0);
    const all = events(stdout); // throws on any line that is not JSON
    for (const e of all) {
      expect(typeof e.t).toBe("string");
      expect(new Date(e.t).toISOString()).toBe(e.t);
      expect(["debug", "info", "warn", "error"]).toContain(e.level);
      expect(typeof e.ev).toBe("string");
    }
    expect(stdout + stderr).not.toContain("\x1b");
    for (const secret of [ADMIN_KEY, token, "secret-in-query", "p_ssw0rd_secret"]) expect(stdout + stderr).not.toContain(secret);

    expect(all.filter((e) => e.ev === "ready")).toHaveLength(1);
    // One event per migration: migrate()'s, not a second copy from serve.
    expect(all.filter((e) => e.ev === "migration_committed").map((e) => e.createdTables)).toEqual([["notes"]]);
    expect(all.filter((e) => e.ev === "migration")).toEqual([]);

    const consoleOf = (msg: string) => all.filter((e) => e.ev === "console" && String(e.msg).startsWith(msg));
    const [first] = consoleOf("hello world");
    expect(first).toMatchObject({ level: "info", msg: "hello world { n: 1 }", rid: CLIENT_RID });
    expect(consoleOf("careful").map((e) => e.level)).toContain("warn");
    const tenantError = consoleOf("Error: tenant error object")[0]!;
    expect(tenantError.level).toBe("error");
    expect(consoleOf("hello again")[0]!.rid).toBe(generated.headers.get("x-request-id")!);
    expect(consoleOf("hook called")[0]!.rid).toMatch(/^[0-9a-f-]{36}$/);

    // Every console method gives one line, not raw text.
    const others = all.filter((e) => e.ev === "console" && e.rid === "consoles-rid");
    expect(others.map((e) => [e.level, e.msg])).toEqual([
      ["info", "[ { a: 1 }, { a: 2 } ]"],
      ["info", "{ x: [Object] }"],
      ["debug", "traced"],
      ["info", "c: 1"],
      ["info", "c: 2"],
      ["info", expect.stringMatching(/^t: \d+\.\d{3}ms$/)],
      ["info", "grouped"],
      ["error", "Assertion failed: asserted 1"],
    ]);
    expect(others[2]!.stack).toStartWith("Trace: traced\n    at ");

    const runs = consoleOf("watch ran with");
    expect(runs.map((e) => e.msg)).toEqual(["watch ran with 0", "watch ran with 1"]);
    expect(new Set(runs.map((e) => e.rid)).size).toBe(2);
    const job = consoleOf("from job")[0]!;
    expect(job.rid).toMatch(/^[0-9a-f-]{36}$/);

    // Failed calls are logged, an unexpected error with its stack; fast successful ones are not.
    const calls = all.filter((e) => e.ev === "call");
    const boom = calls.find((e) => e.path === "app:boom")!;
    expect(boom).toMatchObject({ level: "error", type: "mutation", ok: false, error: "kaboom internal" });
    expect(boom.stack).toContain("kaboom internal");
    expect(all.filter((e) => e.ev === "error" && String(e.error).includes("kaboom"))).toHaveLength(0);
    expect(calls.find((e) => e.path === "app:denied")).toMatchObject({ ok: false, error: `{"code":"FORBIDDEN","message":"nope"}` });
    expect(calls.find((e) => e.path === "app:denied")!.stack).toBeUndefined();
    expect(calls.find((e) => e.path === "app:slow")).toMatchObject({ ok: true, slow: true, level: "warn" });
    expect(calls.some((e) => e.path === "app:hello" && e.ok)).toBe(false);
    expect(calls.some((e) => e.path === "app:me")).toBe(false);

    const adminEvents = all.filter((e) => e.ev === "admin").map(({ tool, via, ok }) => ({ tool, via, ok }));
    expect(adminEvents).toEqual([
      { tool: "admin_overview", via: "http", ok: true },
      { tool: "admin_get_document", via: "http", ok: false },
      { tool: "admin_sql", via: "http", ok: false },
      { tool: "admin_sql", via: "http", ok: true },
      { tool: "admin_schema", via: "mcp", ok: true },
    ]);
    // A failed admin_sql call is logged by its error code and a hash of the query, never the text.
    const [failedSql, sqlOk] = all.filter((e) => e.ev === "admin" && e.tool === "admin_sql");
    expect(failedSql).toMatchObject({ code: "SQL_ERROR", sql: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(failedSql!.error).toBeUndefined();
    expect(sqlOk!.sql).toMatch(/^[0-9a-f]{16}$/);
    expect(sqlOk!.sql).not.toBe(failedSql!.sql);
    expect(all.find((e) => e.ev === "admin" && e.tool === "admin_get_document")!.error).toStartWith("Invalid arguments");
    expect(all.slice(-2).map((e) => e.ev)).toEqual(["stopping", "stopped"]);
  }, 30_000);

  test("INCIBASE_LOG_FORMAT selects json, and INCIBASE_LOG_CALLS=all logs every call", async () => {
    const { source, data } = project();
    const run = spawn(["serve", "--dir", source, "--data", data, "--port", "0", "--host", "127.0.0.1"], {
      INCIBASE_LOG_FORMAT: "json",
      INCIBASE_LOG_CALLS: "all",
    });
    const url = await readyUrl(run);
    await post(url, "/api/query", { path: "app:me" });
    const { stdout } = await run.stop();
    expect(events(stdout).find((e) => e.ev === "call" && e.path === "app:me")).toMatchObject({ ok: true, level: "info" });
  }, 20_000);

  test("dev in json mode prints only JSON and never the admin key", async () => {
    const { source, data } = project();
    const run = spawn(["dev", "--dir", source, "--data", data, "--port", "0", "--host", "127.0.0.1", "--log-format", "json"], {});
    const url = await readyUrl(run);
    expect((await post(url, "/api/mutation", { path: "app:boom" })).status).toBe(500);
    writeFileSync(join(source, "extra.ts"), `import { query } from "incibase/server";\nexport const x = query({ handler: async () => 1 });\n`);
    await run.until(() => events(run.out.stdout).some((e) => e.ev === "ready" && e.restart), "the restart");
    const { stdout, stderr } = await run.stop();
    const all = events(stdout);
    expect(all.some((e) => e.ev === "restarting" && e.file.endsWith("extra.ts"))).toBe(true);
    expect(all.find((e) => e.ev === "call" && e.path === "app:boom")?.stack).toContain("kaboom internal");
    const key = readMeta(join(data, "data.db"), "admin_key")!;
    expect(key).toStartWith("ik_admin_");
    expect(stdout + stderr).not.toContain(key);
    expect(stdout + stderr).not.toContain("\x1b");
  }, 30_000);

  test("a start failure is one fatal line with its exit code", async () => {
    const { source, data } = project({ "schema.ts": `export default { tables: {} };\n` });
    const run = spawn(["serve", "--dir", source, "--data", data, "--port", "0", "--log-format", "json"], {});
    const { stdout, code } = await run.stop({ kill: false });
    expect(code).toBe(78);
    expect(events(stdout)).toEqual([expect.objectContaining({ ev: "fatal", level: "error", exitCode: 78, reason: "invalid app definition" })]);
  }, 20_000);

  test("a flag that does not parse is a fatal line too when --log-format json is given", async () => {
    for (const flag of [["--log-format", "json"], ["--log-format=json"]]) {
      const { stdout, stderr, code } = await spawn(["serve", ...flag, "--bogus"], {}).stop({ kill: false });
      expect(code).toBe(64);
      expect(stderr).toBe("");
      expect(events(stdout)).toEqual([expect.objectContaining({ ev: "fatal", level: "error", exitCode: 64, msg: expect.stringContaining("--bogus") })]);
    }
    // The flag wins over the environment, as when the flags parse.
    const text = await spawn(["serve", "--log-format", "text", "--bogus"], { INCIBASE_LOG_FORMAT: "json" }).stop({ kill: false });
    expect(text.code).toBe(64);
    expect(text.stdout).toContain("Usage: incibase");
  }, 20_000);

  test("an unknown format exits 64", async () => {
    const { source, data } = project();
    const flag = await spawn(["serve", "--dir", source, "--data", data, "--port", "0", "--log-format", "xml"], {}).stop({ kill: false });
    expect(flag.code).toBe(64);
    expect(flag.stderr).toContain(`Invalid log format "xml"`);
    const env = await spawn(["serve", "--dir", source, "--data", data, "--port", "0"], { INCIBASE_LOG_FORMAT: "yaml" }).stop({ kill: false });
    expect(env.code).toBe(64);
  }, 20_000);
});

/** A port nothing listens on right now: the text banner does not show the one --port 0 picked. */
function freePort() {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return String(port);
}

describe("text log format", () => {
  test("NO_COLOR removes every ANSI escape; without it the terminal output keeps its colors", async () => {
    for (const [env, colored] of [
      [{ NO_COLOR: "1" }, false],
      [{}, true],
    ] as const) {
      const { source, data } = project();
      // `incibase dev` creates it before starting the server this runs.
      mkdirSync(join(source, "_generated"));
      const port = freePort();
      const run = spawn(["serve", "--dev", "--dir", source, "--data", data, "--port", port, "--host", "127.0.0.1"], { ...env });
      await run.until(() => run.out.stdout.includes("Admin key"), "the banner");
      // The dev banner still prints the admin key in text mode.
      expect(run.out.stdout).toContain(readMeta(join(data, "data.db"), "admin_key")!);
      expect((await post(`http://127.0.0.1:${port}`, "/api/mutation", { path: "app:boom" })).status).toBe(500);
      await run.until(() => run.out.stdout.includes("app:boom"), "the call line");
      const { stdout, stderr } = await run.stop();
      expect((stdout + stderr).includes("\x1b")).toBe(colored);
      expect(stdout).toContain("[mutation] app:boom");
      expect(stdout).toContain("+ table notes");
    }
  }, 30_000);
});

describe("request ids and urls", () => {
  test("a client's id is kept when printable and short, cleaned up otherwise", () => {
    expect(ridFrom("abc-123")).toBe("abc-123");
    expect(ridFrom("a b\tcé\n")).toBe("abc");
    expect(ridFrom("x".repeat(500))).toBe("x".repeat(128));
    expect(ridFrom(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(ridFrom(" \u0007 ")).toMatch(/^[0-9a-f-]{36}$/);
    expect(ridFrom(undefined)).not.toBe(ridFrom(undefined));
  });

  test("query strings and fragments are stripped from logged urls", () => {
    expect(stripQuery("https://x.test/api/storage/abc?sig=secret&exp=1")).toBe("https://x.test/api/storage/abc");
    expect(stripQuery("https://x.test/a#token=1")).toBe("https://x.test/a");
    expect(stripQuery("https://x.test/a")).toBe("https://x.test/a");
  });

  test("the format comes from the flag, then the environment", () => {
    const saved = process.env.INCIBASE_LOG_FORMAT;
    try {
      delete process.env.INCIBASE_LOG_FORMAT;
      expect(parseLogFormat(undefined)).toBe("text");
      expect(parseLogFormat("json")).toBe("json");
      expect(parseLogFormat("pretty")).toBe("text");
      process.env.INCIBASE_LOG_FORMAT = "json";
      expect(parseLogFormat(undefined)).toBe("json");
      expect(parseLogFormat("text")).toBe("text");
      expect(() => parseLogFormat("xml")).toThrow(`Invalid log format "xml"`);
    } finally {
      if (saved === undefined) delete process.env.INCIBASE_LOG_FORMAT;
      else process.env.INCIBASE_LOG_FORMAT = saved;
    }
  });
});
