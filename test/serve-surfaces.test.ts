// Step 3 of M1: unix listeners, the public/admin surface split, service keys
// and secrets that hosted mode takes only from the environment.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { action, defineSchema, defineTable, file, httpAction, httpRouter, id, internalQuery, mutation, query, z } from "incibase/server";
import type { ServiceIdentity, ServiceScope } from "incibase/server";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { ConfigError, exitCodeOf, ExitCode } from "../src/engine/exit-codes.ts";
import { startServer } from "../src/engine/http.ts";
import { checkListenFlags, clearStaleSocket, startListeners, type Listeners } from "../src/engine/listeners.ts";
import { newServiceKey, ServiceKeys } from "../src/engine/service-keys.ts";
import { adminRequestRefusal, checkHostedSecrets, corsOriginsFromEnv, isAdminPath } from "../src/engine/surface.ts";
import { readMeta } from "../src/engine/store.ts";
import { nextValue, tempDir } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const ADMIN_KEY = "ik_admin_surfaces_test_key_never_printed";
const STORAGE_SECRET = "surfaces-test-storage-secret-0123456789abcdef";

const dirs: string[] = [];
function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Sets environment variables for the length of `fn`. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

// ---------------------------------------------------------------------------
// The app and its keys

const router = httpRouter();
router.route({
  path: "/hook",
  method: "GET",
  handler: httpAction(async (ctx: any) => Response.json({ isAdmin: ctx.auth.isAdmin, service: ctx.auth.service })),
});

const whoami = async (ctx: any) => ({ userId: await ctx.auth.getUserId(), isAdmin: ctx.auth.isAdmin, service: ctx.auth.service });

const APP: AppDefinition = {
  schema: defineSchema({ notes: defineTable({ body: z.string(), attachment: file().optional() }) }),
  modules: {
    app: {
      whoami: query({ mcp: true, description: "Who is calling", handler: whoami }),
      secret: internalQuery({ handler: whoami }),
      count: internalQuery({ handler: async (ctx: any) => (await ctx.db.query("notes").collect()).length }),
      add: mutation({ args: { body: z.string() }, handler: (ctx: any, { body }: any) => ctx.db.insert("notes", { body }) }),
      attach: mutation({
        args: { file: id("_storage") },
        handler: (ctx: any, { file }: any) => ctx.db.insert("notes", { body: "with a file", attachment: file }),
      }),
      slow: action({
        handler: async () => {
          await Bun.sleep(10_500);
          return "done";
        },
      }),
    },
    http: { default: router },
  },
};

// Function code sees the key through a typed, read-only ctx.auth.service.
query({
  handler: async (ctx) => {
    const service: ServiceIdentity | null = ctx.auth.service;
    const keyId: string | undefined = service?.keyId;
    const scopes: readonly ServiceScope[] | undefined = service?.scopes;
    // @ts-expect-error read-only
    ctx.auth.service = null;
    return { keyId, scopes };
  },
});

const internalKey = newServiceKey("billing");
const impersonateKey = newServiceKey("support");
const uploadKey = newServiceKey("media");
const bareKey = newServiceKey("bare");
const revokedKey = newServiceKey("old");

function keysFile(path: string, entries: object[]) {
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

const KEYS = [
  { id: "billing", sha256: internalKey.sha256, scopes: ["internal"], label: "billing service" },
  { id: "support", sha256: impersonateKey.sha256, scopes: ["impersonate"] },
  { id: "media", sha256: uploadKey.sha256, scopes: ["upload"] },
  { id: "bare", sha256: bareKey.sha256, scopes: [] },
  { id: "old", sha256: revokedKey.sha256, scopes: ["internal"], revoked: true },
];

/** fetch over a unix socket; `host` becomes the Host header. */
function over(socket: string, path: string, init: RequestInit & { host?: string; token?: string } = {}) {
  const { host = "localhost", token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  // As a header, not in the URL, which would normalize it (e.g. drop an empty port).
  headers.set("host", host);
  return fetch(`http://localhost${path}`, { ...rest, headers, unix: socket } as RequestInit);
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const callBody = (path: string, args: unknown = {}) => json({ path, args });

/** A WebSocket over a unix socket and the messages it receives. */
async function socketClient(socket: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws+unix://${socket}:/api/ws`, { headers } as any);
  const messages = nextValue<any>();
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return { ws, send: (msg: unknown) => ws.send(JSON.stringify(msg)), next: messages.next };
}

interface Hosted {
  engine: Engine;
  listeners: Listeners;
  pub: string;
  admin: string;
  stop(): Promise<void>;
}

async function startHosted(): Promise<Hosted> {
  const root = dir();
  const engine = new Engine(APP, {
    dataDir: join(root, "data"),
    quiet: true,
    publicUrl: "http://shop.test",
    adminKey: ADMIN_KEY,
    serviceKeys: new ServiceKeys(keysFile(join(root, "keys.json"), KEYS)),
  });
  engine.start();
  const pub = join(root, "http.sock");
  const admin = join(root, "admin.sock");
  const listeners = await startListeners(engine, { port: 0, hostname: "127.0.0.1", socket: pub, adminSocket: admin });
  return {
    engine,
    listeners,
    pub,
    admin,
    async stop() {
      await listeners.stop(true);
      await engine.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// In-process: both listeners of one engine

describe("hosted listeners", () => {
  let h: Hosted;
  let userId: string;
  let userToken: string;
  let slow: Promise<Response>;

  beforeAll(async () => {
    h = await startHosted();
    const user = await h.engine.auth.signUp({ email: "ada@x.co", password: "password123" });
    userId = user.user._id;
    userToken = user.token;
    // Longer than Bun's default idle timeout (10 s), which a unix listener must not apply; checked last.
    slow = over(h.pub, "/api/action", callBody("app:slow"));
  });

  afterAll(async () => {
    await h.stop();
  });

  test("the public socket has no admin tools, schema or dashboard", async () => {
    for (const [path, init] of [
      ["/_", {}],
      ["/_/", {}],
      ["/api/schema", {}],
      ["/api/admin/admin_overview", json({})],
    ] as const) {
      const res = await over(h.pub, path, init);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    }
    // The same paths on the admin socket.
    const page = await over(h.admin, "/_/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect((await over(h.admin, "/api/schema", { token: ADMIN_KEY })).status).toBe(200);
    const overview = await over(h.admin, "/api/admin/admin_overview", { ...json({}), token: ADMIN_KEY });
    expect(overview.status).toBe(200);
    expect((await overview.json()).value.publicUrl).toBe("http://shop.test");
  });

  test("the public socket answers the admin key with 401 on every route", async () => {
    const attempts: [string, RequestInit][] = [
      ["/api/health", {}],
      ["/api/query", callBody("app:whoami")],
      ["/api/query", callBody("app:secret")],
      ["/api/query", { ...callBody("app:whoami"), headers: { "content-type": "application/json", "x-incibase-as-user": userId } }],
      ["/api/storage/upload?visibility=public", { method: "POST", body: "bytes" }],
      ["/api/admin/admin_overview", json({})],
      ["/api/schema", {}],
      ["/api/ws", {}],
      ["/mcp", json({ jsonrpc: "2.0", id: 1, method: "tools/list" })],
      ["/hook", {}],
    ];
    for (const [path, init] of attempts) {
      const res = await over(h.pub, path, { ...init, token: ADMIN_KEY });
      expect([path, res.status]).toEqual([path, 401]);
      expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
    }
    // Sent in-band on a WebSocket it is refused too, and the socket stays anonymous.
    const ws = await socketClient(h.pub);
    ws.send({ type: "auth", token: ADMIN_KEY });
    expect(await ws.next()).toMatchObject({ type: "error", error: { code: "UNAUTHENTICATED" } });
    ws.send({ type: "sub", id: "s", path: "app:whoami" });
    expect(await ws.next()).toMatchObject({ id: "s", type: "data", value: { userId: null, isAdmin: false, service: null } });
    ws.ws.close();
  });

  test("public MCP lists the app's mcp tools and no admin tools", async () => {
    const list = async (token?: string) => {
      const res = await over(h.pub, "/mcp", { ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }), token });
      expect(res.status).toBe(200);
      return ((await res.json()).result.tools as { name: string }[]).map((t) => t.name);
    };
    expect(await list()).toEqual(["app_whoami"]);
    expect(await list(userToken)).toEqual(["app_whoami"]);
    expect(await list(internalKey.key)).toEqual(["app_whoami"]);
    const call = await over(h.pub, "/mcp", {
      ...json({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "app_whoami", arguments: {} } }),
      token: internalKey.key,
    });
    expect((await call.json()).result.structuredContent).toEqual({ userId: null, isAdmin: false, service: { keyId: "billing", scopes: ["internal"] } });
    // The admin socket keeps the admin tools for the admin key.
    const admin = await over(h.admin, "/mcp", { ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }), token: ADMIN_KEY });
    expect(((await admin.json()).result.tools as { name: string }[]).map((t) => t.name)).toContain("admin_sql");
  });

  test("a service key calls internal functions as itself, never as the admin", async () => {
    const res = await over(h.pub, "/api/query", { ...callBody("app:secret"), token: internalKey.key });
    expect(res.status).toBe(200);
    expect((await res.json()).value).toEqual({ userId: null, isAdmin: false, service: { keyId: "billing", scopes: ["internal"] } });
    // httpActions see it as well.
    expect(await (await over(h.pub, "/hook", { token: internalKey.key })).json()).toEqual({
      isAdmin: false,
      service: { keyId: "billing", scopes: ["internal"] },
    });
    // Without the internal scope, internal functions do not exist for it; public ones run with ctx.auth.service.
    const bare = await over(h.pub, "/api/query", { ...callBody("app:secret"), token: bareKey.key });
    expect(bare.status).toBe(404);
    expect((await bare.json()).error.code).toBe("FUNCTION_NOT_FOUND");
    const visible = await over(h.pub, "/api/query", { ...callBody("app:whoami"), token: bareKey.key });
    expect((await visible.json()).value.service).toEqual({ keyId: "bare", scopes: [] });
    // Nor does it reach the admin tools, which the public socket does not have.
    expect((await over(h.pub, "/api/admin/admin_overview", { ...json({}), token: internalKey.key })).status).toBe(404);
  });

  test("x-incibase-as-user needs the impersonate scope", async () => {
    const asUser = (token: string) =>
      over(h.pub, "/api/query", { ...callBody("app:whoami"), token, headers: { "content-type": "application/json", "x-incibase-as-user": userId } });
    const refused = await asUser(internalKey.key);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toContain("impersonate");
    const allowed = await asUser(impersonateKey.key);
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).value).toEqual({ userId, isAdmin: false, service: { keyId: "support", scopes: ["impersonate"] } });
    // impersonate alone does not open internal functions.
    const internal = await over(h.pub, "/api/query", { ...callBody("app:secret"), token: impersonateKey.key });
    expect(internal.status).toBe(404);
  });

  test("unknown and revoked service keys are anonymous on the API and 401 on MCP", async () => {
    const forged = `ik_svc_billing_${"x".repeat(43)}`;
    for (const token of [revokedKey.key, forged, newServiceKey("nobody").key, "ik_svc_", "ik_svc_billing_"]) {
      const whoamiRes = await over(h.pub, "/api/query", { ...callBody("app:whoami"), token });
      expect((await whoamiRes.json()).value).toEqual({ userId: null, isAdmin: false, service: null });
      expect((await over(h.pub, "/api/query", { ...callBody("app:secret"), token })).status).toBe(404);
      const mcp = await over(h.pub, "/mcp", { ...json({ jsonrpc: "2.0", id: 1, method: "tools/list" }), token });
      expect(mcp.status).toBe(401);
    }
  });

  test("the upload scope uploads without a signed URL and attaches what it uploaded", async () => {
    const upload = (token: string) =>
      over(h.pub, "/api/storage/upload?visibility=public", { method: "POST", body: "hello", headers: { "content-type": "text/plain" }, token });
    const refused = await upload(internalKey.key);
    expect(refused.status).toBe(403);
    const res = await upload(uploadKey.key);
    expect(res.status).toBe(200);
    const { storageId } = await res.json();
    // Like an admin upload: no owner, so only the admin, system code and upload-scoped keys may attach it.
    const other = await over(h.pub, "/api/mutation", { ...callBody("app:attach", { file: storageId }), token: bareKey.key });
    expect(other.status).toBe(403);
    const attached = await over(h.pub, "/api/mutation", { ...callBody("app:attach", { file: storageId }), token: uploadKey.key });
    expect(attached.status).toBe(200);
  });

  test("a service key subscribes to internal queries; other sockets do not share its run", async () => {
    const service = await socketClient(h.pub);
    service.send({ type: "auth", token: internalKey.key });
    expect(await service.next()).toEqual({ type: "auth", userId: null });
    service.send({ type: "sub", id: "n", path: "app:count" });
    const first = await service.next();
    expect(first).toMatchObject({ id: "n", type: "data" });
    // Bearer on the upgrade works the same way.
    const viaHeader = await socketClient(h.pub, { authorization: `Bearer ${internalKey.key}` });
    viaHeader.send({ type: "sub", id: "n", path: "app:count" });
    expect(await viaHeader.next()).toEqual(first);
    const anonymous = await socketClient(h.pub);
    anonymous.send({ type: "sub", id: "n", path: "app:count" });
    expect(await anonymous.next()).toMatchObject({ id: "n", type: "error", error: { code: "FUNCTION_NOT_FOUND" } });
    await over(h.pub, "/api/mutation", { ...callBody("app:add", { body: "x" }), token: userToken });
    expect(await service.next()).toEqual({ id: "n", type: "data", value: first.value + 1 });
    for (const c of [service, viaHeader, anonymous]) c.ws.close();
  });

  test("the admin socket still requires the admin key, and takes no service keys", async () => {
    const overview = (token?: string) => over(h.admin, "/api/admin/admin_overview", { ...json({}), token });
    expect((await overview()).status).toBe(403);
    expect((await overview(userToken)).status).toBe(403);
    const service = await overview(internalKey.key);
    expect(service.status).toBe(401);
    expect((await service.json()).error.message).toContain("Service keys are not accepted");
    expect((await overview(ADMIN_KEY)).status).toBe(200);
    // The admin key keeps its other powers there: internal functions and acting as a user.
    const asUser = await over(h.admin, "/api/query", {
      ...callBody("app:secret"),
      token: ADMIN_KEY,
      headers: { "content-type": "application/json", "x-incibase-as-user": userId },
    });
    expect((await asUser.json()).value).toEqual({ userId, isAdmin: true, service: null });
    const ws = await socketClient(h.admin);
    ws.send({ type: "auth", token: internalKey.key });
    expect(await ws.next()).toMatchObject({ type: "error", error: { code: "UNAUTHENTICATED" } });
    ws.ws.close();
  });

  test("the admin socket answers only localhost names, from its own origin", async () => {
    const ok = ["localhost", "localhost:7101", "127.0.0.1", "127.0.0.1:7101", "[::1]", "[::1]:7101", "LocalHost:7101"];
    for (const host of ok) {
      expect([host, (await over(h.admin, "/api/admin/admin_overview", { ...json({}), host, token: ADMIN_KEY })).status]).toEqual([host, 200]);
    }
    const bad = ["shop.test", "localhost.attacker.example", "127.0.0.1.nip.io", "attacker.example:7101", "localhost:", "[::2]:7101", "0.0.0.0:7101"];
    // Every route: admin tools, schema, dashboard, WebSocket, MCP, health, app routes and preflights.
    const routes: [string, RequestInit][] = [
      ["/api/admin/admin_overview", json({})],
      ["/api/schema", {}],
      ["/_/", {}],
      ["/api/ws", {}],
      ["/mcp", json({ jsonrpc: "2.0", id: 1, method: "tools/list" })],
      ["/api/health", {}],
      ["/api/query", callBody("app:whoami")],
      ["/hook", {}],
      ["/api/query", { method: "OPTIONS" }],
    ];
    for (const host of bad) {
      for (const [path, init] of routes) {
        const res = await over(h.admin, path, { ...init, host, token: ADMIN_KEY });
        expect([host, path, res.status]).toEqual([host, path, 403]);
      }
    }
    // A request through the tunnel from a page of another origin.
    for (const origin of ["http://attacker.example", "null", "https://localhost:7101", "http://localhost:7102", "http://127.0.0.1:7101"]) {
      for (const [path, init] of routes) {
        const res = await over(h.admin, path, { ...init, host: "localhost:7101", token: ADMIN_KEY, headers: { ...init.headers, origin } });
        expect([origin, path, res.status]).toEqual([origin, path, 403]);
      }
    }
    const sameOrigin = await over(h.admin, "/api/admin/admin_overview", {
      ...json({}),
      host: "localhost:7101",
      token: ADMIN_KEY,
      headers: { "content-type": "application/json", origin: "http://localhost:7101" },
    });
    expect(sameOrigin.status).toBe(200);
    // The WebSocket route is reachable with a good Host (426: not an upgrade) and refused with a bad one (above).
    expect((await over(h.admin, "/api/ws", { host: "127.0.0.1:7101" })).status).toBe(426);
  });

  test("the admin socket sends no CORS headers", async () => {
    const origin = "http://localhost:7101";
    const preflight = await over(h.admin, "/api/admin/admin_overview", {
      method: "OPTIONS",
      host: "localhost:7101",
      headers: { origin, "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(204);
    const responses = [
      preflight,
      await over(h.admin, "/api/admin/admin_overview", { ...json({}), host: "localhost:7101", token: ADMIN_KEY, headers: { origin } }),
      await over(h.admin, "/api/query", { ...callBody("nope:nope"), host: "localhost:7101", headers: { origin } }),
      await over(h.admin, "/api/schema", { host: "attacker.example", headers: { origin: "http://attacker.example" } }),
    ];
    for (const res of responses) {
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
    // The public socket keeps them.
    const pub = await over(h.pub, "/api/query", { method: "OPTIONS", headers: { origin: "https://shop.test" } });
    expect(pub.headers.get("access-control-allow-origin")).toBe("*");
    const refused = await over(h.pub, "/api/health", { token: ADMIN_KEY, headers: { origin: "https://shop.test" } });
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("both sockets get mode 0770", () => {
    for (const path of [h.pub, h.admin]) {
      expect(lstatSync(path).isSocket()).toBe(true);
      expect((statSync(path).mode & 0o777).toString(8)).toBe("770");
    }
    expect(h.listeners.listen).toBe(h.pub);
  });

  test("a unix listener does not time requests out (the proxy does)", async () => {
    const res = await slow;
    expect(res.status).toBe(200);
    expect((await res.json()).value).toBe("done");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Socket files

describe("socket paths", () => {
  const holders: NetServer[] = [];
  afterEach(() => {
    for (const h of holders.splice(0)) h.close();
  });

  /** A socket left behind by a process that was killed while listening. */
  async function staleSocket(path: string) {
    const proc = Bun.spawn(
      [process.execPath, "-e", `Bun.serve({ unix: ${JSON.stringify(path)}, fetch: () => new Response("old") }); console.log("up"); setInterval(() => {}, 1000);`],
      { stdout: "pipe" },
    );
    await proc.stdout.getReader().read();
    proc.kill("SIGKILL");
    await proc.exited;
    expect(lstatSync(path).isSocket()).toBe(true);
  }

  async function errorOf(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      return err;
    }
    throw new Error("expected an error");
  }

  test("a socket left by a killed server is replaced", async () => {
    const root = dir();
    const path = join(root, "http.sock");
    await staleSocket(path);
    await clearStaleSocket(path);
    expect(existsSync(path)).toBe(false);
    // And through startListeners, which binds it afterwards.
    await staleSocket(path);
    const engine = new Engine({ modules: {} }, { dataDir: join(root, "data"), quiet: true, publicUrl: "http://x.test" });
    const listeners = await startListeners(engine, { port: 0, hostname: "127.0.0.1", socket: path });
    try {
      expect((await (await over(path, "/api/health")).json()).ok).toBe(true);
    } finally {
      await listeners.stop(true);
      await engine.stop();
    }
  });

  test("anything but a socket is left alone and refused (exit 64)", async () => {
    const root = dir();
    const file = join(root, "file.sock");
    writeFileSync(file, "keep me");
    const folder = join(root, "dir.sock");
    mkdirSync(folder);
    const target = join(root, "target.sock");
    await staleSocket(target);
    const link = join(root, "link.sock");
    symlinkSync(target, link);
    for (const path of [file, folder, link]) {
      const err = await errorOf(() => clearStaleSocket(path));
      expect(err).toBeInstanceOf(ConfigError);
      expect(exitCodeOf(err)).toBe(ExitCode.CONFIG);
      expect((err as Error).message).toContain("only a stale socket is removed");
    }
    expect(readFileSync(file, "utf8")).toBe("keep me");
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(lstatSync(target).isSocket()).toBe(true);
  });

  test("a socket another process listens on is not taken (exit 75)", async () => {
    const path = join(dir(), "live.sock");
    const live = createServer().listen(path);
    holders.push(live);
    await new Promise((resolve) => live.once("listening", resolve));
    const err = await errorOf(() => clearStaleSocket(path));
    expect(exitCodeOf(err)).toBe(ExitCode.TEMPORARY);
    expect(lstatSync(path).isSocket()).toBe(true);
  });

  test("listen failures on a socket path say why, with their exit code", async () => {
    const root = dir();
    const engine = new Engine({ modules: {} }, { dataDir: join(root, "data"), quiet: true, publicUrl: "http://x.test" });
    try {
      const missing = await errorOf(() => startListeners(engine, { port: 0, hostname: "127.0.0.1", socket: join(root, "nope", "http.sock") }));
      expect(exitCodeOf(missing)).toBe(ExitCode.CONFIG);
      expect((missing as Error).message).toContain("does not exist");
      const long = await errorOf(() => startListeners(engine, { port: 0, hostname: "127.0.0.1", socket: join(root, `${"x".repeat(120)}.sock`) }));
      expect(exitCodeOf(long)).toBe(ExitCode.CONFIG);
      expect((long as Error).message).toContain("too long");
      // A failing admin socket closes the public listener it opened first.
      const pub = join(root, "http.sock");
      const split = await errorOf(() =>
        startListeners(engine, { port: 0, hostname: "127.0.0.1", socket: pub, adminSocket: join(root, "nope", "admin.sock") }),
      );
      expect(exitCodeOf(split)).toBe(ExitCode.CONFIG);
      expect(existsSync(pub)).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  test("an admin socket without --socket splits a TCP listener", async () => {
    const root = dir();
    const engine = new Engine(APP, { dataDir: join(root, "data"), quiet: true, publicUrl: "http://x.test", adminKey: ADMIN_KEY });
    const admin = join(root, "admin.sock");
    const listeners = await startListeners(engine, { port: 0, hostname: "127.0.0.1", adminSocket: admin });
    try {
      const url = listeners.listen;
      expect(url).toStartWith("http://127.0.0.1:");
      const headers = { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" };
      expect((await fetch(`${url}/api/admin/admin_overview`, { method: "POST", body: "{}" })).status).toBe(404);
      expect((await fetch(`${url}/api/admin/admin_overview`, { method: "POST", headers, body: "{}" })).status).toBe(401);
      expect((await fetch(`${url}/api/health`, { headers })).status).toBe(401);
      // The public listener answers any Host; only the admin socket checks it.
      expect((await fetch(`${url}/api/health`, { headers: { host: "shop.example" } })).status).toBe(200);
      expect((await over(admin, "/api/admin/admin_overview", { ...json({}), token: ADMIN_KEY })).status).toBe(200);
    } finally {
      await listeners.stop(true);
      await engine.stop();
    }
  });

  test("flags that do not go together are refused", () => {
    const err = (flags: Parameters<typeof checkListenFlags>[0]) => {
      try {
        checkListenFlags(flags);
      } catch (e) {
        return (e as Error).message;
      }
      return null;
    };
    expect(err({ socket: "/run/x.sock", port: "3000", url: "https://x" })).toContain("--port");
    expect(err({ socket: "/run/x.sock", host: "0.0.0.0", url: "https://x" })).toContain("--host");
    expect(err({ socket: "/run/x.sock" })).toContain("--url");
    expect(err({ socket: "/run/x.sock", adminSocket: "/run/x.sock", url: "https://x" })).toContain("different");
    expect(err({ adminSocket: "", url: "https://x" })).toContain("needs a path");
    expect(err({ socket: "/run/x.sock", adminSocket: "/run/a.sock", url: "https://x" })).toBeNull();
    expect(err({ adminSocket: "/run/a.sock", port: "3000" })).toBeNull();
    expect(err({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Units

describe("surface rules", () => {
  test("admin paths are the ones the front proxy blocks", () => {
    for (const path of ["/_", "/_/", "/_/x", "/api/schema", "/api/admin", "/api/admin/:tool"]) expect(isAdminPath(path)).toBe(true);
    for (const path of ["/api/query", "/api/ws", "/mcp", "/api/health", "/_x", "/api/schemas", "/api/administer"]) expect(isAdminPath(path)).toBe(false);
  });

  test("the admin Host and Origin check", () => {
    const req = (headers: Record<string, string>) => new Request("http://localhost/", { headers });
    expect(adminRequestRefusal(req({ host: "localhost:7101" }))).toBeNull();
    expect(adminRequestRefusal(req({ host: "[::1]:7101", origin: "http://[::1]:7101" }))).toBeNull();
    expect(adminRequestRefusal(req({ host: "127.0.0.1", origin: "http://127.0.0.1" }))).toBeNull();
    expect(adminRequestRefusal(req({ host: "evil.example" }))).toContain("evil.example");
    expect(adminRequestRefusal(req({ host: "localhost:7101", origin: "http://localhost:7101/" }))).toContain("Origin");
  });

  test("INCIBASE_CORS_ORIGINS", () => {
    expect(corsOriginsFromEnv(undefined)).toBeUndefined();
    expect(corsOriginsFromEnv(" ")).toBeUndefined();
    expect(corsOriginsFromEnv("https://shop.com, http://localhost:5173")).toEqual(["https://shop.com", "http://localhost:5173"]);
    expect(corsOriginsFromEnv("https://shop.com,*")).toBe("*");
    for (const bad of ["https://shop.com/", "shop.com", "https://shop.com/path", "null"]) {
      expect(() => corsOriginsFromEnv(bad)).toThrow(ConfigError);
    }
  });

  test("hosted mode needs both secrets in the environment and none in the database", async () => {
    const root = dir();
    const db = join(root, "data.db");
    const env = { INCIBASE_ADMIN_KEY: ADMIN_KEY, INCIBASE_STORAGE_SECRET: STORAGE_SECRET };
    expect(() => checkHostedSecrets(db, {})).toThrow(/INCIBASE_ADMIN_KEY and INCIBASE_STORAGE_SECRET/);
    expect(() => checkHostedSecrets(db, { INCIBASE_ADMIN_KEY: ADMIN_KEY })).toThrow(/needs INCIBASE_STORAGE_SECRET/);
    expect(() => checkHostedSecrets(db, { ...env, INCIBASE_STORAGE_SECRET: "" })).toThrow(ConfigError);
    // No database yet: fine.
    checkHostedSecrets(db, env);
    const sqlite = new Database(db);
    sqlite.run("CREATE TABLE _incibase_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    checkHostedSecrets(db, env);
    sqlite.run("INSERT INTO _incibase_meta VALUES ('storage_secret', 'old')");
    expect(() => checkHostedSecrets(db, env)).toThrow(/storage_secret.*incibase host adopt/s);
    sqlite.close();
  });
});

describe("service keys file", () => {
  test("is checked when read: a bad file is a ConfigError (exit 64)", () => {
    const root = dir();
    const cases: [string, string][] = [
      ["missing", join(root, "nope.json")],
      ["not JSON", keysFileText(join(root, "a.json"), "{")],
      ["not a list", keysFileText(join(root, "b.json"), JSON.stringify({ id: "x" }))],
      ["bad id", keysFile(join(root, "c.json"), [{ id: "has_underscore", sha256: internalKey.sha256, scopes: [] }])],
      ["bad hash", keysFile(join(root, "d.json"), [{ id: "x", sha256: "abc", scopes: [] }])],
      ["bad scope", keysFile(join(root, "e.json"), [{ id: "x", sha256: internalKey.sha256, scopes: ["admin"] }])],
      ["bad revoked", keysFile(join(root, "f.json"), [{ id: "x", sha256: internalKey.sha256, revoked: "yes" }])],
      [
        "duplicate id",
        keysFile(join(root, "g.json"), [
          { id: "x", sha256: internalKey.sha256 },
          { id: "x", sha256: bareKey.sha256 },
        ]),
      ],
    ];
    for (const [what, path] of cases) {
      let err: unknown;
      try {
        new ServiceKeys(path);
      } catch (e) {
        err = e;
      }
      expect([what, exitCodeOf(err)]).toEqual([what, ExitCode.CONFIG]);
    }
  });

  test("matches whole keys only; scopes default to internal", () => {
    const root = dir();
    const upper = { ...internalKey, sha256: internalKey.sha256.toUpperCase() };
    const keys = new ServiceKeys(keysFile(join(root, "k.json"), [{ id: "billing", sha256: upper.sha256 }]));
    expect(keys.match(internalKey.key)).toEqual({ keyId: "billing", scopes: ["internal"] });
    expect(keys.match(internalKey.key.slice(0, -1))).toBeNull();
    expect(keys.match(`${internalKey.key}x`)).toBeNull();
    expect(keys.match(internalKey.key.replace("ik_svc_billing_", "ik_svc_bare_"))).toBeNull();
    expect(keys.match(ADMIN_KEY)).toBeNull();
    expect(newServiceKey("x").key).toMatch(/^ik_svc_x_[A-Za-z0-9_-]{43}$/);
    expect(() => newServiceKey("a_b")).toThrow(/Invalid service key id/);
  });

  test("a reload swaps the keys and reports narrowed ones; a bad file keeps the old keys", () => {
    const root = dir();
    const path = keysFile(join(root, "k.json"), KEYS);
    const keys = new ServiceKeys(path);
    keysFile(path, [
      { id: "billing", sha256: internalKey.sha256, scopes: ["internal", "upload"] },
      { id: "support", sha256: impersonateKey.sha256, scopes: [] },
      { id: "media", sha256: uploadKey.sha256, scopes: ["upload"], revoked: true },
      { id: "old", sha256: revokedKey.sha256, scopes: ["internal"], revoked: true },
    ]);
    const quiet = silence();
    try {
      expect([...keys.reload()!].sort()).toEqual(["bare", "media", "support"]);
      expect(keys.match(internalKey.key)?.scopes).toEqual(["internal", "upload"]);
      expect(keys.match(uploadKey.key)).toBeNull();
      keysFileText(path, "[{");
      expect(keys.reload()).toBeNull();
      expect(quiet.errors.join("\n")).toContain("Keeping the service keys read before");
    } finally {
      quiet.restore();
    }
    expect(keys.match(internalKey.key)?.scopes).toEqual(["internal", "upload"]);
  });
});

function keysFileText(path: string, text: string) {
  writeFileSync(path, text);
  return path;
}

/** Captures console output (the text logger) instead of printing it. */
function silence() {
  const { log, error } = console;
  const errors: string[] = [];
  console.log = () => {};
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  return {
    errors,
    restore() {
      console.log = log;
      console.error = error;
    },
  };
}

// ---------------------------------------------------------------------------
// Combined mode (no --admin-socket) keeps 0.2.0's surface and takes service keys

describe("combined mode", () => {
  test("serves everything on one listener and also takes service keys", async () => {
    const root = dir();
    const engine = new Engine(APP, {
      dataDir: join(root, "data"),
      quiet: true,
      publicUrl: "http://x.test",
      adminKey: ADMIN_KEY,
      serviceKeys: new ServiceKeys(keysFile(join(root, "k.json"), KEYS)),
    });
    const server = startServer(engine, { port: 0, hostname: "127.0.0.1" });
    try {
      const url = server.url.origin;
      const post = (path: string, body: unknown, token: string) =>
        fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await post("/api/admin/admin_overview", {}, ADMIN_KEY)).status).toBe(200);
      expect((await fetch(`${url}/_/`)).status).toBe(200);
      expect((await (await post("/api/query", { path: "app:secret" }, ADMIN_KEY)).json()).value.isAdmin).toBe(true);
      expect((await (await post("/api/query", { path: "app:secret" }, internalKey.key)).json()).value.service.keyId).toBe("billing");
      // Any Host works, as before.
      const res = await fetch(`${url}/api/health`, { headers: { host: "shop.example" } });
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
      await engine.stop();
    }
  });

  test("INCIBASE_CORS_ORIGINS replaces the * default", async () => {
    await withEnv({ INCIBASE_CORS_ORIGINS: "https://shop.com, https://admin.shop.com" }, async () => {
      const engine = new Engine({ modules: {} }, { dataDir: join(dir(), "data"), quiet: true, publicUrl: "http://x.test" });
      const server = startServer(engine, { port: 0, hostname: "127.0.0.1" });
      try {
        const preflight = (origin: string) => fetch(`${server.url.origin}/api/query`, { method: "OPTIONS", headers: { origin } });
        const allowed = await preflight("https://admin.shop.com");
        expect(allowed.headers.get("access-control-allow-origin")).toBe("https://admin.shop.com");
        expect(allowed.headers.get("vary")).toBe("origin");
        expect((await preflight("https://attacker.example")).headers.get("access-control-allow-origin")).toBeNull();
      } finally {
        server.stop(true);
        await engine.stop();
      }
      // An option passed in code still wins.
      const engine2 = new Engine({ modules: {} }, { dataDir: join(dir(), "data"), quiet: true, publicUrl: "http://x.test" });
      const open = startServer(engine2, { port: 0, hostname: "127.0.0.1", corsOrigins: "*" });
      try {
        const res = await fetch(`${open.url.origin}/api/health`, { headers: { origin: "https://attacker.example" } });
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      } finally {
        open.stop(true);
        await engine2.stop();
      }
    });
    await withEnv({ INCIBASE_CORS_ORIGINS: "https://shop.com/" }, async () => {
      const engine = new Engine({ modules: {} }, { dataDir: join(dir(), "data"), quiet: true, publicUrl: "http://x.test" });
      try {
        expect(() => startServer(engine, { port: 0, hostname: "127.0.0.1" })).toThrow(ConfigError);
      } finally {
        await engine.stop();
      }
    });
  });

  test("INCIBASE_STORAGE_SECRET signs URLs and never lands in the database", async () => {
    const data = join(dir(), "data");
    const open = () => new Engine(APP, { dataDir: data, quiet: true, publicUrl: "http://x.test" });
    const url = await withEnv({ INCIBASE_STORAGE_SECRET: STORAGE_SECRET }, async () => {
      const engine = open();
      try {
        const id = await engine.storage.store(new Blob(["x"]), { visibility: "private" });
        return engine.storage.urlFor({ _id: id, visibility: "private" });
      } finally {
        await engine.stop();
      }
    });
    expect(readMeta(join(data, "data.db"), "storage_secret")).toBeNull();
    const serve = async (engine: Engine) => {
      const u = new URL(url);
      return (await engine.storage.serve(u.pathname.split("/").pop()!, u)).status;
    };
    // The same secret verifies the URL after a restart.
    await withEnv({ INCIBASE_STORAGE_SECRET: STORAGE_SECRET }, async () => {
      const engine = open();
      try {
        expect(await serve(engine)).toBe(200);
      } finally {
        await engine.stop();
      }
    });
    // Without it a new secret is made and kept, as before; the old URL no longer verifies.
    await withEnv({ INCIBASE_STORAGE_SECRET: undefined }, async () => {
      const engine = open();
      try {
        expect(await serve(engine)).toBe(403);
      } finally {
        await engine.stop();
      }
    });
    expect(readMeta(join(data, "data.db"), "storage_secret")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The CLI: hosted mode end to end

const CLI_APP = `import { internalQuery, query } from "incibase/server";
export const whoami = query({ handler: async (ctx) => ({ userId: await ctx.auth.getUserId(), service: ctx.auth.service }) });
export const secret = internalQuery({ handler: async (ctx) => ctx.auth.service?.keyId ?? null });
`;

/** The environment for child processes, without the caller's incibase settings. */
function childEnv(extra: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("INCIBASE_") && k !== "NO_COLOR" && k !== "FORCE_COLOR"));
  return { ...env, ...extra };
}

const procs: ReturnType<typeof Bun.spawn>[] = [];

function project(files: Record<string, string> = { "app.ts": CLI_APP }) {
  const root = dir();
  const source = join(root, "app");
  mkdirSync(source);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
  return { root, source, data: join(root, "data"), pub: join(root, "http.sock"), admin: join(root, "admin.sock"), keys: join(root, "keys.json") };
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
  const events = () =>
    out.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, any>);
  const until = async (test: () => unknown, what: string) => {
    for (const end = Date.now() + 15_000; !(await test()); await Bun.sleep(25)) {
      if (proc.exitCode !== null) throw new Error(`exited ${proc.exitCode} waiting for ${what}:\n${out.stdout}\n${out.stderr}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}:\n${out.stdout}\n${out.stderr}`);
    }
  };
  return {
    proc,
    out,
    events,
    until,
    ready: () => until(() => events().some((e) => e.ev === "ready"), "the ready line"),
    async exit() {
      const code = await proc.exited;
      await done;
      return { ...out, code };
    },
  };
}

afterEach(async () => {
  for (const p of procs.splice(0)) {
    p.kill("SIGKILL");
    await p.exited;
  }
});

const HOSTED_ENV = { INCIBASE_ADMIN_KEY: ADMIN_KEY, INCIBASE_STORAGE_SECRET: STORAGE_SECRET };

function hostedArgs(p: ReturnType<typeof project>, ...extra: string[]) {
  return ["serve", "--dir", p.source, "--data", p.data, "--socket", p.pub, "--admin-socket", p.admin, "--url", "https://shop.test", "--log-format", "json", ...extra];
}

const queryOver = (socket: string, path: string, token?: string) =>
  over(socket, "/api/query", { ...callBody(path), token }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

describe("serve in hosted mode", () => {
  test("exits 64 without the secrets in the environment, before touching the data dir", async () => {
    const p = project();
    for (const env of [{}, { INCIBASE_ADMIN_KEY: ADMIN_KEY }, { INCIBASE_STORAGE_SECRET: STORAGE_SECRET }] as Record<string, string>[]) {
      const run = await spawn(hostedArgs(p), env).exit();
      expect(run.code).toBe(ExitCode.CONFIG);
      const fatal = run.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.ev === "fatal");
      expect(fatal.msg).toContain("needs");
      expect(fatal.exitCode).toBe(64);
    }
    expect(existsSync(p.data)).toBe(false);
  });

  test("exits 64 when the database still holds the secrets, pointing at adoption", async () => {
    const p = project();
    // A 0.2.0-style start keeps both secrets in _incibase_meta.
    const plain = spawn(["serve", "--dir", p.source, "--data", p.data, "--port", "0", "--host", "127.0.0.1", "--log-format", "json"], {});
    await plain.ready();
    plain.proc.kill("SIGTERM");
    expect((await plain.exit()).code).toBe(0);
    expect(readMeta(join(p.data, "data.db"), "admin_key")).not.toBeNull();
    const before = readFileSync(join(p.data, "data.db"));
    const run = await spawn(hostedArgs(p), HOSTED_ENV).exit();
    expect(run.code).toBe(ExitCode.CONFIG);
    expect(run.stdout).toContain("admin_key and storage_secret");
    expect(run.stdout).toContain("incibase host adopt");
    expect(readFileSync(join(p.data, "data.db")).equals(before)).toBe(true);
    expect(existsSync(p.pub)).toBe(false);
  });

  test("a bad service keys file or socket path exits 64", async () => {
    const p = project();
    const missing = await spawn(hostedArgs(p), { ...HOSTED_ENV, INCIBASE_SERVICE_KEYS_FILE: p.keys }).exit();
    expect(missing.code).toBe(ExitCode.CONFIG);
    expect(missing.stdout).toContain("service keys file");
    keysFileText(p.keys, "[{}]");
    expect((await spawn(hostedArgs(p), { ...HOSTED_ENV, INCIBASE_SERVICE_KEYS_FILE: p.keys }).exit()).code).toBe(ExitCode.CONFIG);
    writeFileSync(p.pub, "not a socket");
    const file = await spawn(hostedArgs(p), HOSTED_ENV).exit();
    expect(file.code).toBe(ExitCode.CONFIG);
    expect(readFileSync(p.pub, "utf8")).toBe("not a socket");
    rmSync(p.pub);
    const noUrl = await spawn(["serve", "--dir", p.source, "--data", p.data, "--socket", p.pub], {}).exit();
    expect(noUrl.code).toBe(ExitCode.CONFIG);
    expect(noUrl.stderr).toContain("--url");
  });

  test("serves both sockets, keeps secrets out of the database, and binds again after SIGKILL", async () => {
    const p = project();
    keysFile(p.keys, [{ id: "billing", sha256: internalKey.sha256, scopes: ["internal"] }]);
    const env = { ...HOSTED_ENV, INCIBASE_SERVICE_KEYS_FILE: p.keys };
    const run = spawn(hostedArgs(p), env);
    await run.ready();
    const ready = run.events().find((e) => e.ev === "ready")!;
    expect(ready.listen).toBe(p.pub);
    expect(ready.admin).toBe(p.admin);
    expect(ready.url).toBe("https://shop.test");
    for (const path of [p.pub, p.admin]) expect((statSync(path).mode & 0o777).toString(8)).toBe("770");
    expect((await queryOver(p.pub, "app:secret", internalKey.key)).body.value).toBe("billing");
    expect((await queryOver(p.pub, "app:whoami", ADMIN_KEY)).status).toBe(401);
    expect((await queryOver(p.admin, "app:secret", ADMIN_KEY)).body.value).toBeNull();
    expect(readMeta(join(p.data, "data.db"), "admin_key")).toBeNull();
    expect(readMeta(join(p.data, "data.db"), "storage_secret")).toBeNull();
    expect(run.out.stdout).not.toContain(ADMIN_KEY);
    expect(run.out.stdout).not.toContain(STORAGE_SECRET);

    // Killed, it leaves both sockets behind; the next start replaces them.
    run.proc.kill("SIGKILL");
    await run.exit();
    expect(lstatSync(p.pub).isSocket()).toBe(true);
    expect(lstatSync(p.admin).isSocket()).toBe(true);
    const again = spawn(hostedArgs(p), env);
    await again.ready();
    expect((await queryOver(p.pub, "app:secret", internalKey.key)).body.value).toBe("billing");
    again.proc.kill("SIGTERM");
    expect((await again.exit()).code).toBe(0);
    // A clean stop removes them.
    expect(existsSync(p.pub)).toBe(false);
    expect(existsSync(p.admin)).toBe(false);
  });

  test("SIGHUP reloads the service keys without a restart", async () => {
    const p = project();
    const first = newServiceKey("first");
    const second = newServiceKey("second");
    keysFile(p.keys, [{ id: "first", sha256: first.sha256, scopes: ["internal"] }]);
    const run = spawn(hostedArgs(p), { ...HOSTED_ENV, INCIBASE_SERVICE_KEYS_FILE: p.keys });
    await run.ready();
    const pid = run.proc.pid;
    expect((await queryOver(p.pub, "app:secret", first.key)).body.value).toBe("first");
    expect((await queryOver(p.pub, "app:secret", second.key)).status).toBe(404);
    // A WebSocket signed in with the key that gets revoked.
    const ws = await socketClient(p.pub);
    ws.send({ type: "auth", token: first.key });
    expect(await ws.next()).toEqual({ type: "auth", userId: null });
    ws.send({ type: "sub", id: "s", path: "app:secret" });
    expect(await ws.next()).toEqual({ id: "s", type: "data", value: "first" });

    keysFile(p.keys, [
      { id: "first", sha256: first.sha256, scopes: ["internal"], revoked: true },
      { id: "second", sha256: second.sha256, scopes: ["internal"] },
    ]);
    run.proc.kill("SIGHUP");
    await run.until(async () => (await queryOver(p.pub, "app:secret", second.key)).status === 200, "the new key");
    expect((await queryOver(p.pub, "app:secret", first.key)).status).toBe(404);
    // The socket is signed out, and its subscription reruns as anonymous.
    expect(await ws.next()).toEqual({ type: "auth", userId: null });
    expect(await ws.next()).toMatchObject({ id: "s", type: "error", error: { code: "FUNCTION_NOT_FOUND" } });
    expect(run.events().find((e) => e.ev === "service_keys_reloaded")).toMatchObject({ keys: 1, narrowed: ["first"] });

    // A broken file is logged and the keys stay as they were.
    keysFileText(p.keys, "[{");
    run.proc.kill("SIGHUP");
    await run.until(() => run.events().some((e) => e.ev === "service_keys_reload_failed" && e.level === "error"), "the reload error");
    expect((await queryOver(p.pub, "app:secret", second.key)).body.value).toBe("second");
    expect(run.proc.exitCode).toBeNull();
    expect(run.proc.pid).toBe(pid);
    ws.ws.close();
  });

  test("a SIGHUP while starting does not end the process", async () => {
    const p = project();
    const marker = join(p.root, "importing");
    // Holds the start up while the app is imported, and says when it is there.
    writeFileSync(join(p.source, "slow.ts"), `await Bun.write(${JSON.stringify(marker)}, "1");\nawait Bun.sleep(1500);\nexport const x = 1;\n`);
    const run = spawn(hostedArgs(p), HOSTED_ENV);
    await run.until(() => existsSync(marker), "the slow import");
    run.proc.kill("SIGHUP");
    await run.ready();
    expect(run.proc.exitCode).toBeNull();
    expect((await over(p.pub, "/api/health")).status).toBe(200);
  });

  test("plain serve keeps the default SIGHUP (it ends the process)", async () => {
    const p = project();
    const run = spawn(["serve", "--dir", p.source, "--data", p.data, "--port", "0", "--host", "127.0.0.1", "--log-format", "json"], {});
    await run.ready();
    run.proc.kill("SIGHUP");
    await run.exit();
    expect(run.proc.signalCode).toBe("SIGHUP");
  });
});
