// A branch's limits (limits_json) and settings (config_json): what its unit
// and env file are rendered from. Both are checked with Zod when the owner
// sets them and again when they are read, so a hand-edited registry cannot
// smuggle a value into a unit file.
import { z } from "zod";

export const MiB = 1024 * 1024;
/** Below this a branch cannot hash one password (about 64 MiB) next to the runtime. */
export const MIN_MEMORY = 128 * MiB;
const MAX_MEMORY = 1024 * 1024 * MiB;
/** What the password hasher holds per sign-in (design section 2, "Limitler"). */
const AUTH_HASH_BYTES = 64 * MiB;
const RUNTIME_BYTES = 128 * MiB;

const bytes = (min: number) => z.number().int().min(min).max(Number.MAX_SAFE_INTEGER);

export const limitsSchema = z.strictObject({
  /** MemoryMax; MemoryHigh is 90 % of it unless set. */
  memoryMax: bytes(MIN_MEMORY).max(MAX_MEMORY),
  memoryHigh: bytes(MIN_MEMORY / 2).max(MAX_MEMORY).optional(),
  /** CPUQuota in percent of one CPU (100 = one core). */
  cpuQuota: z.number().int().min(1).max(100_000).optional(),
  tasksMax: z.number().int().min(16).max(65_536).optional(),
  maxDbBytes: bytes(1).optional(),
  maxStorageBytes: bytes(1).optional(),
  maxUploadBytes: bytes(1).optional(),
});
export type BranchLimits = z.infer<typeof limitsSchema>;

const duration = z.number().int().min(1).max(2 ** 31 - 1);

export const configSchema = z.strictObject({
  /** Per call type deadlines in ms (`serve --timeouts`). */
  timeouts: z
    .strictObject({ query: duration.optional(), mutation: duration.optional(), action: duration.optional(), http: duration.optional() })
    .optional(),
  /** `serve --drain-timeout`, ms. */
  drainMs: z.number().int().min(0).max(600_000).optional(),
  /** Run a preflight before each release goes live; on by default for prod, off for the others. */
  preflight: z.boolean().optional(),
});
export type BranchConfig = z.infer<typeof configSchema>;

export const DEFAULT_TIMEOUTS = { query: 10_000, mutation: 10_000, action: 120_000, http: 120_000 } as const;
export const DEFAULT_DRAIN_MS = 10_000;
export const DEFAULT_CPU_QUOTA = 100;
export const DEFAULT_TASKS_MAX = 256;
/** systemd waits this long after the drain before SIGKILL (TimeoutStopSec = drain + 15 s). */
const STOP_GRACE_MS = 15_000;

export function parseLimits(json: string): BranchLimits {
  return limitsSchema.parse(JSON.parse(json));
}

export function parseConfig(json: string): BranchConfig {
  return configSchema.parse(JSON.parse(json));
}

/** What a unit gets: every default filled in. */
export interface ResolvedLimits {
  memoryMax: number;
  memoryHigh: number;
  cpuQuota: number;
  tasksMax: number;
  maxDbBytes?: number;
  maxStorageBytes?: number;
  maxUploadBytes?: number;
}

export function resolveLimits(limits: BranchLimits): ResolvedLimits {
  const memoryHigh = limits.memoryHigh ?? Math.floor((limits.memoryMax * 0.9) / MiB) * MiB;
  if (memoryHigh > limits.memoryMax) throw new Error(`memoryHigh (${memoryHigh}) must not be above memoryMax (${limits.memoryMax})`);
  return {
    ...limits,
    memoryHigh,
    cpuQuota: limits.cpuQuota ?? DEFAULT_CPU_QUOTA,
    tasksMax: limits.tasksMax ?? DEFAULT_TASKS_MAX,
  };
}

/** INCIBASE_AUTH_CONCURRENCY = ⌊(MemoryMax − 128M) / 64M⌋, from 1 to 4. */
export function authConcurrency(memoryMax: number): number {
  return Math.min(4, Math.max(1, Math.floor((memoryMax - RUNTIME_BYTES) / AUTH_HASH_BYTES)));
}

/** `--timeouts query=10s,mutation=10s,action=120s,http=120s`. */
export function timeoutsFlag(config: BranchConfig): string {
  const t = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  return (["query", "mutation", "action", "http"] as const).map((k) => `${k}=${durationText(t[k])}`).join(",");
}

/** `10s`, `120s`, `1500ms`: what serve's duration flags read. */
export function durationText(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

export function drainMs(config: BranchConfig): number {
  return config.drainMs ?? DEFAULT_DRAIN_MS;
}

/** TimeoutStopSec in whole seconds: the drain plus the grace systemd gives before SIGKILL. */
export function stopTimeoutSec(config: BranchConfig): number {
  return Math.ceil((drainMs(config) + STOP_GRACE_MS) / 1000);
}

/** A byte size the way systemd reads it: `512M` when it is whole MiB, bytes otherwise. */
export function systemdSize(n: number): string {
  if (n % (1024 * MiB) === 0) return `${n / (1024 * MiB)}G`;
  if (n % MiB === 0) return `${n / MiB}M`;
  if (n % 1024 === 0) return `${n / 1024}K`;
  return String(n);
}

/** `512M`, `1.5G`, `256MiB`, `1073741824` → bytes; for the CLI and tests. */
export function parseSize(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i.exec(text.trim());
  if (!match) throw new Error(`Invalid size ${JSON.stringify(text)}: use e.g. 512M or 2G`);
  const unit = { "": 1, K: 1024, M: MiB, G: 1024 * MiB, T: 1024 * 1024 * MiB }[match[2]!.toUpperCase() as "" | "K" | "M" | "G" | "T"];
  return Math.round(Number(match[1]) * unit);
}
