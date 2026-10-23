// What the owner operations run with: the host's layout, registry, system and
// service manager, how to run this incibase again as root (for transient
// jobs) and how to probe a branch. `openHost` builds it for the real machine
// from the host root alone; the registry holds the rest of the layout.
import { join } from "node:path";
import { IS_COMPILED } from "../engine/build.ts";
import type { Driver } from "./driver.ts";
import { HostLayout, type LayoutOptions } from "./layout.ts";
import type { HostContext } from "./provision.ts";
import { Registry, RegistryError } from "./registry.ts";
import { SystemdDriver } from "./systemd.ts";
import { LinuxSystem } from "./system.ts";

/** What `/api/health` on a branch's admin socket says, as far as the host uses it. */
export interface HealthReply {
  generation: string | null;
  serviceKeys?: { sha256: string | null };
}

export interface OpsContext extends HostContext {
  driver: Driver;
  /** The command that runs this incibase as root, e.g. `["/usr/local/bin/incibase"]`; transient jobs start with it. */
  self: string[];
  /** GET /api/health on a unix socket; null when nothing (healthy) answers. */
  health?: (socket: string) => Promise<HealthReply | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Progress lines; the CLI prints them, a job writes them to its journal. */
  log?: (line: string) => void;
  /** How often gates and job followers poll (default 250 ms). */
  pollMs?: number;
  /** How long a generation must stay healthy before a gate passes (default 1 s). */
  settleMs?: number;
  /** The shortest a gate waits for a start (default 60 s). */
  gateFloorMs?: number;
}

/** The command that runs this same incibase: the binary, or bun with src/cli.ts. */
export function selfCommand(): string[] {
  return IS_COMPILED ? [process.execPath] : [process.execPath, join(import.meta.dir, "..", "cli.ts")];
}

/**
 * GET /api/health over a branch's admin socket, as root. The answer comes
 * from tenant code: it is read with a deadline and a size cap, and only the
 * two fields the host needs are kept.
 */
export async function probeHealth(socket: string, timeoutMs = 2000): Promise<HealthReply | null> {
  try {
    const res = await fetch("http://localhost/api/health", { unix: socket, signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 64 * 1024) return null;
    const json = JSON.parse(text) as { generation?: unknown; serviceKeys?: { sha256?: unknown } };
    const reply: HealthReply = { generation: typeof json.generation === "string" ? json.generation : null };
    if (json.serviceKeys && typeof json.serviceKeys === "object") {
      reply.serviceKeys = { sha256: typeof json.serviceKeys.sha256 === "string" ? json.serviceKeys.sha256 : null };
    }
    return reply;
  } catch {
    return null;
  }
}

/**
 * The context for the host at `root` on this machine: LinuxSystem,
 * systemd, and the layout `host init` saved. Before init, `layout` gives
 * the options to initialize with.
 */
export function openHost(options: { root: string; layout?: Omit<LayoutOptions, "root">; self?: string[] }): OpsContext {
  if (process.platform !== "linux") throw new RegistryError("incibase host runs on Linux with systemd");
  if (process.getuid?.() !== 0) throw new RegistryError("incibase host commands must run as root (sudo)");
  const base = new HostLayout({ root: options.root, ...options.layout });
  const registry = Registry.open(base);
  const saved = registry.savedLayout();
  const layout = saved ? new HostLayout({ root: options.root, ...saved }) : base;
  if (saved && options.layout) {
    const asked = JSON.stringify(base.saved());
    if (asked !== JSON.stringify(layout.saved())) {
      registry.close();
      throw new RegistryError(`${options.root} was initialized with the layout ${JSON.stringify(layout.saved())}, not ${asked}`);
    }
  }
  return { layout, registry, sys: new LinuxSystem(), driver: new SystemdDriver(), self: options.self ?? selfCommand() };
}

export const defaults = {
  sleep: (ctx: OpsContext) => ctx.sleep ?? ((ms: number) => Bun.sleep(ms)),
  health: (ctx: OpsContext) => ctx.health ?? ((socket: string) => probeHealth(socket)),
  log: (ctx: OpsContext) => ctx.log ?? ((line: string) => console.log(line)),
  pollMs: (ctx: OpsContext) => ctx.pollMs ?? 250,
  settleMs: (ctx: OpsContext) => ctx.settleMs ?? 1000,
  gateFloorMs: (ctx: OpsContext) => ctx.gateFloorMs ?? 60_000,
};
