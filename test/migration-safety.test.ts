import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineSchema, defineTable, file, id, z, type SchemaDefinition } from "incibase";
import { Engine, type EngineOptions } from "../src/engine/engine.ts";
import { MigrationError } from "../src/engine/migrate.ts";
import { tempDir } from "./helpers.ts";

const dirs: string[] = [];
const engines: Engine[] = [];

function open(schema: SchemaDefinition | undefined, dataDir: string, options: Partial<EngineOptions> = {}) {
  const engine = new Engine({ schema, modules: {} }, { dataDir, quiet: true, publicUrl: "http://localhost", ...options });
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

/** What `open` throws, or null. */
function openError(schema: SchemaDefinition | undefined, dataDir: string, options: Partial<EngineOptions> = {}) {
  try {
    open(schema, dataDir, options);
    return null;
  } catch (err) {
    return err as MigrationError;
  }
}

const rawDocs = (engine: Engine, table: string) =>
  (engine.store.write.query(`SELECT data FROM "${table}" ORDER BY _creationTime`).all() as { data: string }[]).map((r) => JSON.parse(r.data));

const HOUR = 3600_000;

describe("removing fields", () => {
  const v1 = defineSchema({
    customers: defineTable({ name: z.string(), taxNumber: z.string() }),
  });

  async function seeded() {
    const data = dir();
    const first = open(v1, data);
    await first.writeTx(async (s) => {
      for (const name of ["Acme", "Globex", "Initech"]) await s.insert("customers", { name, taxNumber: `TR-${name}` });
    });
    await first.stop();
    return data;
  }

  test("a field that holds data is not deleted: the migration is refused and changes nothing", async () => {
    const data = await seeded();
    const v2 = defineSchema({ customers: defineTable({ name: z.string() }).index("by_name", ["name"]) });

    const err = openError(v2, data);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err!.removedFields).toEqual([{ table: "customers", field: "taxNumber", documents: 3 }]);
    expect(err!.message).toContain("customers.taxNumber: 3 document(s)");
    expect(err!.message).toContain("--allow-field-removal");

    const again = open(v1, data);
    expect(again.migration.rewrittenDocuments).toBe(0);
    expect(again.store.write.query(`SELECT name FROM sqlite_master WHERE name = 'customers__by_name'`).get()).toBeNull();
    expect(rawDocs(again, "customers").map((d) => d.taxNumber)).toEqual(["TR-Acme", "TR-Globex", "TR-Initech"]);
  });

  test("a rename whose new field has a default is refused too", async () => {
    const data = await seeded();
    const renamed = defineSchema({ customers: defineTable({ name: z.string(), taxId: z.string().default("") }) });
    const err = openError(renamed, data);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err!.removedFields).toEqual([{ table: "customers", field: "taxNumber", documents: 3 }]);

    const again = open(v1, data);
    expect(rawDocs(again, "customers")[0]).toEqual({ name: "Acme", taxNumber: "TR-Acme" });
  });

  test("keys of nested objects and of objects inside arrays count", async () => {
    const data = dir();
    const orders1 = defineSchema({
      orders: defineTable({
        address: z.object({ city: z.string(), zip: z.string().optional() }),
        items: z.array(z.object({ sku: z.string(), qty: z.number() })),
      }),
    });
    const first = open(orders1, data);
    await first.writeTx(async (s) => {
      await s.insert("orders", { address: { city: "Ist", zip: "34000" }, items: [{ sku: "a", qty: 1 }, { sku: "b", qty: 2 }] });
      await s.insert("orders", { address: { city: "Ank" }, items: [{ sku: "c", qty: 1 }] });
      await s.insert("orders", { address: { city: "Izm" }, items: [] });
    });
    await first.stop();

    const orders2 = defineSchema({
      orders: defineTable({
        address: z.object({ city: z.string() }),
        items: z.array(z.object({ qty: z.number() })),
      }),
    });
    const err = openError(orders2, data);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err!.removedFields).toEqual([
      { table: "orders", field: "address.zip", documents: 1 },
      { table: "orders", field: "items[].sku", documents: 2 },
    ]);
    const again = open(orders1, data);
    expect(rawDocs(again, "orders")[0].items).toEqual([{ sku: "a", qty: 1 }, { sku: "b", qty: 2 }]);
  });

  test("allowFieldRemoval deletes the data and reports what went", async () => {
    const data = await seeded();
    const v2 = defineSchema({ customers: defineTable({ name: z.string() }) });
    const second = open(v2, data, { allowFieldRemoval: true });
    expect(second.migration.removedFields).toEqual([{ table: "customers", field: "taxNumber", documents: 3 }]);
    expect(second.migration.rewrittenDocuments).toBe(3);
    expect(rawDocs(second, "customers")).toEqual([{ name: "Acme" }, { name: "Globex" }, { name: "Initech" }]);
  });

  test("a field no document has a value for can go, and new defaults are still written", async () => {
    const data = dir();
    const withNickname = defineSchema({ customers: defineTable({ name: z.string(), nickname: z.string().optional() }) });
    const first = open(withNickname, data);
    await first.writeTx((s) => s.insert("customers", { name: "Acme" }));
    await first.stop();

    const v2 = defineSchema({ customers: defineTable({ name: z.string(), tier: z.string().default("basic") }) });
    const second = open(v2, data);
    expect(second.migration.removedFields).toEqual([]);
    expect(second.migration.rewrittenDocuments).toBe(1);
    expect(rawDocs(second, "customers")).toEqual([{ name: "Acme", tier: "basic" }]);
  });

  test("documents that no longer validate and removed fields are reported together", async () => {
    const data = await seeded();
    const v2 = defineSchema({ customers: defineTable({ name: z.string().min(5) }) });
    const err = openError(v2, data, { allowFieldRemoval: true });
    expect(err).toBeInstanceOf(MigrationError);
    expect(err!.problems.length).toBe(1); // "Acme" is too short
    expect(err!.removedFields).toEqual([]); // allowed, so not a problem
    // Without the flag the field counts too, for the documents that still validate.
    expect(openError(v2, data)!.removedFields).toEqual([{ table: "customers", field: "taxNumber", documents: 2 }]);
  });
});

describe("missing schema", () => {
  const v1 = defineSchema({ tasks: defineTable({ title: z.string() }), notes: defineTable({ text: z.string() }) });

  test("starting without a schema while tables exist is refused and deactivates nothing", async () => {
    const data = dir();
    const first = open(v1, data);
    await first.writeTx((s) => s.insert("tasks", { title: "keep me" }));
    await first.stop();

    const err = openError(undefined, data);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err!.message).toContain("No schema was loaded");
    expect(err!.message).toContain("2 table(s)");

    const again = open(v1, data);
    const active = again.store.write.query(`SELECT name, active FROM _incibase_tables ORDER BY name`).all();
    expect(active).toEqual([
      { name: "notes", active: 1 },
      { name: "tasks", active: 1 },
    ]);
    expect(rawDocs(again, "tasks")).toEqual([{ title: "keep me" }]);
  });

  test("an empty database starts without a schema, and an empty schema removes tables on purpose", async () => {
    const data = dir();
    const bare = open(undefined, data);
    expect(bare.migration.deactivatedTables).toEqual([]);
    await bare.stop();

    const first = open(v1, data);
    await first.stop();
    const empty = open(defineSchema({}), data);
    expect(empty.migration.deactivatedTables.sort()).toEqual(["notes", "tasks"]);
  });
});

const blob = (text: string) => new Blob([text], { type: "text/plain" });
const meta = (engine: Engine, fileId: string) =>
  engine.store.write.query(`SELECT data FROM _storage WHERE _id = ?`).get(fileId) as { data: string } | null;

describe("files behind plain id(\"_storage\") fields", () => {
  const contracts = defineSchema({
    contracts: defineTable({ title: z.string(), pdf: id("_storage") }),
  });

  async function withContract() {
    const data = dir();
    const first = open(contracts, data);
    const pdf = await first.storage.store(blob("signed contract"));
    await first.writeTx((s) => s.insert("contracts", { title: "Lease", pdf }));
    expect(JSON.parse(meta(first, pdf)!.data).pending).toBeUndefined();
    await first.stop();
    return { data, pdf };
  }

  test("removing the table from the schema keeps its files past the grace period", async () => {
    const { data, pdf } = await withContract();
    const second = open(defineSchema({ other: defineTable({ x: z.string() }) }), data);
    expect(second.migration.deactivatedTables).toEqual(["contracts"]);
    expect(await second.storage.cleanup(Date.now() + 25 * HOUR)).toBe(0);
    expect(meta(second, pdf)).not.toBeNull();
    expect(await (await second.storage.get(pdf))!.text()).toBe("signed contract");
    await second.stop();

    const third = open(contracts, data);
    const [contract] = rawDocs(third, "contracts");
    expect(contract.pdf).toBe(pdf);
    expect(await (await third.storage.get(contract.pdf))!.text()).toBe("signed contract");
  });

  test("changing the field's type keeps its files", async () => {
    const { data, pdf } = await withContract();
    const second = open(defineSchema({ contracts: defineTable({ title: z.string(), pdf: z.string() }) }), data);
    expect(await second.storage.cleanup(Date.now() + 25 * HOUR)).toBe(0);
    expect(await second.storage.get(pdf)).not.toBeNull();
  });

  test("cleanup still finds references in removed tables and changed fields for files left pending", async () => {
    const data = dir();
    const v1 = defineSchema({
      contracts: defineTable({ pdf: id("_storage") }),
      invoices: defineTable({ scan: id("_storage") }),
    });
    const first = open(v1, data);
    const pdf = await first.storage.store(blob("pdf"));
    const scan = await first.storage.store(blob("scan"));
    const orphan = await first.storage.store(blob("orphan"));
    await first.writeTx(async (s) => {
      await s.insert("contracts", { pdf });
      await s.insert("invoices", { scan });
    });
    // As written before plain references cleared the flag.
    first.store.write.run(`UPDATE _storage SET data = json_set(data, '$.pending', json('true'))`);
    await first.stop();

    const second = open(defineSchema({ invoices: defineTable({ scan: z.string() }) }), data);
    expect(await second.storage.cleanup(Date.now() + 25 * HOUR)).toBe(1);
    expect(meta(second, orphan)).toBeNull();
    expect(await second.storage.get(pdf)).not.toBeNull();
    expect(await second.storage.get(scan)).not.toBeNull();
  });
});

describe("cleanup racing writes", () => {
  const albums = defineSchema({ albums: defineTable({ title: z.string(), cover: file().optional() }) });

  async function setup() {
    const engine = open(albums, dir());
    const first = await engine.storage.store(blob("first"));
    const second = await engine.storage.store(blob("second"));
    const albumId = await engine.writeTx((s) => s.insert("albums", { title: "Trip", cover: first }));
    return { engine, first, second, albumId };
  }

  test("a write queued before cleanup that takes a detached file back keeps it", async () => {
    const { engine, first, second, albumId } = await setup();
    await engine.writeTx((s) => s.patch(albumId, { cover: second })); // first is now detached
    expect(JSON.parse(meta(engine, first)!.data).pending).toBe(true);

    const gate = Promise.withResolvers<void>();
    const putBack = engine.writeTx(async (s) => {
      await gate.promise;
      await s.patch(albumId, { cover: first });
    });
    const cleaning = engine.storage.cleanup(Date.now() + 2 * HOUR);
    gate.resolve();
    await putBack;

    expect(await cleaning).toBe(1); // second, detached by putBack
    expect(JSON.parse(meta(engine, first)!.data).attachedTo.id).toBe(albumId);
    expect(await engine.storage.get(first)).not.toBeNull();
    expect(meta(engine, second)).toBeNull();
  });

  test("cleanup never acts on a write that is later rolled back", async () => {
    const { engine, first, albumId } = await setup();
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const failing = engine.writeTx(async (s) => {
      await s.delete(albumId); // detaches first, uncommitted
      reached.resolve();
      await gate.promise;
      throw new Error("rolled back");
    });
    await reached.promise;
    const cleaning = engine.storage.cleanup(Date.now() + 2 * HOUR);
    gate.resolve();
    await expect(failing).rejects.toThrow("rolled back");

    expect(await cleaning).toBe(0);
    expect(rawDocs(engine, "albums")).toHaveLength(1);
    expect(JSON.parse(meta(engine, first)!.data).attachedTo.id).toBe(albumId);
    expect(await engine.storage.get(first)).not.toBeNull();
  });
});

describe("incibase serve", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");

  async function app() {
    const root = dir();
    const data = join(root, "data");
    const first = open(defineSchema({ customers: defineTable({ name: z.string(), taxNumber: z.string() }) }), data);
    await first.writeTx((s) => s.insert("customers", { name: "Acme", taxNumber: "TR-1" }));
    await first.stop();
    const source = join(root, "app");
    mkdirSync(source);
    writeFileSync(
      join(source, "schema.ts"),
      `import { defineSchema, defineTable, z } from "incibase/server";\nexport default defineSchema({ customers: defineTable({ name: z.string() }) });\n`,
    );
    return { data, source };
  }

  const serve = (source: string, data: string, ...flags: string[]) =>
    Bun.spawn([process.execPath, CLI, "serve", "--dir", source, "--data", data, "--port", "0", "--host", "127.0.0.1", ...flags], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, INCIBASE_RESTART: "1" },
      timeout: 15_000,
      killSignal: "SIGKILL",
    });

  test("refuses a schema that drops a field, and --allow-field-removal applies and reports it", async () => {
    const { data, source } = await app();

    const refused = serve(source, data);
    expect(await refused.exited).toBe(1);
    expect(await new Response(refused.stderr).text()).toContain("customers.taxNumber: 1 document(s)");

    const allowed = serve(source, data, "--allow-field-removal");
    let out = "";
    const decoder = new TextDecoder();
    for await (const chunk of allowed.stdout) {
      out += decoder.decode(chunk);
      if (out.includes("ready")) break;
    }
    allowed.kill("SIGTERM");
    await allowed.exited;
    expect(out).toContain("- field customers.taxNumber (data deleted from 1 document(s))");
  }, 20_000);
});
