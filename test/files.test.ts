import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, file, id, makeFunctionReference, z } from "incibase";
import { mutation, query } from "incibase/server";
import type { IncibaseClient } from "incibase/client";
import { startTestServer } from "./helpers.ts";

const schema = defineSchema({
  docs: defineTable({
    title: z.string(),
    cover: file().optional(),
    secret: file({ private: true }).optional(),
    gallery: z.array(file({ contentTypes: ["image/*"], maxBytes: 1000 })).default([]),
    legacy: id("_storage").optional(),
  }),
});

const docArgs = {
  title: z.string(),
  cover: z.string().optional(),
  secret: z.string().optional(),
  gallery: z.array(z.string()).optional(),
  legacy: z.string().optional(),
};

const modules = {
  docs: {
    create: mutation({ args: docArgs, handler: (ctx: any, args: any) => ctx.db.insert("docs", args) }),
    update: mutation({
      args: { id: z.string(), fields: z.record(z.string(), z.any()) },
      handler: (ctx: any, { id, fields }: any) => ctx.db.patch(id, fields),
    }),
    remove: mutation({ args: { id: z.string() }, handler: (ctx: any, { id }: any) => ctx.db.delete(id) }),
    /** Loads the document, so its file() URLs are allowed for any caller. */
    withUrls: query({
      args: { id: z.string() },
      handler: async (ctx: any, { id }: any) => {
        const doc = await ctx.db.get(id);
        return { cover: doc.cover && (await ctx.storage.getUrl(doc.cover)), secret: doc.secret && (await ctx.storage.getUrl(doc.secret)) };
      },
    }),
    /** Does not load any document. */
    urlOf: query({ args: { file: z.string() }, handler: (ctx: any, { file }: any) => ctx.storage.getUrl(file) }),
    usage: query({ handler: async (ctx: any) => ctx.storage.usage((await ctx.auth.requireUser())._id) }),
  },
};

const fn = (name: string) => makeFunctionReference<any>(`docs:${name}`);
const HOUR = 3600_000;

let t: Awaited<ReturnType<typeof startTestServer>>;
let alice: IncibaseClient;
let bob: IncibaseClient;
let aliceId: string;

beforeAll(async () => {
  t = await startTestServer({ schema, modules });
  const a = await t.engine.auth.signUp({ email: "a@x.co", password: "password123" });
  const b = await t.engine.auth.signUp({ email: "b@x.co", password: "password123" });
  aliceId = a.user._id;
  alice = t.client(a.token);
  bob = t.client(b.token);
});
afterAll(() => t.stop());

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const upload = (ownerId: string | null, bytes: Uint8Array<ArrayBuffer> | string = PNG, type = "image/png", extra = {}) =>
  t.engine.storage.store(new Blob([bytes], { type }), { ownerId, ...extra });
const meta = async (fileId: string) => (await t.engine.readTx((s) => s.get(fileId))).result as Record<string, any> | null;

describe("attaching", () => {
  test("a user's own upload attaches and takes the field's visibility", async () => {
    const cover = await upload(aliceId);
    const secret = await upload(aliceId);
    const docId = await alice.mutation(fn("create"), { title: "mine", cover, secret });
    expect(await meta(cover)).toMatchObject({ attachedTo: { table: "docs", id: docId, field: "cover" }, visibility: "public" });
    expect((await meta(cover))!.pending).toBeUndefined();
    expect((await meta(secret))!.visibility).toBe("private");
  });

  test("someone else's file is refused, and one file belongs to one document", async () => {
    const alices = await upload(aliceId);
    const stolen = await bob.mutation(fn("create"), { title: "steal", cover: alices }).catch((e) => e);
    expect(stolen.data.code).toBe("FORBIDDEN");

    await alice.mutation(fn("create"), { title: "first", cover: alices });
    const twice = await alice.mutation(fn("create"), { title: "second", cover: alices }).catch((e) => e);
    expect(twice.data.code).toBe("FILE_IN_USE");
  });

  test("anonymous uploads can be attached by anyone; admin uploads only by admin code", async () => {
    const anon = await upload(null, PNG, "image/png", { anonymous: true });
    await bob.mutation(fn("create"), { title: "anon", cover: anon });
    const adminFile = await upload(null);
    expect((await bob.mutation(fn("create"), { title: "x", cover: adminFile }).catch((e) => e)).data.code).toBe("FORBIDDEN");
  });

  test("field limits apply when attaching", async () => {
    const pdf = await upload(aliceId, "%PDF-1.4", "application/pdf");
    expect((await alice.mutation(fn("create"), { title: "g", gallery: [pdf] }).catch((e) => e)).data.code).toBe("UNSUPPORTED_FILE_TYPE");
    const big = await upload(aliceId, new Uint8Array([...PNG, ...new Uint8Array(2000)]));
    expect((await alice.mutation(fn("create"), { title: "g", gallery: [big] }).catch((e) => e)).data.code).toBe("FILE_TOO_LARGE");
  });
});

describe("reading through the document", () => {
  test("a query that loaded the document gets its private file's URL; one that did not, does not", async () => {
    const secret = await upload(aliceId);
    const docId = await alice.mutation(fn("create"), { title: "shared", secret });
    // Bob is not the owner, but this query read the document.
    expect((await bob.query(fn("withUrls"), { id: docId })).secret).toContain("&sig=");
    // Knowing the file id alone gives nothing.
    expect(await bob.query(fn("urlOf"), { file: secret })).toBeNull();
    expect(await alice.query(fn("urlOf"), { file: secret })).toContain("&sig=");
  });
});

describe("cleanup", () => {
  test("replacing or removing a file detaches it; cleanup deletes it after the grace period", async () => {
    const first = await upload(aliceId);
    const second = await upload(aliceId);
    const docId = await alice.mutation(fn("create"), { title: "swap", cover: first, gallery: [] });
    await alice.mutation(fn("update"), { id: docId, fields: { cover: second } });

    const detached = (await meta(first))!;
    expect(detached.attachedTo).toBeUndefined();
    expect(detached.pending).toBe(true);
    expect((await meta(second))!.attachedTo.id).toBe(docId);

    expect(await t.engine.storage.cleanup(Date.now() + 30 * 60_000)).toBe(0); // still in the grace period
    expect(await t.engine.storage.cleanup(Date.now() + 2 * HOUR)).toBeGreaterThanOrEqual(1);
    expect(await meta(first)).toBeNull();
    expect((await fetch(`${t.url}/api/storage/${first}`)).status).toBe(404);
    expect(await meta(second)).not.toBeNull();
  });

  test("deleting a document releases its files, arrays included", async () => {
    const a = await upload(aliceId);
    const b = await upload(aliceId);
    const docId = await alice.mutation(fn("create"), { title: "gone", gallery: [a, b] });
    await alice.mutation(fn("update"), { id: docId, fields: { gallery: [b] } });
    expect((await meta(a))!.pending).toBe(true);
    expect((await meta(b))!.attachedTo.id).toBe(docId);

    await alice.mutation(fn("remove"), { id: docId });
    expect((await meta(b))!.pending).toBe(true);
    await t.engine.storage.cleanup(Date.now() + 2 * HOUR);
    expect(await meta(a)).toBeNull();
    expect(await meta(b)).toBeNull();
  });

  test("unattached uploads go after a day unless an id(\"_storage\") field references them", async () => {
    const orphan = await upload(aliceId);
    const referenced = await upload(aliceId);
    await alice.mutation(fn("create"), { title: "ref", legacy: referenced });
    const legacy = await upload(aliceId);
    // Files stored before cleanup existed have no pending flag and are never touched.
    await t.engine.writeTx((s) => s.conn.query(`UPDATE _storage SET data = json_remove(data, '$.pending') WHERE _id = ?`).run(legacy));

    expect(await t.engine.storage.cleanup(Date.now() + 12 * HOUR)).toBe(0);
    await t.engine.storage.cleanup(Date.now() + 25 * HOUR);
    expect(await meta(orphan)).toBeNull();
    expect(await meta(referenced)).not.toBeNull();
    expect(await meta(legacy)).not.toBeNull();
  });
});

test("usage reports a user's files and bytes", async () => {
  const before = (await alice.query(fn("usage"))) as { files: number; bytes: number };
  await upload(aliceId, new Uint8Array(500), "application/octet-stream");
  const after = (await alice.query(fn("usage"))) as { files: number; bytes: number };
  expect(after.files).toBe(before.files + 1);
  expect(after.bytes).toBe(before.bytes + 500);
});
