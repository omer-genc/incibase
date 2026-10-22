import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { defineSchema, defineTable, id, makeFunctionReference, z } from "incibase";
import { mutation, query } from "incibase/server";
import * as dashboard from "../src/engine/dashboard.ts";
import { Engine } from "../src/engine/engine.ts";
import { startServer, type ServeOptions } from "../src/engine/http.ts";
import { MAX_SUBSCRIPTIONS_PER_SOCKET } from "../src/engine/realtime.ts";
import type { StorageOptions } from "../src/engine/storage.ts";
import { nextValue, startTestServer, tempDir } from "./helpers.ts";

const schema = defineSchema({
  notes: defineTable({ owner: id("_users"), text: z.string() }),
});

const modules = {
  users: {
    /** The caller, plus a read of `notes` so writes there rerun it. */
    me: query({
      handler: async (ctx: any) => ({ userId: await ctx.auth.getUserId(), notes: (await ctx.db.query("notes").collect()).length }),
    }),
    /** Like `me`, but signed-out callers get an error. */
    required: query({
      handler: async (ctx: any) => ({ userId: (await ctx.auth.requireUser())._id, notes: (await ctx.db.query("notes").collect()).length }),
    }),
    get: query({ args: { id: z.string() }, handler: (ctx: any, { id }: any) => ctx.db.get(id) }),
  },
  notes: {
    add: mutation({
      args: { text: z.string() },
      handler: async (ctx: any, { text }: any) => ctx.db.insert("notes", { owner: (await ctx.auth.requireUser())._id, text }),
    }),
  },
  files: {
    uploadUrl: mutation({
      args: { maxBytes: z.number().optional() },
      handler: (ctx: any, { maxBytes }: any) => ctx.storage.generateUploadUrl({ maxBytes }),
    }),
  },
  tools: {
    boom: query({
      mcp: true,
      handler: () => {
        throw new Error("db password is hunter2");
      },
    }),
  },
};

const DAY = 24 * 60 * 60 * 1000;

let t: Awaited<ReturnType<typeof startTestServer>>;
/** Production mode (dev: false) with small limits. */
let prod: Awaited<ReturnType<typeof startProdServer>>;
const sockets: WebSocket[] = [];

async function startProdServer(serve: Partial<ServeOptions>, storage: StorageOptions) {
  const dataDir = tempDir();
  const engine = new Engine({ schema, modules }, { dataDir, quiet: true, publicUrl: "http://placeholder", storage });
  engine.start();
  const server = startServer(engine, { port: 0, hostname: "127.0.0.1", ...serve });
  engine.options.publicUrl = server.url.origin;
  return {
    engine,
    url: server.url.origin,
    async stop() {
      server.stop(true);
      await engine.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

beforeAll(async () => {
  t = await startTestServer({ schema, modules });
  prod = await startProdServer({ maxJsonBytes: 2000 }, { maxUploadBytes: 5000 });
});

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await t.stop();
  await prod.stop();
});

/** A raw WebSocket to /api/ws. `next` skips messages until one matches. */
async function connect(url: string, headers?: Record<string, string>) {
  // Bun's client accepts headers; the DOM typings in scope do not know the option.
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/api/ws`, { headers: headers ?? {} } as any);
  sockets.push(ws);
  const inbox = nextValue<any>();
  ws.onmessage = (event) => inbox.push(JSON.parse(String(event.data)));
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return {
    ws,
    closed,
    send: (msg: unknown) => ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)),
    async next(match: (msg: any) => boolean = () => true) {
      while (true) {
        const msg = await inbox.next();
        if (match(msg)) return msg;
      }
    },
  };
}

const post = (url: string, path: string, body: unknown, token?: string) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const json = async (res: Response) => (await res.json()) as any;

const callAdmin = async (tool: string, args: unknown) => json(await post(t.url, `/api/admin/${tool}`, args, t.engine.adminKey));

const rpc = async (url: string, body: unknown, token?: string) => json(await post(url, "/mcp", body, token));

let users = 0;
async function newUser() {
  const email = `user${++users}@example.com`;
  const { token, user } = await t.engine.auth.signUp({ email, password: "password123" });
  return { email, token, userId: user._id };
}

const me = async (token: string) => (await json(await fetch(`${t.url}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } }))).user;

/** A socket signed in as a new user, subscribed to `users:me` as "me". */
async function signedInSocket() {
  const user = await newUser();
  const s = await connect(t.url);
  s.send({ type: "auth", token: user.token });
  expect(await s.next((m) => m.type === "auth")).toEqual({ type: "auth", userId: user.userId });
  s.send({ type: "sub", id: "me", path: "users:me" });
  expect((await s.next((m) => m.id === "me")).value.userId).toBe(user.userId);
  return { ...user, s };
}

/** Waits for the socket to be signed out and its subscription to rerun as anonymous. */
async function expectDowngraded(s: Awaited<ReturnType<typeof connect>>) {
  expect(await s.next((m) => m.type === "auth")).toEqual({ type: "auth", userId: null });
  expect((await s.next((m) => m.id === "me")).value.userId).toBeNull();
}

function chunked(size: number, chunk = 1000) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < size; sent += chunk) controller.enqueue(new Uint8Array(Math.min(chunk, size - sent)).fill(120));
      controller.close();
    },
  });
}

const postStream = (url: string, size: number, token?: string) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: chunked(size),
    duplex: "half",
  } as RequestInit);

describe("malformed WebSocket messages", () => {
  test("get a BAD_MESSAGE error and the server stays up", async () => {
    const s = await connect(t.url);
    const bad: unknown[] = [
      "null",
      "123",
      "[]",
      '"auth"',
      "not json",
      {},
      { type: "nope" },
      { type: "auth", token: 123 },
      { type: "auth", token: { length: 1 } },
      { type: "sub" },
      { type: "sub", id: "1" },
      { type: "sub", id: 1, path: "users:me" },
      { type: "sub", id: "x".repeat(10_000), path: "users:me" },
      { type: "sub", id: "1", path: "p".repeat(10_000) },
      { type: "unsub" },
      { type: "unsub", id: null },
    ];
    for (const msg of bad) {
      s.send(msg);
      expect(await s.next()).toMatchObject({ type: "error", error: { code: "BAD_MESSAGE" } });
    }
    // The same socket still works, and so does the server.
    s.send({ type: "sub", id: "ok", path: "users:me" });
    expect(await s.next((m) => m.id === "ok")).toMatchObject({ type: "data", value: { userId: null } });
    expect((await fetch(`${t.url}/api/health`)).ok).toBe(true);
  });

  test("identify treats non-string tokens as anonymous", () => {
    for (const token of [123, {}, [], true, null, undefined, ""]) {
      expect(t.engine.auth.identify(token)).toEqual({ userId: null, admin: false });
    }
  });
});

describe("request limits", () => {
  const jsonRoutes = ["/api/query", "/api/mutation", "/api/action", "/api/auth/signin", "/api/auth/signup", "/api/admin/admin_overview", "/mcp"];

  test("JSON routes answer 413 to bodies over the limit, declared or chunked", async () => {
    const key = prod.engine.adminKey;
    for (const path of jsonRoutes) {
      const declared = await post(prod.url, path, "x".repeat(3000), key);
      expect([path, declared.status]).toEqual([path, 413]);
      expect((await json(declared)).error.code).toBe("PAYLOAD_TOO_LARGE");
      const streamed = await postStream(`${prod.url}${path}`, 3000, key);
      expect([path, streamed.status]).toEqual([path, 413]);
      expect((await json(streamed)).error.code).toBe("PAYLOAD_TOO_LARGE");
    }
    const ok = await post(prod.url, "/api/query", { path: "users:me", args: {} });
    expect((await json(ok)).value).toEqual({ userId: null, notes: 0 });
  });

  test("the default JSON limit is 1 MiB", async () => {
    const big = await post(t.url, "/api/auth/signin", { email: "a@example.com", password: "x".repeat(1024 * 1024) });
    expect(big.status).toBe(413);
    const fits = await post(t.url, "/api/auth/signin", { email: "a@example.com", password: "x".repeat(1000 * 1000) });
    expect((await json(fits)).error.code).toBe("VALIDATION_ERROR");
  });

  test("uploads count streamed bytes against the grant and the server limit", async () => {
    const mutate = async (args: unknown) => (await json(await post(prod.url, "/api/mutation", { path: "files:uploadUrl", args }))).value as string;
    const capped = await mutate({ maxBytes: 100 });
    for (const res of [await postStream(capped, 200), await fetch(capped, { method: "POST", body: "x".repeat(200) })]) {
      expect(res.status).toBe(413);
      expect((await json(res)).error.code).toBe("FILE_TOO_LARGE");
    }
    const small = await json(await postStream(capped, 100));
    expect((await prod.engine.readTx((s) => s.get(small.storageId))).result?.size).toBe(100);

    // No grant limit: maxUploadBytes (5000) still holds without a Content-Length.
    const open = await mutate({});
    const over = await postStream(open, 6000);
    expect(over.status).toBe(413);
    expect((await json(over)).error.code).toBe("FILE_TOO_LARGE");
    const fits = await json(await postStream(open, 5000));
    expect((await prod.engine.readTx((s) => s.get(fits.storageId))).result?.size).toBe(5000);
  });

  test("oversized WebSocket messages close only that connection", async () => {
    const s = await connect(prod.url);
    s.send({ type: "sub", id: "x".repeat(3000), path: "users:me" });
    await s.closed;
    const other = await connect(prod.url);
    other.send({ type: "sub", id: "ok", path: "users:me" });
    expect((await other.next((m) => m.id === "ok")).type).toBe("data");
  });

  test("a socket holds at most MAX_SUBSCRIPTIONS_PER_SOCKET subscriptions", async () => {
    const s = await connect(t.url);
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_SOCKET; i++) s.send({ type: "sub", id: `s${i}`, path: "users:me" });
    s.send({ type: "sub", id: "over", path: "users:me" });
    expect(await s.next((m) => m.id === "over")).toMatchObject({ type: "error", error: { code: "TOO_MANY_SUBSCRIPTIONS" } });
    // Changing an existing subscription and freeing a slot both work.
    s.send({ type: "sub", id: "s1", path: "users:get", args: { id: "none" } });
    expect(await s.next((m) => m.id === "s1" && m.value === null)).toMatchObject({ type: "data" });
    s.send({ type: "unsub", id: "s0" });
    s.send({ type: "sub", id: "over", path: "users:me" });
    expect(await s.next((m) => m.id === "over")).toMatchObject({ type: "data" });
  });

  // prod allows 2000 bytes. Keys are JSON [path, args, userId, admin]: 654 characters for these args when anonymous.
  const bigArgs = (name: string, size = 620) => ({ id: name.padEnd(size, "x") });
  const tooLarge = { type: "error", error: { code: "SUBSCRIPTIONS_TOO_LARGE" } };

  test("a socket's subscriptions hold at most maxJsonBytes of function paths and args", async () => {
    const s = await connect(prod.url);
    // Failed subscriptions count too: they keep their args.
    s.send({ type: "sub", id: "a", path: "nope:nope", args: bigArgs("a") });
    expect(await s.next((m) => m.id === "a")).toMatchObject({ type: "error", error: { code: "FUNCTION_NOT_FOUND" } });
    for (const id of ["b", "c"]) {
      s.send({ type: "sub", id, path: "users:get", args: bigArgs(id) });
      expect(await s.next((m) => m.id === id)).toMatchObject({ type: "data", value: null });
    }
    s.send({ type: "sub", id: "d", path: "users:get", args: bigArgs("d", 100) });
    expect(await s.next((m) => m.id === "d")).toMatchObject(tooLarge);

    // Growing an existing subscription past the budget is refused and drops it, which makes room.
    s.send({ type: "sub", id: "c", path: "users:get", args: bigArgs("c", 700) });
    expect(await s.next((m) => m.id === "c")).toMatchObject(tooLarge);
    expect(prod.engine.realtime.stats().some((sub) => (sub.args as { id?: string })?.id?.startsWith("c"))).toBe(false);
    s.send({ type: "sub", id: "d", path: "users:get", args: bigArgs("d", 100) });
    expect(await s.next((m) => m.id === "d")).toMatchObject({ type: "data", value: null });

    // Unsubscribing frees room as well.
    s.send({ type: "sub", id: "e", path: "users:get", args: bigArgs("e") });
    expect(await s.next((m) => m.id === "e")).toMatchObject(tooLarge);
    s.send({ type: "unsub", id: "a" });
    s.send({ type: "sub", id: "e", path: "users:get", args: bigArgs("e") });
    expect(await s.next((m) => m.id === "e")).toMatchObject({ type: "data", value: null });
  });

  test("signing in keeps subscriptions even when the user's longer keys pass the budget", async () => {
    const { token, user } = await prod.engine.auth.signUp({ email: "budget@example.com", password: "password123" });
    expect(3 * JSON.stringify(["users:get", bigArgs("a"), user._id, false]).length).toBeGreaterThan(2000);
    const s = await connect(prod.url);
    for (const id of ["a", "b", "c"]) {
      s.send({ type: "sub", id, path: "users:get", args: bigArgs(id) });
      expect(await s.next((m) => m.id === id)).toMatchObject({ type: "data", value: null });
    }
    s.send({ type: "auth", token });
    expect(await s.next((m) => m.type === "auth")).toEqual({ type: "auth", userId: user._id });
    const rekeyed = new Map<string, unknown>();
    while (rekeyed.size < 3) {
      const msg = await s.next((m) => ["a", "b", "c"].includes(m.id));
      rekeyed.set(msg.id, msg);
    }
    for (const msg of rekeyed.values()) expect(msg).toMatchObject({ type: "data", value: null });
    // Over the budget now, so nothing new fits until something goes.
    s.send({ type: "sub", id: "d", path: "users:get", args: bigArgs("d", 10) });
    expect(await s.next((m) => m.id === "d")).toMatchObject(tooLarge);
  });

  test("INCIBASE_MAX_JSON_BYTES sets the limit when ServeOptions does not", async () => {
    process.env.INCIBASE_MAX_JSON_BYTES = "500";
    const server = startServer(prod.engine, { port: 0, hostname: "127.0.0.1" });
    try {
      const url = server.url.origin;
      expect((await post(url, "/api/query", { path: "users:me", args: { pad: "x".repeat(600) } })).status).toBe(413);
      expect((await json(await post(url, "/api/query", { path: "users:me", args: {} }))).value.userId).toBeNull();
      for (const bad of ["0", "-5", "1.5", "lots"]) {
        process.env.INCIBASE_MAX_JSON_BYTES = bad;
        expect(() => startServer(prod.engine, { port: 0, hostname: "127.0.0.1" })).toThrow("INCIBASE_MAX_JSON_BYTES");
      }
    } finally {
      delete process.env.INCIBASE_MAX_JSON_BYTES;
      server.stop(true);
    }
  });
});

describe("production errors", () => {
  const quietConsole = () => spyOn(console, "error").mockImplementation(() => {});

  test("unhandled server errors return a generic 500 without details", async () => {
    const log = quietConsole();
    const engine = prod.engine as { http: unknown };
    const http = engine.http;
    engine.http = {
      match() {
        throw new Error("secret detail");
      },
    };
    try {
      const res = await fetch(`${prod.url}/anything`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
      expect(text).not.toContain("secret");
    } finally {
      engine.http = http;
      log.mockRestore();
    }
  });

  test("the dashboard and WebSocket routes do not leak errors either", async () => {
    const log = quietConsole();
    const html = spyOn(dashboard, "dashboardHtml").mockImplementation(() => Promise.reject(new Error("secret detail")));
    const auth = spyOn(prod.engine.auth, "authenticateRequest").mockImplementation(() => {
      throw new Error("secret detail");
    });
    try {
      for (const path of ["/_/", "/api/ws"]) {
        const res = await fetch(`${prod.url}${path}`);
        expect([path, res.status]).toEqual([path, 500]);
        expect(await res.text()).not.toContain("secret");
      }
    } finally {
      html.mockRestore();
      auth.mockRestore();
      log.mockRestore();
    }
  });

  test("MCP hides internal errors outside dev", async () => {
    const log = quietConsole();
    try {
      const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tools_boom", arguments: {} } };
      const { result } = await rpc(prod.url, call);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("INTERNAL_ERROR: Internal server error");
      expect(log).toHaveBeenCalled();
      // Dev keeps the detail.
      expect((await rpc(t.url, call)).result.content[0].text).toContain("hunter2");
      // Validation errors on admin tools are not internal, so admins still see them.
      const bad = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "admin_get_document", arguments: {} } };
      expect((await rpc(prod.url, bad, prod.engine.adminKey)).result.content[0].text).toStartWith("VALIDATION_ERROR");
    } finally {
      log.mockRestore();
    }
  });

  test("admins see what went wrong in an admin tool outside dev, without the stack", async () => {
    const log = quietConsole();
    try {
      const key = prod.engine.adminKey;
      const tool = async (name: string, args: unknown) =>
        (await rpc(prod.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, key)).result;
      const failures = [
        [await tool("admin_sql", { query: "SELECT nope FROM notes" }), "no such column: nope"],
        [await tool("admin_list_documents", { table: "nope" }), 'Unknown table "nope"'],
        [await tool("tools_boom", {}), "hunter2"],
      ] as const;
      for (const [result, message] of failures) {
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(message);
        expect(result.content[0].text).not.toContain("    at ");
      }
      // The dashboard's admin endpoint answers the same way.
      const { error } = await json(await post(prod.url, "/api/admin/admin_sql", { query: "SELECT nope FROM notes" }, key));
      expect(error.message).toContain("no such column: nope");
      expect(error.message).not.toContain("    at ");
      // Other callers still get nothing but the code.
      const anonymous = await rpc(prod.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tools_boom", arguments: {} } });
      expect(anonymous.result.content[0].text).toBe("INTERNAL_ERROR: Internal server error");
    } finally {
      log.mockRestore();
    }
  });
});

describe("user management", () => {
  test("the user tools are listed for admins", async () => {
    const { result } = await rpc(t.url, { jsonrpc: "2.0", id: 1, method: "tools/list" }, t.engine.adminKey);
    const names = result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["admin_delete_user", "admin_set_user_disabled", "admin_revoke_sessions"]));
  });

  test("a disabled user cannot sign in and their sessions stop working", async () => {
    const { email, token, userId } = await newUser();
    expect((await me(token))._id).toBe(userId);

    const { value } = await callAdmin("admin_set_user_disabled", { id: userId, disabled: true });
    expect(value.disabled).toBe(true);
    expect(await me(token)).toBeNull();
    // The right password gets the same answer as a wrong one, so guesses cannot be confirmed meanwhile.
    const refused = await json(await post(t.url, "/api/auth/signin", { email, password: "password123" }));
    const wrong = await json(await post(t.url, "/api/auth/signin", { email, password: "wrong-password" }));
    expect(refused.error).toEqual(wrong.error);
    expect(refused.error.code).toBe("INVALID_CREDENTIALS");

    const enabled = await callAdmin("admin_set_user_disabled", { id: userId, disabled: false });
    expect(enabled.value.disabled).toBeUndefined();
    const signedIn = await json(await post(t.url, "/api/auth/signin", { email, password: "password123" }));
    expect((await me(signedIn.token))._id).toBe(userId);
    // Sessions revoked by disabling stay revoked.
    expect(await me(token)).toBeNull();
  });

  test("a session made while the user is disabled does not identify them", async () => {
    const { userId } = await newUser();
    await callAdmin("admin_set_user_disabled", { id: userId, disabled: true });
    t.engine.store.write.query(`INSERT INTO _sessions VALUES (?, ?, ?, ?)`).run("raced", userId, Date.now(), Date.now() + DAY);
    expect(t.engine.auth.activeSession("raced")).toBeNull();
  });

  test("revoking sessions signs a user out everywhere", async () => {
    const { email, token, userId } = await newUser();
    const second = await t.engine.auth.signIn({ email, password: "password123" });
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "admin_revoke_sessions", arguments: { id: userId } } };
    expect((await rpc(t.url, call, t.engine.adminKey)).result.structuredContent).toEqual({ revoked: 2 });
    expect(await me(token)).toBeNull();
    expect(await me(second.token)).toBeNull();
  });

  test("deleting a user removes the account, password and sessions but keeps app documents", async () => {
    const { email, token, userId } = await newUser();
    const note = (await json(await post(t.url, "/api/mutation", { path: "notes:add", args: { text: "mine" } }, token))).value;

    expect((await callAdmin("admin_delete_user", { id: userId })).value).toEqual({ deleted: userId });
    const count = (sql: string) => (t.engine.store.write.query(sql).get(userId) as { n: number }).n;
    expect(count(`SELECT COUNT(*) AS n FROM _users WHERE _id = ?`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM _passwords WHERE user_id = ?`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM _sessions WHERE user_id = ?`)).toBe(0);
    expect(await me(token)).toBeNull();
    expect((await t.engine.readTx((s) => s.get(note))).result).toMatchObject({ owner: userId, text: "mine" });

    const signIn = await json(await post(t.url, "/api/auth/signin", { email, password: "password123" }));
    expect(signIn.error.code).toBe("INVALID_CREDENTIALS");
    expect((await t.engine.auth.signUp({ email, password: "password123" })).user._id).not.toBe(userId);

    expect((await callAdmin("admin_delete_user", { id: userId })).error.code).toBe("NOT_FOUND");
    expect((await callAdmin("admin_delete_user", { id: note })).error.code).toBe("NOT_FOUND");
  });

  test("the document tools still treat _users as read-only", async () => {
    const { userId } = await newUser();
    const res = await post(t.url, "/api/admin/admin_delete_document", { id: userId }, t.engine.adminKey);
    expect(res.ok).toBe(false);
    expect((await t.engine.readTx((s) => s.get(userId))).result).not.toBeNull();
  });

  test("subscriptions see user changes", async () => {
    const { userId } = await newUser();
    const s = await connect(t.url);
    s.send({ type: "auth", token: t.engine.adminKey });
    s.send({ type: "sub", id: "user", path: "users:get", args: { id: userId } });
    expect((await s.next((m) => m.id === "user")).value._id).toBe(userId);
    await callAdmin("admin_set_user_disabled", { id: userId, disabled: true });
    expect((await s.next((m) => m.id === "user")).value.disabled).toBe(true);
    await callAdmin("admin_delete_user", { id: userId });
    expect((await s.next((m) => m.id === "user")).value).toBeNull();
  });
});

describe("live sessions", () => {
  test("signing out downgrades the sockets using that session only", async () => {
    const a = await signedInSocket();
    const second = await t.engine.auth.signIn({ email: a.email, password: "password123" });
    const b = await connect(t.url);
    b.send({ type: "auth", token: second.token });
    expect((await b.next((m) => m.type === "auth")).userId).toBe(a.userId);

    await post(t.url, "/api/auth/signout", {}, a.token);
    await expectDowngraded(a.s);
    b.send({ type: "sub", id: "me", path: "users:me" });
    expect((await b.next((m) => m.id === "me")).value.userId).toBe(a.userId);
  });

  test("revoking, disabling, deleting and changing the password downgrade sockets", async () => {
    const actions: [string, (u: Awaited<ReturnType<typeof signedInSocket>>) => Promise<unknown>][] = [
      ["revoke", (u) => callAdmin("admin_revoke_sessions", { id: u.userId })],
      ["disable", (u) => callAdmin("admin_set_user_disabled", { id: u.userId, disabled: true })],
      ["delete", (u) => callAdmin("admin_delete_user", { id: u.userId })],
      ["password", (u) => post(t.url, "/api/auth/password", { currentPassword: "password123", newPassword: "password456" }, u.token)],
    ];
    for (const [, action] of actions) {
      const u = await signedInSocket();
      await action(u);
      await expectDowngraded(u.s);
    }
  });

  test("sockets authenticated at upgrade are tracked too", async () => {
    const { token, userId } = await newUser();
    const s = await connect(t.url, { authorization: `Bearer ${token}` });
    s.send({ type: "sub", id: "me", path: "users:me" });
    expect((await s.next((m) => m.id === "me")).value.userId).toBe(userId);
    await t.engine.auth.revokeAll(userId);
    await expectDowngraded(s);
  });

  test("expired sessions are dropped before reruns and new subscriptions", async () => {
    const rerun = await signedInSocket();
    const subscribe = await signedInSocket();
    setSystemTime(new Date(Date.now() + 31 * DAY));
    try {
      await t.engine.writeTx((s) => s.insert("notes", { owner: rerun.userId, text: "wakes users:me" }));
      await expectDowngraded(rerun.s);

      subscribe.s.send({ type: "sub", id: "late", path: "users:me" });
      expect(await subscribe.s.next((m) => m.type === "auth")).toEqual({ type: "auth", userId: null });
      expect((await subscribe.s.next((m) => m.id === "late")).value.userId).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test("the sweep catches sessions that expired or were removed without a hook", async () => {
    const expired = await signedInSocket();
    t.engine.realtime.sweepSessions(Date.now() + 31 * DAY);
    await expectDowngraded(expired.s);

    const removed = await signedInSocket();
    t.engine.store.write.query(`DELETE FROM _sessions WHERE user_id = ?`).run(removed.userId);
    t.engine.realtime.sweepSessions();
    await expectDowngraded(removed.s);
  });

  test("a client changing its password keeps its live queries signed in, without an error", async () => {
    const client = t.client();
    const user = await client.auth.signUp({ email: `user${++users}@example.com`, password: "password123" });
    const oldToken = client.getToken()!;
    // Signed out, `me` would push userId null and `required` an UNAUTHENTICATED error.
    const events: string[] = [];
    const seen = nextValue<string>();
    for (const name of ["me", "required"]) {
      const record = (event: string) => {
        events.push(`${name} ${event}`);
        seen.push(`${name} ${event}`);
      };
      client.subscribe(makeFunctionReference<"query">(`users:${name}`), {}, (v: any) => record(`data ${v.userId}`), (err) => record(`error ${err.message}`));
    }
    const nextBoth = async () => [await seen.next(), await seen.next()].sort();
    const both = [`me data ${user._id}`, `required data ${user._id}`];
    expect(await nextBoth()).toEqual(both);

    // A wrong current password changes nothing, and the live queries keep working.
    await expect(client.auth.changePassword({ currentPassword: "wrong-password", newPassword: "password456" })).rejects.toThrow(
      "Current password is wrong",
    );
    await client.mutation(makeFunctionReference<"mutation">("notes:add"), { text: "before" });
    expect(await nextBoth()).toEqual(both);

    await client.auth.changePassword({ currentPassword: "password123", newPassword: "password456" });
    expect(await nextBoth()).toEqual(both);
    await client.mutation(makeFunctionReference<"mutation">("notes:add"), { text: "after" });
    expect(await nextBoth()).toEqual(both);
    await Bun.sleep(100);
    expect(events.filter((event) => !event.endsWith(`data ${user._id}`))).toEqual([]);

    // Every old session still ended.
    expect(await me(oldToken)).toBeNull();
    expect((await me(client.getToken()!))._id).toBe(user._id);
  });
});
