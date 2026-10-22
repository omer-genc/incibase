import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { action, defineSchema, defineTable, mutation, z } from "incibase/server";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { exitCodeOf, ExitCode } from "../src/engine/exit-codes.ts";
import { startServer } from "../src/engine/http.ts";
import { s3Key, s3PrefixFrom } from "../src/engine/limits.ts";
import { S3Backend, type S3Like, type StorageOptions } from "../src/engine/storage.ts";
import { readMeta } from "../src/engine/store.ts";
import { UploadGate } from "../src/engine/upload.ts";
import { tempDir } from "./helpers.ts";

const ADMIN_KEY = "ik_admin_storage_limits_test_key";
const MiB = 1024 * 1024;

const schema = defineSchema({
  blobs: defineTable({ text: z.string() }),
});

const modules = {
  files: {
    remove: mutation({ args: { id: z.string() }, handler: (ctx: any, { id }: any) => ctx.storage.delete(id) }),
    storeText: action({ args: { text: z.string() }, handler: (ctx: any, { text }: any) => ctx.storage.store(new Blob([text])) }),
  },
  blobs: {
    add: mutation({ args: { text: z.string() }, handler: (ctx: any, { text }: any) => ctx.db.insert("blobs", { text }) }),
    /** Swallows the first failure and writes again: that write must not commit on its own. */
    addTwice: mutation({
      args: { big: z.string() },
      handler: async (ctx: any, { big }: any) => {
        await ctx.db.insert("blobs", { text: big }).catch(() => {});
        return ctx.db.insert("blobs", { text: "after the failure" });
      },
    }),
    /** Writes, then swallows a DATABASE_FULL and returns normally: the call must still fail, nothing committed. */
    swallow: mutation({
      args: { big: z.string() },
      handler: async (ctx: any, { big }: any) => {
        await ctx.db.insert("blobs", { text: "before the failure" });
        await ctx.db.insert("blobs", { text: big }).catch(() => {});
        return "swallowed";
      },
    }),
    count: mutation({ handler: async (ctx: any) => (await ctx.db.query("blobs").collect()).length }),
  },
};

const app: AppDefinition = { schema, modules };
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}

function start(options: { storage?: StorageOptions; maxDbBytes?: number; dataDir?: string } = {}) {
  const dataDir = options.dataDir ?? dir();
  const engine = new Engine(app, { dataDir, quiet: true, publicUrl: "http://placeholder", adminKey: ADMIN_KEY, ...options });
  engine.start();
  const server = startServer(engine, { port: 0, hostname: "127.0.0.1" });
  engine.options.publicUrl = server.url.origin;
  const stop = async () => {
    server.stop(true);
    await engine.stop();
  };
  stops.push(stop);
  return { engine, url: server.url.origin, dataDir, stop };
}

/** Runs `fn` with `vars` set in process.env, restoring them after. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const auth = { authorization: `Bearer ${ADMIN_KEY}` };

/** A chunked body (no Content-Length) of `size` bytes; `gate` holds it back after the first chunk until it resolves. */
function chunked(size: number, gate?: Promise<unknown>) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent > 0 && gate) await gate;
      if (sent >= size) return controller.close();
      const n = Math.min(64 * 1024, size - sent);
      controller.enqueue(new Uint8Array(n).fill(120));
      sent += n;
    },
  });
}

const upload = (url: string, body: BodyInit | ReadableStream, init: RequestInit = {}) =>
  fetch(`${url}/api/storage/upload`, { method: "POST", headers: auth, body, duplex: "half", ...init } as RequestInit);

const storageFiles = (dataDir: string) => readdirSync(join(dataDir, "storage"));

async function until(check: () => boolean, what: string) {
  for (const end = Date.now() + 5000; !check(); await Bun.sleep(10)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

describe("streamed uploads", () => {
  test("a 100 MiB upload is streamed to disk: memory stays flat and its size and sha256 are right", async () => {
    const data = dir();
    const engineTs = join(import.meta.dir, "..", "src", "engine", "engine.ts");
    const httpTs = join(import.meta.dir, "..", "src", "engine", "http.ts");
    // A separate process, so only the server's memory is measured.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        import { Engine } from ${JSON.stringify(engineTs)};
        import { startServer } from ${JSON.stringify(httpTs)};
        const engine = new Engine({ modules: {} }, { dataDir: ${JSON.stringify(data)}, quiet: true, publicUrl: "http://x", adminKey: ${JSON.stringify(ADMIN_KEY)} });
        const server = startServer(engine, { port: 0, hostname: "127.0.0.1" });
        let peak = 0;
        setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 5);
        console.log(JSON.stringify({ url: server.url.origin }));
        for await (const line of console) {
          if (line === "reset") { Bun.gc(true); peak = process.memoryUsage.rss(); }
          console.log(JSON.stringify({ peak }));
        }
        `,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    );
    stops.push(async () => {
      child.kill("SIGKILL");
      await child.exited;
    });
    const lines = (async function* () {
      let buffer = "";
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        buffer += new TextDecoder().decode(chunk);
        let i: number;
        while ((i = buffer.indexOf("\n")) >= 0) {
          yield JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
        }
      }
    })();
    const next = async () => (await lines.next()).value;
    const ask = async (line: string) => {
      child.stdin.write(`${line}\n`);
      child.stdin.flush();
      return (await next()).peak as number;
    };
    const { url } = await next();

    // Warm up the upload path, then measure from a collected heap.
    expect((await upload(url, chunked(4 * MiB))).status).toBe(200);
    const before = await ask("reset");

    const size = 100 * MiB;
    const hasher = new Bun.CryptoHasher("sha256");
    const base = new Uint8Array(256 * 1024).map((_, i) => (i * 31) & 255);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) return controller.close();
        const chunk = base.slice();
        new DataView(chunk.buffer).setUint32(0, sent);
        hasher.update(chunk);
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const res = await upload(url, body, { headers: { ...auth, "content-type": "application/octet-stream" } });
    expect(res.status).toBe(200);
    const { storageId } = (await res.json()) as { storageId: string };
    const grew = (await ask("peak")) - before;
    // The old path held about three copies (300 MiB) of the file; streamed, it grows by a few MiB.
    expect(grew).toBeLessThan(32 * MiB);

    child.kill("SIGTERM");
    await child.exited;
    const engine = new Engine({ modules: {} }, { dataDir: data, quiet: true, publicUrl: "http://x" });
    try {
      const doc = (await engine.readTx((s) => s.get("_storage", storageId))).result!;
      expect(doc.size).toBe(size);
      expect(doc.sha256).toBe(hasher.digest("hex"));
      expect(Bun.file(join(data, "storage", storageId)).size).toBe(size);
      expect(storageFiles(data).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
      expect(engine.storage.storedBytes()).toBe(size + 4 * MiB);
    } finally {
      await engine.stop();
    }
  }, 60_000);

  test("a chunked upload over the limit is refused as soon as it passes it and leaves no file behind", async () => {
    const { engine, url, dataDir } = start({ storage: { maxUploadBytes: 1 * MiB } });
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const res = await upload(url, endless);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.code).toBe("FILE_TOO_LARGE");
    // Stopped near the limit, not after reading everything (the stream never ends).
    expect(pulled).toBeLessThan(64 * MiB);
    await until(() => storageFiles(dataDir).length === 0, "the temp file to go");
    expect(await engine.readTx((s) => s.query("_storage").collect()).then((r) => r.result)).toEqual([]);
    expect(engine.storage.storedBytes()).toBe(0);

    // A declared Content-Length over the limit is refused before reading.
    const declared = await upload(url, new Uint8Array(MiB + 1));
    expect(declared.status).toBe(413);
    expect(storageFiles(dataDir)).toEqual([]);
  });

  test("an upload whose client goes away leaves no temp file", async () => {
    const { url, dataDir } = start();
    // The server logs the broken connection.
    const logged = spyOn(console, "error").mockImplementation(() => {});
    stops.push(async () => logged.mockRestore());
    const abort = new AbortController();
    const res = upload(url, chunked(10 * MiB, new Promise(() => {})), { signal: abort.signal }).catch((e) => e);
    await until(() => storageFiles(dataDir).some((f) => f.startsWith(".tmp-")), "the temp file");
    abort.abort();
    await res;
    await until(() => storageFiles(dataDir).length === 0, "the temp file to go");
  });

  test("temp files left by a killed process are removed on start", async () => {
    const first = start();
    await first.stop();
    stops.pop();
    writeFileSync(join(first.dataDir, "storage", ".tmp-leftover"), "half an upload");
    writeFileSync(join(first.dataDir, "storage", "keep-me"), "not a temp file");
    start({ dataDir: first.dataDir });
    expect(storageFiles(first.dataDir)).toEqual(["keep-me"]);
  });

  test("the detected type and the grant's types are checked from the first bytes", async () => {
    const { engine, url } = start();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const res = await upload(url, png, { headers: { ...auth, "content-type": "text/plain" } });
    const { storageId } = (await res.json()) as { storageId: string };
    const doc = (await engine.readTx((s) => s.get("_storage", storageId))).result!;
    expect(doc.contentType).toBe("image/png");
    expect(doc.sha256).toBe(new Bun.CryptoHasher("sha256").update(png).digest("hex"));
    const empty = (await (await upload(url, new Uint8Array(0))).json()) as { storageId: string };
    expect((await engine.readTx((s) => s.get("_storage", empty.storageId))).result!.size).toBe(0);
  });
});

describe("upload concurrency", () => {
  test("uploads past the limit wait in order, then get UPLOADS_BUSY", async () => {
    const { engine, url } = start({ storage: { uploadConcurrency: 1, uploadQueueTimeoutMs: 300 } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = upload(url, chunked(256 * 1024, held));
    await until(() => engine.storage.uploads.active === 1, "the first upload to start");

    const busy = await upload(url, "waits too long");
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("5");
    expect(((await busy.json()) as any).error.code).toBe("UPLOADS_BUSY");

    const queued = upload(url, "gets the slot next");
    await until(() => engine.storage.uploads.queued === 1, "the second upload to queue");
    release();
    expect((await first).status).toBe(200);
    expect((await queued).status).toBe(200);
    expect(engine.storage.uploads.active).toBe(0);
  });

  test("INCIBASE_UPLOAD_CONCURRENCY sets the limit; by default there is none, as in 0.2.0", () => {
    const unlimited = start().engine.storage.uploads;
    expect(unlimited.limit).toBe(Infinity);
    expect(unlimited.full).toBe(false);
    expect(start({ storage: { uploadConcurrency: 3 } }).engine.storage.uploads.limit).toBe(3);
    expect(withEnv({ INCIBASE_UPLOAD_CONCURRENCY: "5" }, () => start({ storage: { uploadConcurrency: 3 } })).engine.storage.uploads.limit).toBe(5);
  });

  test("the gate hands a freed slot to the longest waiter", async () => {
    const gate = new UploadGate(1, 1000);
    const order: string[] = [];
    const a = await gate.acquire();
    const b = gate.acquire().then((free) => (order.push("b"), free));
    const c = gate.acquire().then((free) => (order.push("c"), free));
    a();
    (await b)();
    (await c)();
    expect(order).toEqual(["b", "c"]);
    expect(gate.active).toBe(0);
    const aborted = new AbortController();
    const hold = await gate.acquire();
    const waiting = gate.acquire(aborted.signal).catch((e) => e);
    aborted.abort();
    expect(await waiting).toBeDefined();
    expect(gate.queued).toBe(0);
    hold();
    expect(gate.active).toBe(0);
  });
});

describe("storage quota", () => {
  test("storage_bytes follows uploads, deletes and cleanup, and uploads past the quota fail with STORAGE_QUOTA", async () => {
    const { engine, url, dataDir } = start({ storage: { maxStorageBytes: 1000 } });
    const admin = { userId: null, admin: true };
    const meta = () => Number(readMeta(join(dataDir, "data.db"), "storage_bytes"));
    const id = async (res: Response) => ((await res.json()) as { storageId: string }).storageId;

    const a = await id(await upload(url, new Uint8Array(600)));
    expect(engine.storage.storedBytes()).toBe(600);
    expect(meta()).toBe(600);

    for (const body of [new Uint8Array(500), chunked(500)]) {
      const over = await upload(url, body);
      expect(over.status).toBe(507);
      expect(((await over.json()) as any).error.code).toBe("STORAGE_QUOTA");
    }
    const viaAction: any = await engine.call("files:storeText", { text: "x".repeat(401) }, admin).catch((e) => e);
    expect(viaAction.data.code).toBe("STORAGE_QUOTA");
    await until(() => storageFiles(dataDir).length === 1, "the refused temp files to go");
    expect(engine.storage.storedBytes()).toBe(600);

    const b = await engine.call("files:storeText", { text: "x".repeat(400) }, admin);
    expect(engine.storage.storedBytes()).toBe(1000);

    await engine.call("files:remove", { id: a }, admin);
    expect(engine.storage.storedBytes()).toBe(400);
    expect(meta()).toBe(400);

    // `b` was never put into a document: cleanup collects it a day later.
    expect(await engine.storage.cleanup(Date.now() + 25 * 3600_000)).toBe(1);
    expect(engine.storage.storedBytes()).toBe(0);
    expect((await engine.readTx((s) => s.get("_storage", b as string))).result).toBeNull();
    expect((await upload(url, new Uint8Array(1000))).status).toBe(200);
  });

  test("a start recomputes a total that drifted", async () => {
    const first = start();
    await upload(first.url, new Uint8Array(300));
    await first.engine.writeTx((s) => s.conn.query(`UPDATE _incibase_meta SET value = '12345' WHERE key = 'storage_bytes'`).run());
    await first.stop();
    stops.pop();
    const again = start({ dataDir: first.dataDir });
    expect(again.engine.storage.storedBytes()).toBe(300);
  });

  test("INCIBASE_MAX_STORAGE_BYTES and INCIBASE_MAX_UPLOAD_BYTES win over the options", async () => {
    const { engine } = withEnv({ INCIBASE_MAX_STORAGE_BYTES: "2048", INCIBASE_MAX_UPLOAD_BYTES: "1024" }, () =>
      start({ storage: { maxStorageBytes: 10 * MiB, maxUploadBytes: 10 * MiB } }),
    );
    expect(engine.storage.maxStorageBytes).toBe(2048);
    expect(engine.storage.maxUploadBytes).toBe(1024);
    expect(start({ storage: { maxUploadBytes: 4096 } }).engine.storage.maxUploadBytes).toBe(4096);
  });
});

describe("database size cap", () => {
  test("a write past INCIBASE_MAX_DB_BYTES fails with DATABASE_FULL, rolls back whole, and the server keeps working", async () => {
    const { engine, url } = withEnv({ INCIBASE_MAX_DB_BYTES: String(512 * 1024) }, () => start());
    expect((engine.store.write.query("PRAGMA max_page_count").get() as any).max_page_count).toBe(128);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    stops.push(async () => logged.mockRestore());
    const admin = { userId: null, admin: true };
    await engine.call("blobs:add", { text: "small" }, admin);

    const res = await fetch(`${url}/api/mutation`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ path: "blobs:add", args: { text: "x".repeat(800 * 1024) } }),
    });
    expect(res.status).toBe(507);
    expect(((await res.json()) as any).error.code).toBe("DATABASE_FULL");

    // The first insert's failure rolled the transaction back; the second must not commit on its own.
    const twice: any = await engine.call("blobs:addTwice", { big: "x".repeat(800 * 1024) }, admin).catch((e) => e);
    expect([twice.data?.code, twice.status]).toEqual(["DATABASE_FULL", 507]);
    expect(await engine.call("blobs:count", {}, admin)).toBe(1);

    // A handler that swallows DATABASE_FULL and returns still fails with it, over HTTP too, and its earlier write is gone.
    for (const path of ["blobs:swallow", "blobs:addTwice"]) {
      const swallowed = await fetch(`${url}/api/mutation`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ path, args: { big: "x".repeat(800 * 1024) } }),
      });
      expect([path, swallowed.status, ((await swallowed.json()) as any).error.code]).toEqual([path, 507, "DATABASE_FULL"]);
    }
    expect(await engine.call("blobs:count", {}, admin)).toBe(1);
    await engine.call("blobs:add", { text: "still fits" }, admin);
    expect(await engine.call("blobs:count", {}, admin)).toBe(2);
  });

  test("maxDbBytes in code works without the env var", async () => {
    const { engine } = start({ maxDbBytes: 1024 * 1024 });
    expect((engine.store.write.query("PRAGMA max_page_count").get() as any).max_page_count).toBe(256);
  });

  test("without a cap nothing changes", async () => {
    const { engine } = start();
    expect((engine.store.write.query("PRAGMA max_page_count").get() as any).max_page_count).toBeGreaterThan(1_000_000);
  });
});

describe("configuration", () => {
  test("invalid limit values are configuration errors (exit 64) before the data dir is touched", () => {
    const bad: Record<string, string>[] = [
      { INCIBASE_MAX_DB_BYTES: "lots" },
      { INCIBASE_MAX_DB_BYTES: "0" },
      { INCIBASE_MAX_STORAGE_BYTES: "-1" },
      { INCIBASE_MAX_UPLOAD_BYTES: "1.5" },
      { INCIBASE_UPLOAD_CONCURRENCY: "0" },
      { INCIBASE_S3_PREFIX: "/shop/b1/" },
    ];
    for (const vars of bad) {
      const dataDir = join(dir(), "data");
      const err = withEnv(vars, () => {
        try {
          new Engine(app, { dataDir, quiet: true, publicUrl: "http://x" });
        } catch (e) {
          return e;
        }
      });
      expect([vars, exitCodeOf(err)]).toEqual([vars, ExitCode.CONFIG]);
      expect(existsSync(dataDir)).toBe(false);
    }
    const optionErr = (() => {
      try {
        start({ storage: { maxStorageBytes: 0 } });
      } catch (e) {
        return e;
      }
    })();
    expect(exitCodeOf(optionErr)).toBe(ExitCode.CONFIG);
  });
});

describe("S3 prefix", () => {
  test("valid prefixes are path segments ending in a slash", () => {
    for (const ok of ["shop/b7k2m9q4/", "a/", "my-project/main_1/v.2/"]) expect(s3PrefixFrom(ok)).toBe(ok);
    expect(s3PrefixFrom("")).toBe("");
    for (const bad of ["/shop/", "shop", "shop//b/", "shop/../b/", "./", "shop/b c/", "shöp/", "a\\b/", `${"a".repeat(600)}/`]) {
      expect(() => s3PrefixFrom(bad)).toThrow(/storage\.s3Prefix/);
    }
    expect(withEnv({ INCIBASE_S3_PREFIX: "shop/b1/" }, () => s3PrefixFrom(undefined))).toBe("shop/b1/");
    expect(() => withEnv({ INCIBASE_S3_PREFIX: "shop" }, () => s3PrefixFrom(undefined))).toThrow(/INCIBASE_S3_PREFIX/);
    expect(s3Key("shop/b1/", "abc")).toBe("shop/b1/abc");
  });

  test("every S3 call uses the prefixed key", async () => {
    const calls: [string, string][] = [];
    const fake = {
      write: async (key: string, data: unknown) => {
        calls.push(["write", key]);
        expect(await (data as Blob).text()).toBe("hello");
        return 5;
      },
      file: (key: string) => {
        calls.push(["file", key]);
        return { exists: async () => true } as any;
      },
      delete: async (key: string) => void calls.push(["delete", key]),
      presign: (key: string) => (calls.push(["presign", key]), `https://bucket/${key}`),
    } as unknown as S3Like;
    const backend = new S3Backend(undefined, "shop/b1/", fake);
    const path = join(dir(), ".tmp-x");
    writeFileSync(path, "hello");
    await backend.putFile("id1", path, "text/plain");
    await backend.get("id1");
    await backend.delete("id1");
    expect(backend.presign("id1", 60)).toBe("https://bucket/shop/b1/id1");
    expect(calls).toEqual([
      ["write", "shop/b1/id1"],
      ["file", "shop/b1/id1"],
      ["delete", "shop/b1/id1"],
      ["presign", "shop/b1/id1"],
    ]);
  });

  test("an invalid storage.s3Prefix stops the start", () => {
    const err = (() => {
      try {
        start({ storage: { backend: "s3", bucket: "b", s3Prefix: "no-slash" } });
      } catch (e) {
        return e;
      }
    })();
    expect(exitCodeOf(err)).toBe(ExitCode.CONFIG);
  });
});
