import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { defineSchema, defineTable, z } from "incibase";
import { query } from "incibase/server";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { MigrationError } from "../src/engine/migrate.ts";
import { tempDir } from "./helpers.ts";

const dirs: string[] = [];
const engines: Engine[] = [];

function open(app: AppDefinition, dataDir: string) {
  const engine = new Engine(app, { dataDir, quiet: true, publicUrl: "http://localhost" });
  engines.push(engine);
  return engine;
}

function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const v1 = defineSchema({
  tasks: defineTable({ title: z.string(), done: z.boolean() }).index("by_done", ["done"]),
  notes: defineTable({ text: z.string() }),
});

async function seed(engine: Engine) {
  return engine.writeTx(async (s) => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await s.insert("tasks", { title: `t${i}`, done: i % 2 === 0 }));
    await s.insert("notes", { text: "keep me" });
    return ids;
  });
}

describe("migrations", () => {
  test("new fields with defaults are written into existing documents", async () => {
    const data = dir();
    const first = open({ schema: v1, modules: {} }, data);
    await seed(first);
    await first.stop();

    const v2 = defineSchema({
      tasks: defineTable({ title: z.string(), done: z.boolean(), priority: z.number().default(3) }).index("by_done", ["done"]),
      notes: defineTable({ text: z.string() }),
    });
    const second = open({ schema: v2, modules: {} }, data);
    expect(second.migration.rewrittenDocuments).toBe(5);
    const tasks = (await second.readTx((s) => s.query("tasks").collect())).result;
    expect(tasks.every((t) => t.priority === 3)).toBe(true);
  });

  test("incompatible schema changes are refused and change nothing", async () => {
    const data = dir();
    const first = open({ schema: v1, modules: {} }, data);
    await seed(first);
    await first.stop();

    const bad = defineSchema({
      tasks: defineTable({ title: z.string(), done: z.boolean(), owner: z.string() }).index("by_owner", ["owner"]),
      notes: defineTable({ text: z.string() }),
    });
    expect(() => open({ schema: bad, modules: {} }, data)).toThrow(MigrationError);

    const again = open({ schema: v1, modules: {} }, data);
    expect(again.migration.addedIndexes).toEqual([]);
    expect(again.migration.rewrittenDocuments).toBe(0);
  });

  test("indexes are synced and removed tables keep their data", async () => {
    const data = dir();
    const first = open({ schema: v1, modules: {} }, data);
    await seed(first);
    await first.stop();

    const v2 = defineSchema({
      tasks: defineTable({ title: z.string(), done: z.boolean() }).index("by_title", ["title"], { unique: true }),
    });
    const second = open({ schema: v2, modules: {} }, data);
    expect(second.migration.droppedIndexes).toEqual(["tasks.by_done"]);
    expect(second.migration.addedIndexes).toEqual(["tasks.by_title"]);
    expect(second.migration.deactivatedTables).toEqual(["notes"]);
    await second.stop();

    const third = open({ schema: v1, modules: {} }, data);
    const notes = (await third.readTx((s) => s.query("notes").collect())).result;
    expect(notes.map((n) => n.text)).toEqual(["keep me"]);
  });

  test("a unique index that existing data violates is refused", async () => {
    const data = dir();
    const first = open({ schema: v1, modules: {} }, data);
    await seed(first);
    await first.stop();
    const v2 = defineSchema({
      tasks: defineTable({ title: z.string(), done: z.boolean() }).index("by_done", ["done"], { unique: true }),
      notes: defineTable({ text: z.string() }),
    });
    expect(() => open({ schema: v2, modules: {} }, data)).toThrow(/by_done/);
  });
});

describe("queries", () => {
  test("index ranges, where, filter, order and unique", async () => {
    const engine = open({ schema: v1, modules: {} }, dir());
    await seed(engine);
    const { result } = await engine.readTx(async (s) => ({
      done: (await s.query("tasks").withIndex("by_done", (q) => q.eq("done", true)).collect()).map((t) => t.title),
      desc: (await s.query("tasks").order("desc").take(2)).map((t) => t.title),
      where: (await s.query("tasks").where({ title: "t3" }).collect()).map((t) => t.title),
      filtered: (await s.query("tasks").filter((t) => t.title > "t2").first())?.title,
      count: await s.query("tasks").withIndex("by_done", (q) => q.eq("done", false)).count(),
      afterFirst: (
        await s
          .query("tasks")
          .withIndex("by_creation_time", (q) => q.gt("_creationTime", 0))
          .take(1)
      ).length,
    }));
    expect(result).toEqual({ done: ["t0", "t2", "t4"], desc: ["t4", "t3"], where: ["t3"], filtered: "t3", count: 2, afterFirst: 1 });

    await expect(engine.readTx((s) => s.query("tasks").withIndex("by_done").unique())).rejects.toThrow(/more than one/);
    await expect(
      engine.readTx((s) => s.query("tasks").withIndex("by_done", (q: any) => q.eq("title", "x")).collect()),
    ).rejects.toThrow(/index field order/);
  });

  test("filters work across batch boundaries", async () => {
    const engine = open({ schema: v1, modules: {} }, dir());
    await engine.writeTx(async (s) => {
      for (let i = 0; i < 600; i++) await s.insert("tasks", { title: `t${i}`, done: i === 550 });
    });
    const { result } = await engine.readTx((s) => s.query("tasks").filter((t) => t.done).first());
    expect(result?.title).toBe("t550");
    const page = await engine.readTx((s) => s.query("tasks").filter((t) => t.title.endsWith("9")).paginate({ cursor: null, numItems: 40 }));
    expect(page.result.page).toHaveLength(40);
    expect(page.result.isDone).toBe(false);
  });

  test("queries cannot write and mutations roll back on error", async () => {
    const write = query({ handler: async (ctx: any) => ctx.db.insert("tasks", { title: "x", done: false }) });
    const engine = open({ schema: v1, modules: { t: { write } } }, dir());
    await expect(engine.call("t:write", {}, { userId: null, admin: false })).rejects.toThrow();

    await expect(
      engine.writeTx(async (s) => {
        await s.insert("tasks", { title: "rolled back", done: false });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { result } = await engine.readTx((s) => s.query("tasks").collect());
    expect(result).toHaveLength(0);
  });

  test("documents are validated on insert and patch", async () => {
    const engine = open({ schema: v1, modules: {} }, dir());
    await expect(engine.writeTx((s) => s.insert("tasks", { title: 1 } as any))).rejects.toThrow(/Invalid document/);
    const id = await engine.writeTx((s) => s.insert("tasks", { title: "a", done: false }));
    await expect(engine.writeTx((s) => s.patch(id, { done: "yes" } as any))).rejects.toThrow(/Invalid document/);
    await expect(engine.writeTx((s) => s.insert("tasks", { _id: "x", title: "a", done: false } as any))).rejects.toThrow(/System field/);
    await engine.writeTx((s) => s.patch(id, { done: true }));
    expect((await engine.readTx((s) => s.get(id))).result).toMatchObject({ title: "a", done: true });
  });
});
