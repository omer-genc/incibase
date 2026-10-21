import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IncibaseError, type Id } from "incibase";
import { IncibaseRequestError, type IncibaseClient } from "incibase/client";
import { api } from "../example/incibase/_generated/api";
import { nextValue, startTestServer } from "./helpers.ts";

let t: Awaited<ReturnType<typeof startTestServer>>;
let alice: IncibaseClient;
let bob: IncibaseClient;
let general: Id<"channels">;

beforeAll(async () => {
  t = await startTestServer();
  alice = t.client();
  bob = t.client();
  await alice.auth.signUp({ email: "Alice@Example.com", password: "password123", name: "Alice" });
  await bob.auth.signUp({ email: "bob@example.com", password: "password123" });
  general = await alice.mutation(api.channels.create, { name: "general" });
});

afterAll(() => t.stop());

describe("auth", () => {
  test("me returns the signed-in user with a normalized email", async () => {
    const me = await alice.auth.me();
    expect(me?.email).toBe("alice@example.com");
    expect(me?.name).toBe("Alice");
  });

  test("duplicate email is rejected", async () => {
    const c = t.client();
    const err = await c.auth.signUp({ email: "alice@example.com", password: "password123" }).catch((e) => e);
    expect(err).toBeInstanceOf(IncibaseError);
    expect(err.data.code).toBe("EMAIL_TAKEN");
  });

  test("wrong password fails, right password signs in", async () => {
    const c = t.client();
    const err = await c.auth.signIn({ email: "bob@example.com", password: "nope-nope" }).catch((e) => e);
    expect(err.data.code).toBe("INVALID_CREDENTIALS");
    const user = await c.auth.signIn({ email: "bob@example.com", password: "password123" });
    expect(user.email).toBe("bob@example.com");
    await c.auth.signOut();
    expect(await c.auth.me()).toBeNull();
  });

  test("short passwords fail validation", async () => {
    const err = await t.client().auth.signUp({ email: "x@example.com", password: "short" }).catch((e) => e);
    expect(err).toBeInstanceOf(IncibaseRequestError);
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  test("mutations needing a user reject anonymous callers", async () => {
    const err = await t.client().mutation(api.messages.send, { channel: general, body: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(IncibaseError);
    expect(err.data.code).toBe("UNAUTHENTICATED");
  });
});

describe("functions", () => {
  test("insert and query with defaults applied", async () => {
    const id = await alice.mutation(api.messages.send, { channel: general, body: "  hello  " });
    const [latest] = await alice.query(api.messages.list, { channel: general, limit: 1 });
    expect(latest!._id).toBe(id);
    expect(latest!.body).toBe("hello");
    expect(latest!.pinned).toBe(false);
    expect(typeof latest!._creationTime).toBe("number");
  });

  test("argument validation errors are reported", async () => {
    const err = await alice.mutation(api.messages.send, { channel: general, body: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(IncibaseRequestError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  test("ids of the wrong table are rejected", async () => {
    const userId = (await alice.auth.me())!._id;
    const err = await alice.mutation(api.messages.send, { channel: userId as any, body: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(IncibaseRequestError);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toContain(`Expected an id of table "channels"`);
  });

  test("unique index violations surface as UNIQUE_VIOLATION", async () => {
    const err = await alice.mutation(api.channels.create, { name: "general" }).catch((e) => e);
    expect(err.data.code).toBe("UNIQUE_VIOLATION");
  });

  test("authorization inside functions", async () => {
    const id = await alice.mutation(api.messages.send, { channel: general, body: "mine" });
    const err = await bob.mutation(api.messages.pin, { id, pinned: true }).catch((e) => e);
    expect(err.data.code).toBe("FORBIDDEN");
    await alice.mutation(api.messages.pin, { id, pinned: true });
    const rows = await alice.query(api.messages.list, { channel: general });
    expect(rows.find((m) => m._id === id)?.pinned).toBe(true);
  });

  test("pagination walks all documents in order", async () => {
    const channel = await alice.mutation(api.channels.create, { name: "paging" });
    for (let i = 0; i < 7; i++) await alice.mutation(api.messages.send, { channel, body: `m${i}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    while (true) {
      const page: { page: { body: string }[]; continueCursor: string; isDone: boolean } = await alice.query(
        api.messages.page,
        { channel, paginationOpts: { cursor, numItems: 3 } },
      );
      seen.push(...page.page.map((m) => m.body));
      pages++;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(pages).toBe(3);
  });

  test("actions call queries; returns validator applies", async () => {
    const summary = await alice.action(api.stats.summary);
    expect(summary.channels).toBeGreaterThanOrEqual(1);
    expect(typeof summary.messages).toBe("number");
  });

  test("unknown and internal functions are not callable", async () => {
    const res = await fetch(`${t.url}/api/mutation`, {
      method: "POST",
      body: JSON.stringify({ path: "messages:bumpCount", args: { key: "x" } }),
    });
    expect(res.status).toBe(404);
  });

  test("admin key can call internal functions", async () => {
    const res = await fetch(`${t.url}/api/mutation`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.engine.adminKey}` },
      body: JSON.stringify({ path: "messages:bumpCount", args: { key: "admin" } }),
    });
    expect(res.status).toBe(200);
    expect(await alice.query(api.stats.get, { key: "admin" })).toBe(1);
  });
});

describe("realtime", () => {
  test("subscriptions receive the initial result and updates", async () => {
    const channel = await alice.mutation(api.channels.create, { name: "live" });
    const values = nextValue<{ body: string }[]>();
    const unsubscribe = bob.subscribe(api.messages.list, { channel, limit: 10 }, (rows) => values.push(rows));
    expect(await values.next()).toEqual([]);

    await alice.mutation(api.messages.send, { channel, body: "first" });
    expect((await values.next()).map((m) => m.body)).toEqual(["first"]);

    await alice.mutation(api.messages.send, { channel, body: "second" });
    expect((await values.next()).map((m) => m.body)).toEqual(["second", "first"]);
    unsubscribe();
  });

  test("unchanged results are not re-sent", async () => {
    const channel = await alice.mutation(api.channels.create, { name: "quiet" });
    const values = nextValue<unknown>();
    const unsubscribe = bob.subscribe(api.messages.list, { channel }, (rows) => values.push(rows));
    await values.next();
    // Writes to another channel touch the same table but not this result.
    await alice.mutation(api.messages.send, { channel: general, body: "elsewhere" });
    const extra = await values.next(300).catch(() => "none");
    expect(extra).toBe("none");
    unsubscribe();
  });
});

describe("scheduler", () => {
  test("runAfter(0) jobs run after the mutation commits", async () => {
    const before = await alice.query(api.stats.get, { key: "messages" });
    await alice.mutation(api.messages.send, { channel: general, body: "count me" });
    for (let i = 0; i < 50; i++) {
      if ((await alice.query(api.stats.get, { key: "messages" })) > before) break;
      await Bun.sleep(20);
    }
    expect(await alice.query(api.stats.get, { key: "messages" })).toBe(before + 1);
  });
});

describe("storage", () => {
  test("upload, attach and download a file", async () => {
    const uploadUrl = await alice.mutation(api.messages.generateUploadUrl);
    const storageId = await alice.storage.upload(uploadUrl, new Blob(["hello file"], { type: "text/plain" }));
    await alice.mutation(api.messages.send, { channel: general, body: "with file", attachment: storageId });
    const [latest] = await alice.query(api.messages.list, { channel: general, limit: 1 });
    expect(latest!.attachmentUrl).toBe(`${t.url}/api/storage/${storageId}`);
    const res = await fetch(latest!.attachmentUrl!);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("hello file");
  });

  test("upload URLs must be signed", async () => {
    const res = await fetch(`${t.url}/api/storage/upload?token=forged.sig`, { method: "POST", body: "x" });
    expect(res.status).toBe(403);
  });
});

describe("http routes", () => {
  test("custom routes run as actions", async () => {
    const res = await fetch(`${t.url}/hello?name=incibase`);
    expect(await res.json()).toMatchObject({ hello: "incibase" });
  });

  test("unknown routes 404", async () => {
    expect((await fetch(`${t.url}/nope`)).status).toBe(404);
  });
});

describe("mcp", () => {
  const rpc = async (body: unknown, token?: string) => {
    const res = await fetch(`${t.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: res.status === 202 ? null : ((await res.json()) as any) };
  };

  test("initialize negotiates the protocol version", async () => {
    const { body } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });

  test("anonymous callers see only app tools", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = body.result.tools.map((tool: any) => tool.name).sort();
    expect(names).toEqual(["channels_list", "get_stat", "messages_list"]);
    const list = body.result.tools.find((tool: any) => tool.name === "messages_list");
    expect(list.inputSchema.properties.channel["x-incibase-table"]).toBe("channels");
    expect(list.inputSchema.required).toEqual(["channel"]);
  });

  test("app tools run functions", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_stat", arguments: { key: "messages" } } });
    expect(body.result.isError).toBeUndefined();
    expect(Number(body.result.content[0].text)).toBeGreaterThan(0);
  });

  test("tool errors come back as isError results", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "messages_list", arguments: {} } });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("VALIDATION_ERROR");
  });

  test("admin tools inspect and edit data", async () => {
    const key = t.engine.adminKey;
    const { body: list } = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" }, key);
    expect(list.result.tools.map((tool: any) => tool.name)).toContain("admin_schema");

    const { body: schema } = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "admin_schema", arguments: {} } }, key);
    const description = schema.result.structuredContent;
    expect(description.tables.messages.indexes[0].name).toBe("by_channel");
    expect(description.tables.messages.documentCount).toBeGreaterThan(0);

    const { body: docs } = await rpc(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "admin_list_documents", arguments: { table: "channels", index: "by_name", range: [{ field: "name", op: "eq", value: "general" }] } },
      },
      key,
    );
    expect(docs.result.structuredContent.page).toHaveLength(1);

    const { body: sql } = await rpc(
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "admin_sql", arguments: { query: "DELETE FROM channels" } } },
      key,
    );
    expect(sql.result.isError).toBe(true);
  });

  test("invalid tokens are rejected", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }, "bogus")).status).toBe(401);
  });
});
