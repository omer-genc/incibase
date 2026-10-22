import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { defineSchema, defineTable, z } from "incibase";
import { query } from "incibase/server";
import { adminTools } from "../src/engine/admin.ts";
import { assertReadQuery, runAdminSql } from "../src/engine/adminsql.ts";
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
let other: Engine;
let admin: ReturnType<typeof adminTools>;

beforeAll(async () => {
  dirs.push(tempDir(), tempDir());
  engine = new Engine({ schema, modules: { notes } }, { dataDir: dirs[0]!, quiet: true, publicUrl: "http://localhost" });
  // A second branch on the same host, which admin_sql must not be able to reach.
  other = new Engine({ schema, modules: {} }, { dataDir: dirs[1]!, quiet: true, publicUrl: "http://localhost" });
  admin = adminTools(engine);
  await engine.writeTx(async (s) => {
    await s.insert("notes", { owner: "alice", text: "a1", address: { city: "Izmir" } });
    await s.insert("notes", { owner: "alice", text: "a2", address: { city: "Ankara" } });
    await s.insert("notes", { owner: "bob", text: "b1", address: { city: "Izmir" } });
  });
});

afterAll(async () => {
  await engine.stop();
  await other.stop();
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

describe("admin_sql", () => {
  const sql = (query: string, params: (string | number | null)[] = []) => admin.admin_sql!.run({ query, params }) as Promise<{ rows: any[]; truncated: boolean }>;
  const refusal = async (query: string) => {
    const err = await errorOf(sql(query));
    expect(err.data?.code).toBe("SQL_NOT_ALLOWED");
    return err.message;
  };

  test("runs a normal SELECT with params", async () => {
    const result = await sql(`SELECT json_extract(data, '$.text') AS text FROM notes WHERE json_extract(data, '$.owner') = ? ORDER BY _creationTime;`, ["alice"]);
    expect(result).toEqual({ rows: [{ text: "a1" }, { text: "a2" }], truncated: false });
    expect((await sql("WITH t AS (SELECT 2 AS n) SELECT n FROM t")).rows).toEqual([{ n: 2 }]);
    expect((await sql("EXPLAIN QUERY PLAN SELECT * FROM notes")).rows.length).toBeGreaterThan(0);
    // Hidden names inside comments or longer strings are fine.
    expect((await sql("SELECT '%_sessions%' AS pattern -- _passwords")).rows).toEqual([{ pattern: "%_sessions%" }]);
  });

  test("caps rows without reading the whole result", async () => {
    // An endless result: .all() would never return.
    const result = await sql("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c");
    expect(result.rows).toHaveLength(1000);
    expect(result.rows.at(-1)).toEqual({ x: 1000 });
    expect(result.truncated).toBe(true);
  });

  test("refuses ATTACH, so other branches stay out of reach", async () => {
    const otherDb = join(dirs[1]!, "data.db");
    expect(await refusal(`ATTACH DATABASE '${otherDb}' AS p`)).toContain("not ATTACH");
    await refusal(`/* comment */ attach '${otherDb}' as p`);
    await refusal(`EXPLAIN ATTACH '${otherDb}' AS p`);
    expect(engine.store.read.query("SELECT name FROM pragma_database_list").all()).toEqual([{ name: "main" }]);
  });

  test("refuses more than one statement", async () => {
    expect(await refusal(`SELECT 1; ATTACH '${join(dirs[1]!, "data.db")}' AS p`)).toContain("exactly one statement");
    await refusal("SELECT 1; SELECT 2");
    await refusal("SELECT 1 /* ; */ ; -- \n SELECT 2");
    await refusal("");
    await refusal(" ; ");
  });

  test("refuses statements that are not reads", async () => {
    for (const q of [
      "DETACH p",
      "PRAGMA query_only = OFF",
      "pragma journal_mode",
      "VACUUM",
      "VACUUM INTO '/tmp/copy.db'",
      "BEGIN",
      "COMMIT",
      "CREATE TEMP TABLE t (a)",
      "DELETE FROM notes",
      "WITH x AS (SELECT 1) DELETE FROM notes",
      "WITH x AS (SELECT 1) INSERT INTO notes SELECT * FROM notes",
      "EXPLAIN EXPLAIN SELECT 1",
      "(SELECT 1)",
    ]) {
      await refusal(q);
    }
  });

  test("refuses tables holding secrets, however they are quoted", async () => {
    for (const q of [
      "SELECT * FROM _incibase_meta",
      'SELECT * FROM "_INCIBASE_META"',
      'SELECT * FROM "main"."_sessions"',
      "SELECT * FROM [ _passwords ]",
      "SELECT * FROM main.`_Passwords`",
      "SELECT * FROM '_passwords'",
      "SELECT (SELECT value FROM _incibase_meta WHERE key = 'admin_key') AS k",
      "SELECT * FROM notes WHERE EXISTS (select 1 from _SESSIONS)",
      "WITH s AS (SELECT * FROM _passwords) SELECT * FROM s",
      "SELECT * FROM sqlite_dbpage",
    ]) {
      expect(await refusal(q)).toContain("cannot read");
    }
  });

  test("reports SQL errors with their message", async () => {
    const err = await errorOf(sql("SELECT * FROM no_such_table"));
    expect(err.data?.code).toBe("SQL_ERROR");
    expect(err.message).toContain("no such table");
  });

  test("stops a query that runs past the timeout", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = performance.now();
    // Yields a row only every million steps, so 1000 rows would take far longer than the timeout.
    const slow = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c WHERE x % 1000000 = 0";
    const err = await errorOf(runAdminSql(engine.store.path, slow, [], { timeoutMs: 200 }));
    clearInterval(timer);
    expect(err.data?.code).toBe("SQL_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(ticks).toBeGreaterThan(5); // the event loop kept running meanwhile
    // The terminated worker does not hold a slot for long.
    await Bun.sleep(500);
    expect((await sql("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  });

  test("queues concurrent queries and refuses when slow ones hold every slot", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => sql("SELECT ? AS i", [i])));
    expect(results.map((r) => r.rows[0].i)).toEqual([0, 1, 2, 3, 4, 5]);

    const slow = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c WHERE x % 1000000 = 0";
    const hogs = [1, 2].map(() => errorOf(runAdminSql(engine.store.path, slow, [], { timeoutMs: 600 })));
    const busy = await errorOf(runAdminSql(engine.store.path, "SELECT 1", [], { timeoutMs: 100 }));
    expect(busy.data?.code).toBe("SQL_BUSY");
    for (const hog of await Promise.all(hogs)) expect(hog.data?.code).toBe("SQL_TIMEOUT");
    expect((await sql("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  });
});

test("assertReadQuery accepts reads and nothing else", () => {
  expect(() => assertReadQuery("select 1")).not.toThrow();
  expect(() => assertReadQuery("VALUES (1), (2)")).not.toThrow();
  expect(() => assertReadQuery("WITH RECURSIVE c(x) AS MATERIALIZED (SELECT 1) SELECT * FROM c")).not.toThrow();
  expect(() => assertReadQuery("SELECT 'it''s' AS a")).not.toThrow();
  expect(() => assertReadQuery("SELECT 'unterminated")).toThrow();
  expect(() => assertReadQuery('SELECT "a""b" FROM "x"; ATTACH')).toThrow("exactly one statement");
});
