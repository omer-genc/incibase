import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { defineSchema, defineTable, z } from "incibase";
import { query } from "incibase/server";
import { adminTools } from "../src/engine/admin.ts";
import { ANONYMOUS, Engine } from "../src/engine/engine.ts";
import { fieldExpr } from "../src/engine/store.ts";
import { tempDir } from "./helpers.ts";

const schema = defineSchema({
  notes: defineTable({
    owner: z.string(),
    text: z.string(),
    address: z.object({ city: z.string() }).optional(),
  }),
});

const filter = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const notes = {
  // The pattern from the finding: the owner is forced, the caller adds filters.
  mine: query({
    args: { filter },
    handler: (ctx: any, args: any) => ctx.db.query("notes").where({ owner: "alice", ...args.filter }).collect(),
  }),
};

const dirs: string[] = [];
let engine: Engine;
let admin: ReturnType<typeof adminTools>;

beforeAll(async () => {
  dirs.push(tempDir());
  engine = new Engine({ schema, modules: { notes } }, { dataDir: dirs[0]!, quiet: true, publicUrl: "http://localhost" });
  admin = adminTools(engine);
  await engine.writeTx(async (s) => {
    await s.insert("notes", { owner: "alice", text: "a1", address: { city: "Izmir" } });
    await s.insert("notes", { owner: "alice", text: "a2", address: { city: "Ankara" } });
    await s.insert("notes", { owner: "bob", text: "b1", address: { city: "Izmir" } });
  });
});

afterAll(async () => {
  await engine.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err as Error & { data?: { code: string; message: string } };
  }
  throw new Error("expected a rejection");
};

describe("field names in where()", () => {
  const payloads = {
    quote: "owner'",
    orTrue: "owner') = 'bob' OR 1=1 OR json_extract(data, '$.owner",
    metaOracle:
      "owner') = 'bob' OR (SELECT substr(value, 1, 9) FROM _incibase_meta WHERE key = 'admin_key') = 'ik_admin_' OR json_extract(data, '$.owner",
  };

  for (const [name, key] of Object.entries(payloads)) {
    test(`a public query rejects the ${name} key`, async () => {
      const err = await errorOf(engine.call("notes:mine", { filter: { [key]: "x" } }, ANONYMOUS));
      expect(err.data?.code).toBe("INVALID_FIELD");
    });

    test(`fieldExpr refuses the ${name} key`, () => {
      expect(() => fieldExpr(key)).toThrow("Invalid field path");
    });
  }

  test("a bad key is rejected even when its value is undefined", async () => {
    const err = await errorOf(engine.readTx((s) => s.query("notes").where({ [payloads.orTrue]: undefined }).collect()));
    expect(err.data?.code).toBe("INVALID_FIELD");
  });

  test("plain and dotted field paths and system fields keep working", async () => {
    const byCity = (await engine.call("notes:mine", { filter: { "address.city": "Izmir" } }, ANONYMOUS)) as any[];
    expect(byCity.map((n) => n.text)).toEqual(["a1"]);
    const all = (await engine.call("notes:mine", { filter: {} }, ANONYMOUS)) as any[];
    expect(all.map((n) => n.text)).toEqual(["a1", "a2"]);
    const byId = (await engine.call("notes:mine", { filter: { _id: all[1]._id } }, ANONYMOUS)) as any[];
    expect(byId.map((n) => n.text)).toEqual(["a2"]);
    expect(fieldExpr("address.city")).toBe("json_extract(data, '$.address.city')");
    expect(fieldExpr("_creationTime")).toBe("_creationTime");
  });

  test("admin_list_documents validates its where keys", async () => {
    const err = await errorOf(admin.admin_list_documents!.run({ table: "notes", where: { [payloads.orTrue]: "bob" }, order: "asc", limit: 50, cursor: null }));
    expect(err.data?.code).toBe("INVALID_FIELD");
    const ok = (await admin.admin_list_documents!.run({ table: "notes", where: { "address.city": "Izmir" }, order: "asc", limit: 50, cursor: null })) as any;
    expect(ok.page.map((n: any) => n.text)).toEqual(["a1", "b1"]);
  });
});
