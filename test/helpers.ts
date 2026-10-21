import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncibaseClient } from "incibase/client";
import { Engine, type AppDefinition } from "../src/engine/engine.ts";
import { startServer } from "../src/engine/http.ts";
import { loadAppFromDir } from "../src/engine/loader.ts";

export const EXAMPLE_DIR = join(import.meta.dir, "..", "example", "incibase");

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "incibase-test-"));
}

export async function startTestServer(app?: AppDefinition, dataDir = tempDir()) {
  const engine = new Engine(app ?? (await loadAppFromDir(EXAMPLE_DIR)), {
    dataDir,
    dev: true,
    quiet: true,
    publicUrl: "http://placeholder",
  });
  engine.start();
  const server = startServer(engine, { port: 0, hostname: "127.0.0.1" });
  const url = server.url.origin;
  engine.options.publicUrl = url;
  const clients: IncibaseClient[] = [];
  return {
    engine,
    server,
    url,
    dataDir,
    client(token?: string) {
      const c = new IncibaseClient(url, { token, tokenStorage: memoryStorage() });
      clients.push(c);
      return c;
    },
    async stop({ keepData = false } = {}) {
      for (const c of clients) c.close();
      server.stop(true);
      await engine.stop();
      if (!keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function memoryStorage() {
  let token: string | null = null;
  return { get: () => token, set: (t: string | null) => void (token = t) };
}

export function nextValue<T>(): { push: (v: T) => void; next: (timeoutMs?: number) => Promise<T> } {
  const queue: T[] = [];
  const waiters: ((v: T) => void)[] = [];
  return {
    push(v) {
      const w = waiters.shift();
      if (w) w(v);
      else queue.push(v);
    },
    next(timeoutMs = 3000) {
      const v = queue.shift();
      if (v !== undefined) return Promise.resolve(v);
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        setTimeout(() => reject(new Error("timed out waiting for value")), timeoutMs);
      });
    },
  };
}
