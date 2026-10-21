import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineSchema, defineTable, makeFunctionReference, z } from "incibase";
import { query } from "incibase/server";
import type { IncibaseClient } from "incibase/client";
import type { Engine } from "../src/engine/engine.ts";
import { startTestServer } from "./helpers.ts";

const schema = defineSchema({
  items: defineTable({ list: z.string(), n: z.number(), done: z.boolean() })
    .index("by_list", ["list"])
    .index("by_list_n", ["list", "n"]),
});

const modules = {
  items: {
    byList: query({
      args: { list: z.string() },
      handler: (ctx: any, { list }: any) => ctx.db.query("items").withIndex("by_list", (q: any) => q.eq("list", list)).collect(),
    }),
    atLeast: query({
      args: { list: z.string(), min: z.number() },
      handler: (ctx: any, { list, min }: any) =>
        ctx.db.query("items").withIndex("by_list_n", (q: any) => q.eq("list", list).gte("n", min)).collect(),
    }),
    one: query({ args: { id: z.string() }, handler: (ctx: any, { id }: any) => ctx.db.get(id) }),
    whereDone: query({ args: { done: z.boolean() }, handler: (ctx: any, { done }: any) => ctx.db.query("items").where({ done }).collect() }),
    count: query({ handler: async (ctx: any) => (await ctx.db.query("items").collect()).length }),
  },
};

type Item = { _id: string; list: string; n: number; done: boolean };
const ref = (name: string) => makeFunctionReference<"query">(`items:${name}`);

let t: Awaited<ReturnType<typeof startTestServer>>;
let engine: Engine;
let client: IncibaseClient;

beforeAll(async () => {
  t = await startTestServer({ schema, modules });
  engine = t.engine;
  client = t.client();
});
afterAll(() => t.stop());

const insert = (doc: Omit<Item, "_id">) => engine.writeTx((s) => s.insert("items", doc));
const patch = (id: string, fields: Partial<Item>) => engine.writeTx((s) => s.patch(id, fields));
const settle = () => Bun.sleep(80);
const runsOf = (name: string, args: Record<string, unknown>) =>
  engine.realtime.stats().find((s) => s.path === `items:${name}` && JSON.stringify(s.args) === JSON.stringify(args))?.runs ?? 0;

/** Subscribes and returns a getter for the latest value. */
async function live<T>(name: string, args: Record<string, unknown>) {
  let latest: T | undefined;
  const stop = client.subscribe(ref(name), args, (v) => (latest = v as T));
  await settle();
  return { get: () => latest, stop };
}

describe("precise invalidation", () => {
  test("writes outside an index range do not rerun the query", async () => {
    const a = await live<Item[]>("byList", { list: "a1" });
    const before = runsOf("byList", { list: "a1" });
    for (let i = 0; i < 5; i++) await insert({ list: "other", n: i, done: false });
    await settle();
    expect(runsOf("byList", { list: "a1" })).toBe(before);

    await insert({ list: "a1", n: 1, done: false });
    await settle();
    expect(runsOf("byList", { list: "a1" })).toBe(before + 1);
    expect(a.get()!.map((i) => i.n)).toEqual([1]);
    a.stop();
  });

  test("a document moving between ranges updates both sides", async () => {
    const id = await insert({ list: "from", n: 1, done: false });
    const from = await live<Item[]>("byList", { list: "from" });
    const to = await live<Item[]>("byList", { list: "to" });
    expect(from.get()).toHaveLength(1);
    expect(to.get()).toHaveLength(0);

    await patch(id, { list: "to" });
    await settle();
    expect(from.get()).toHaveLength(0);
    expect(to.get()!.map((i) => i._id)).toEqual([id]);
    from.stop();
    to.stop();
  });

  test("range bounds are respected", async () => {
    const q = await live<Item[]>("atLeast", { list: "r", min: 10 });
    const before = runsOf("atLeast", { list: "r", min: 10 });
    await insert({ list: "r", n: 5, done: false });
    await settle();
    expect(runsOf("atLeast", { list: "r", min: 10 })).toBe(before);

    const id = await insert({ list: "r", n: 10, done: false });
    await settle();
    expect(q.get()!.map((i) => i.n)).toEqual([10]);

    await patch(id, { n: 9 });
    await settle();
    expect(q.get()).toEqual([]);
    q.stop();
  });

  test("get(id) reruns only for that document", async () => {
    const id = await insert({ list: "g", n: 1, done: false });
    const other = await insert({ list: "g", n: 2, done: false });
    const q = await live<Item>("one", { id });
    const before = runsOf("one", { id });

    await patch(other, { n: 20 });
    await settle();
    expect(runsOf("one", { id })).toBe(before);

    await patch(id, { n: 11 });
    await settle();
    expect(q.get()!.n).toBe(11);
    await engine.writeTx((s) => s.delete(id));
    await settle();
    expect(q.get()).toBeNull();
    q.stop();
  });

  test("where() equality on booleans matches like SQL", async () => {
    const q = await live<Item[]>("whereDone", { done: true });
    const before = runsOf("whereDone", { done: true });
    const id = await insert({ list: "w", n: 1, done: false });
    await settle();
    expect(runsOf("whereDone", { done: true })).toBe(before);

    await patch(id, { done: true });
    await settle();
    expect(q.get()!.some((i) => i._id === id)).toBe(true);
    q.stop();
  });

  test("whole-table reads rerun on any write to the table", async () => {
    const q = await live<number>("count", {});
    const start = q.get()!;
    await insert({ list: "anything", n: 0, done: false });
    await settle();
    expect(q.get()).toBe(start + 1);
    q.stop();
  });
});

describe("batching", () => {
  test("a burst of writes reruns a subscription a few times, not once per write", async () => {
    const q = await live<Item[]>("byList", { list: "burst" });
    const before = runsOf("byList", { list: "burst" });
    await Promise.all(Array.from({ length: 30 }, (_, i) => insert({ list: "burst", n: i, done: false })));
    await Bun.sleep(150);
    const reruns = runsOf("byList", { list: "burst" }) - before;
    expect(q.get()).toHaveLength(30);
    expect(reruns).toBeGreaterThanOrEqual(1);
    expect(reruns).toBeLessThan(10);
    q.stop();
  });

  test("a write that lands while the first run is in flight is not missed", async () => {
    let latest: Item[] | undefined;
    const stop = client.subscribe(ref("byList"), { list: "race" }, (v) => (latest = v as Item[]));
    // Do not wait for the initial result: write immediately.
    await insert({ list: "race", n: 1, done: false });
    await Bun.sleep(150);
    expect(latest).toHaveLength(1);
    stop();
  });
});
