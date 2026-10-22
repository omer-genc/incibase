// How serve stops on SIGTERM or SIGINT without dropping work it accepted:
// stop listening, stop claiming jobs, send WebSockets 1012, then wait for the
// calls, jobs and transactions still running, up to `--drain-timeout`. What
// is left at the deadline is cut through the call deadlines (timeouts.ts), so
// a hung mutation rolls back and releases the write lock before the process
// goes. A second signal cuts at once, unless it is the first one delivered
// twice (see REPEAT_SIGNAL_MS).
import type { Engine } from "./engine.ts";
import { ConfigError } from "./exit-codes.ts";
import type { Listeners } from "./listeners.ts";
import { logEvent } from "./log.ts";
import { parseDuration } from "./timeouts.ts";

/** How long serve waits for running work on a stop, unless `--drain-timeout` says otherwise. */
export const DRAIN_TIMEOUT_MS = 10_000;
/** dev's: restarts after a file change stay quick. */
export const DEV_DRAIN_TIMEOUT_MS = 1_000;
/** WebSocket close code for "service restart": clients reconnect, here or elsewhere, later. */
export const SERVICE_RESTART = 1012;
/** After a cut, how long the cut calls get to send their answer (503) before connections are closed. */
const CUT_GRACE_MS = 250;

/**
 * `--drain-timeout`: seconds (`10`, `0.5`, `0` to cut at once) or a duration
 * with a unit (`500ms`, `10s`, `1m`). Without it, 10s, or 1s for dev.
 * ConfigError (exit 64) for anything else.
 */
export function parseDrainTimeout(value: string | undefined, dev = false): number {
  if (value === undefined) return dev ? DEV_DRAIN_TIMEOUT_MS : DRAIN_TIMEOUT_MS;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const ms = Math.round(Number(text) * 1000);
    if (ms <= 2 ** 31 - 1) return ms;
  } else if (/^\d/.test(text)) {
    return parseDuration(text, "drain timeout");
  }
  throw new ConfigError(`Invalid drain timeout "${value}": use seconds (e.g. 10) or a duration with ms, s or m (e.g. 500ms)`);
}

/**
 * A stop signal that comes again sooner than this is the same one delivered
 * twice, not a second request: Ctrl-C signals the terminal's whole process
 * group, and wrappers such as `bun run`, `npm run` and `bunx` pass the signal
 * on to their child as well.
 */
export const REPEAT_SIGNAL_MS = 500;

/**
 * Sorts the stop signals of one process: "stop" for the first, "repeat" for
 * one within `windowMs` of it (ignored), "force" for any later one.
 */
export function stopSignals(windowMs = REPEAT_SIGNAL_MS): () => "stop" | "repeat" | "force" {
  let first: number | undefined;
  return () => {
    const now = performance.now();
    if (first === undefined) {
      first = now;
      return "stop";
    }
    return now - first < windowMs ? "repeat" : "force";
  };
}

export interface DrainOptions {
  /** The signal that started the stop, for the log. */
  signal: string;
  timeoutMs: number;
  /** Resolves when the stop must not wait any longer (a second signal). */
  force?: Promise<unknown>;
}

export interface DrainResult {
  ms: number;
  /** Whether work was still running at the deadline (or the second signal) and was cut. */
  forced: boolean;
}

/**
 * Drains `engine` behind `listeners`, logging `draining` and `drained`. On
 * return nothing runs and nothing listens; the engine is still open, so
 * `engine.stop()` closes the database and releases the data dir after it.
 */
export async function drain(engine: Engine, listeners: Listeners, { signal, timeoutMs, force }: DrainOptions): Promise<DrainResult> {
  const started = performance.now();
  logEvent("info", { ev: "draining", signal, timeoutMs });
  // Not forced: requests already accepted finish and get their answer.
  const closed = listeners.stop();
  engine.scheduler.stop();
  // Open WebSockets would keep the listeners from ever stopping.
  engine.realtime.closeAll(SERVICE_RESTART, "server restarting");
  const done = Promise.all([closed, engine.idle()]).then(() => true);
  let timer: Timer | undefined;
  const cut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    void force?.then(() => resolve(false));
  });
  const finished = await Promise.race([done, cut]);
  clearTimeout(timer);
  let cutCalls: string[] = [];
  if (!finished) {
    cutCalls = engine.runningCalls();
    // As their deadlines would: transactions roll back and locks are released.
    engine.cutCalls();
    await Promise.race([done, Bun.sleep(CUT_GRACE_MS)]);
    await listeners.stop(true);
    // Background writes queued behind a cut call (a job's outcome) still run; a handler that never yields cannot be waited for.
    await Promise.race([engine.idle(), Bun.sleep(CUT_GRACE_MS)]);
  }
  const ms = Math.round(performance.now() - started);
  const text = finished
    ? undefined
    : [`[incibase] stopped waiting after ${ms}ms; cut ${cutCalls.length} running call(s)${cutCalls.length ? `: ${cutCalls.join(", ")}` : ""}`];
  logEvent(finished ? "info" : "warn", { ev: "drained", ms, forced: !finished, ...(finished ? {} : { cut: cutCalls }) }, text);
  return { ms, forced: !finished };
}
