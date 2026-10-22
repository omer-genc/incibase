import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IncibaseError, type Id } from "incibase";
import { IncibaseClient, IncibaseRequestError } from "incibase/client";
import { api } from "../example/incibase/_generated/api";
import { memoryStorage, nextValue, startTestServer } from "./helpers.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

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

describe("watchQuery keep-alive", () => {
  const settle = () => Bun.sleep(150);

  test("unused queries stay subscribed for keepAliveMs, then stop", async () => {
    const channel = await alice.mutation(api.channels.create, { name: "keepalive" });
    const base = t.engine.realtime.subscriptionCount;
    const lingering = new IncibaseClient(t.url, { tokenStorage: memoryStorage(), keepAliveMs: 300 });
    const stop = lingering.watchQuery(api.messages.list, { channel }).subscribe(() => {});
    await settle();
    expect(t.engine.realtime.subscriptionCount).toBe(base + 1);
    stop();
    await settle();
    expect(t.engine.realtime.subscriptionCount).toBe(base + 1);
    await Bun.sleep(350);
    expect(t.engine.realtime.subscriptionCount).toBe(base);
    lingering.close();
  });

  test("keepAliveMs: 0 unsubscribes as soon as the last listener leaves", async () => {
    const channel = await alice.mutation(api.channels.create, { name: "no-keepalive" });
    const base = t.engine.realtime.subscriptionCount;
    const eager = new IncibaseClient(t.url, { tokenStorage: memoryStorage(), keepAliveMs: 0 });
    const stop = eager.watchQuery(api.messages.list, { channel }).subscribe(() => {});
    await settle();
    expect(t.engine.realtime.subscriptionCount).toBe(base + 1);
    stop();
    await settle();
    expect(t.engine.realtime.subscriptionCount).toBe(base);
    eager.close();
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
    // Declared as text, but the bytes are a PNG: the detected type wins.
    const storageId = await alice.storage.upload(uploadUrl, new Blob([PNG], { type: "text/plain" }));
    await alice.mutation(api.messages.send, { channel: general, body: "with file", attachment: storageId });
    const [latest] = await alice.query(api.messages.list, { channel: general, limit: 1 });
    expect(latest!.attachmentUrl).toBe(`${t.url}/api/storage/${storageId}`);
    const res = await fetch(latest!.attachmentUrl!);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test("upload URLs enforce their size and type limits", async () => {
    const uploadUrl = await alice.mutation(api.messages.generateUploadUrl);
    const html = await alice.storage.upload(uploadUrl, new Blob(["<script>alert(1)</script>"], { type: "text/html" })).catch((e) => e);
    expect(html.data.code).toBe("UNSUPPORTED_FILE_TYPE");
    const big = await alice.storage.upload(uploadUrl, new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: "image/png" })).catch((e) => e);
    expect(big.data.code).toBe("FILE_TOO_LARGE");
  });

  test("files are served so they can never run script on this origin", async () => {
    const id = await alice.action(api.files.storeText, { text: "<svg onload=alert(1)>", visibility: "public" });
    await t.engine.writeTx((s) => s.conn.query(`UPDATE _storage SET data = json_set(data, '$.contentType', 'text/html') WHERE _id = ?`).run(id));
    const res = await fetch(`${t.url}/api/storage/${id}`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  test("private files open only through signed, unexpired URLs", async () => {
    const uploadUrl = await alice.mutation(api.files.generateUploadUrl, { visibility: "private" });
    const id = await alice.storage.upload(uploadUrl, new Blob(["secret"], { type: "text/plain" }));
    expect((await alice.query(api.files.url, { id }))).toContain("&sig=");

    const plain = await fetch(`${t.url}/api/storage/${id}`);
    expect(plain.status).toBe(403);

    const signed = (await alice.query(api.files.url, { id }))!;
    const res = await fetch(signed);
    expect(await res.text()).toBe("secret");
    expect(res.headers.get("cache-control")).toStartWith("private");

    const tampered = signed.replace(/sig=[^&]+/, "sig=AAAA");
    expect((await fetch(tampered)).status).toBe(403);
    const otherFile = await alice.action(api.files.storeText, { text: "x", visibility: "private" });
    expect((await fetch(signed.replace(id, otherFile))).status).toBe(403);
  });

  test("signed URLs expire and are stable within their time bucket", async () => {
    const id = await alice.action(api.files.storeText, { text: "short", visibility: "private" });
    const a = (await alice.query(api.files.url, { id, expiresIn: 1 }))!;
    const b = (await alice.query(api.files.url, { id, expiresIn: 1 }))!;
    expect(a).toBe(b);
    expect((await fetch(a)).status).toBe(200);
    await Bun.sleep(2100);
    const expired = await fetch(a);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain("expired");
  });

  test("public files keep plain URLs; visibility can change later", async () => {
    const id = await alice.action(api.files.storeText, { text: "hello", visibility: "public" });
    const url = (await alice.query(api.files.url, { id }))!;
    expect(url).toBe(`${t.url}/api/storage/${id}`);
    expect((await fetch(url)).status).toBe(200);

    await alice.mutation(api.files.setVisibility, { id, visibility: "private" });
    expect((await fetch(url)).status).toBe(403);
    expect((await alice.query(api.files.url, { id }))).toContain("&sig=");

    await alice.mutation(api.files.setVisibility, { id, visibility: "public" });
    expect((await fetch(url)).status).toBe(200);
  });

  test("other users cannot read, change or attach someone else's private file", async () => {
    const uploadUrl = await alice.mutation(api.files.generateUploadUrl, { visibility: "private" });
    const payslip = await alice.storage.upload(uploadUrl, new Blob(["salary: 100"], { type: "application/pdf" }));
    expect((await alice.query(api.files.url, { id: payslip }))).toContain("&sig=");

    // Bob knows the id but gets no URL, cannot flip it public, and cannot attach it to a message.
    expect(await bob.query(api.files.url, { id: payslip })).toBeNull();
    const flip = await bob.mutation(api.files.setVisibility, { id: payslip, visibility: "public" }).catch((e) => e);
    expect(flip.data.code).toBe("FORBIDDEN");
    // The attachment field only accepts the sender's own uploads.
    const attach = await bob.mutation(api.messages.send, { channel: general, body: "look", attachment: payslip }).catch((e) => e);
    expect(attach.data.code).toBe("FORBIDDEN");
    expect((await fetch(`${t.url}/api/storage/${payslip}`)).status).toBe(403);
    expect(await t.client().query(api.files.url, { id: payslip })).toBeNull();

    // Code that checked access itself can share it explicitly.
    const res = await fetch(`${t.url}/api/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.engine.adminKey}` },
      body: JSON.stringify({ path: "files:urlForReviewer", args: { id: payslip } }),
    });
    const shared = ((await res.json()) as { value: string }).value;
    expect(await (await fetch(shared)).text()).toBe("salary: 100");
  });

  test("uploads are owned by the user who asked for the upload URL", async () => {
    const uploadUrl = await bob.mutation(api.files.generateUploadUrl, {});
    const id = await bob.storage.upload(uploadUrl, new Blob(["bob's"]));
    const meta = (await (
      await fetch(`${t.url}/api/admin/admin_get_document`, {
        method: "POST",
        headers: { authorization: `Bearer ${t.engine.adminKey}` },
        body: JSON.stringify({ id }),
      })
    ).json()) as any;
    expect(meta.value.document.ownerId).toBe((await bob.auth.me())!._id);
    expect(meta.value.document.visibility).toBe("public");
  });

  test("payslip files are readable through the payslip row, by nobody else", async () => {
    const carol = t.client();
    await carol.auth.signUp({ email: "carol@example.com", password: "password123" });
    const aliceId = (await alice.auth.me())!._id;
    const bobId = (await bob.auth.me())!._id;

    // Not HR yet.
    expect((await alice.mutation(api.payslips.generateUploadUrl).catch((e) => e)).data.code).toBe("FORBIDDEN");
    await t.engine.writeTx((s) => s.insert("hr", { userId: aliceId }));

    const pdf = new Blob(["%PDF-1.4 bob: 100"], { type: "application/pdf" });
    const file = await alice.storage.upload(await alice.mutation(api.payslips.generateUploadUrl), pdf);
    await alice.mutation(api.payslips.add, { employee: bobId, month: "2026-09", file });

    // Bob reads it through his payslip row; HR through the employee's rows; Carol cannot.
    const [mine] = await bob.query(api.payslips.mine);
    expect(await (await fetch(mine!.url!)).text()).toBe("%PDF-1.4 bob: 100");
    const [hrView] = await alice.query(api.payslips.forEmployee, { employee: bobId });
    expect(hrView!.url).toContain("&sig=");
    expect(await carol.query(api.payslips.mine)).toEqual([]);
    expect((await carol.query(api.payslips.forEmployee, { employee: bobId }).catch((e) => e)).data.code).toBe("FORBIDDEN");
    // Knowing the id is not enough: a query that did not load the row gets no URL.
    expect(await bob.query(api.files.url, { id: file })).toBeNull();
    expect(await carol.query(api.files.url, { id: file })).toBeNull();
    expect((await fetch(`${t.url}/api/storage/${file}`)).status).toBe(403);

    // One file, one document.
    const again = await alice.mutation(api.payslips.add, { employee: bobId, month: "2026-10", file }).catch((e) => e);
    expect(again.data.code).toBe("FILE_IN_USE");
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

describe("dashboard", () => {
  const callAdmin = (tool: string, args: unknown, key: string | null = t.engine.adminKey) =>
    fetch(`${t.url}/api/admin/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(args),
    });

  test("serves a self-contained HTML page at /_/", async () => {
    const res = await fetch(`${t.url}/_/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<div id="root">');
    expect(html).not.toContain('src="./app.tsx"');
    expect((await fetch(`${t.url}/_`, { redirect: "manual" })).headers.get("location")).toBe("/_/");
  }, 20_000);

  test("admin endpoints require the admin key", async () => {
    expect((await callAdmin("admin_overview", {}, null)).status).toBe(403);
    const token = (await alice.auth.signIn({ email: "alice@example.com", password: "password123" })) && alice.getToken();
    expect((await callAdmin("admin_overview", {}, token)).status).toBe(403);
    const res = await callAdmin("admin_overview", {});
    const { value } = (await res.json()) as any;
    expect(value.tables.messages.documentCount).toBeGreaterThan(0);
    expect(value.httpRoutes).toEqual([{ method: "GET", path: "/hello" }]);
    expect((await callAdmin("admin_nope", {})).status).toBe(404);
  });

  test("get returns the table; replace removes left-out fields", async () => {
    const id = await alice.mutation(api.messages.send, { channel: general, body: "to replace" });
    const got = (await (await callAdmin("admin_get_document", { id })).json()) as any;
    expect(got.value.table).toBe("messages");
    const { _id, _creationTime, ...fields } = got.value.document;
    const res = await callAdmin("admin_replace_document", { id, document: { ...fields, body: "replaced" } });
    expect(((await res.json()) as any).value.body).toBe("replaced");
    const bad = await callAdmin("admin_replace_document", { id, document: { body: "missing fields" } });
    expect(bad.status).toBe(400);
  });
});
