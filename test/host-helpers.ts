import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSystem } from "../src/host/fake-system.ts";
import { HostLayout } from "../src/host/layout.ts";
import { initHost, type HostContext } from "../src/host/provision.ts";
import { Registry, type InitSettings } from "../src/host/registry.ts";

export interface TestHost extends HostContext {
  sys: FakeSystem;
  dir: string;
  close(): void;
}

const hosts: TestHost[] = [];

/** A host on a temp root with a FakeSystem, initialized like `host init` would. */
export async function fakeHost(init: InitSettings = {}): Promise<TestHost> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "incibase-host-")));
  const layout = new HostLayout({ root: join(dir, "root") });
  const sys = new FakeSystem();
  let t = 1_800_000_000_000;
  const ctx = { layout, sys, now: () => (t += 1000), actor: "root:test" } as HostContext & { sys: FakeSystem };
  sys.mkdir(layout.root, 0o755);
  ctx.registry = Registry.open(layout);
  await initHost(ctx, { uidBase: 70000, domain: "incibase.example.net", timezone: "Europe/Istanbul", ...init });
  const host: TestHost = {
    ...ctx,
    dir,
    close() {
      ctx.registry.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  hosts.push(host);
  return host;
}

export function closeHosts() {
  for (const host of hosts.splice(0)) host.close();
}

/** Parses an env file the way systemd reads what the renderer writes (unquoted, or double quotes with \" and \\). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\n") {
      i++;
      continue;
    }
    if (text[i] === "#") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    const eq = text.indexOf("=", i);
    if (eq < 0) throw new Error(`no "=" after ${JSON.stringify(text.slice(i, i + 20))}`);
    const name = text.slice(i, eq);
    i = eq + 1;
    let value = "";
    if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) {
          value += text[i + 1];
          i += 2;
        } else value += text[i++];
      }
      if (text[i] !== '"') throw new Error(`unterminated value of ${name}`);
      i++;
    } else {
      const end = text.indexOf("\n", i);
      value = text.slice(i, end < 0 ? undefined : end);
      i = end < 0 ? text.length : end;
    }
    out[name] = value;
  }
  return out;
}
