// Cooperative deadlines for function calls (`serve --timeouts`). A handler
// that is still running at its deadline is abandoned: the caller gets
// FUNCTION_TIMEOUT (HTTP 504), its transaction is rolled back and its lock
// released, and whatever the handler tries afterwards through its ctx throws.
// A handler that never yields (a busy loop) cannot be cut off this way.
import { IncibaseError } from "../errors.ts";
import { ConfigError } from "./exit-codes.ts";
import { logEvent } from "./log.ts";

/** What a deadline applies to: a function type, or `http` for httpActions. */
export type TimeoutKind = "query" | "mutation" | "action" | "http";

/** Milliseconds per kind; a kind left out has no deadline. */
export type Timeouts = Partial<Record<TimeoutKind, number>>;

const KINDS: readonly TimeoutKind[] = ["query", "mutation", "action", "http"];
const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000 };
/** setTimeout's limit; a longer delay would fire at once. */
const MAX_MS = 2 ** 31 - 1;

/** `"10s"`, `"500ms"`, `"2m"` (decimals allowed) in milliseconds; ConfigError otherwise. */
export function parseDuration(value: string, what = "duration"): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)$/);
  const ms = match ? Math.round(Number(match[1]) * UNITS[match[2]!]!) : NaN;
  if (!(ms >= 1 && ms <= MAX_MS)) {
    throw new ConfigError(`Invalid ${what} "${value}": use a positive number with ms, s or m (e.g. 500ms, 10s, 2m)`);
  }
  return ms;
}

/**
 * `--timeouts query=10s,mutation=10s,action=120s,http=120s`, falling back to
 * `INCIBASE_TIMEOUTS`. Kinds left out (and an empty value) get no deadline;
 * anything that does not parse is a ConfigError.
 */
export function parseTimeouts(value: string | undefined): Timeouts {
  const spec = (value ?? process.env.INCIBASE_TIMEOUTS ?? "").trim();
  const timeouts: Timeouts = {};
  if (!spec) return timeouts;
  for (const part of spec.split(",")) {
    const [key, duration, ...rest] = part.split("=").map((s) => s.trim());
    if (!key || duration === undefined || rest.length) {
      throw new ConfigError(`Invalid timeouts "${spec}": use kind=duration pairs, e.g. query=10s,mutation=10s,action=120s,http=120s`);
    }
    if (!KINDS.includes(key as TimeoutKind)) {
      throw new ConfigError(`Invalid timeouts: unknown kind "${key}"; use ${KINDS.join(", ")}`);
    }
    timeouts[key as TimeoutKind] = parseDuration(duration, `${key} timeout`);
  }
  return timeouts;
}

/** `10s`, `2m`, `250ms`. */
export function formatMs(ms: number) {
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** A call that ran past its deadline. Sent to clients as FUNCTION_TIMEOUT with status 504. */
export class FunctionTimeoutError extends IncibaseError<{ code: "FUNCTION_TIMEOUT"; message: string }> {
  constructor(kind: TimeoutKind, path: string, ms: number) {
    const what = kind === "http" ? "HTTP action" : kind[0]!.toUpperCase() + kind.slice(1);
    super({ code: "FUNCTION_TIMEOUT", message: `${what} ${path} timed out after ${formatMs(ms)}` });
    this.name = "FunctionTimeoutError";
  }
}

/** One call's deadline. It starts when `race` is called, not when it is created. */
export class Deadline {
  private error: FunctionTimeoutError | null = null;

  constructor(
    readonly kind: TimeoutKind,
    readonly path: string,
    readonly ms: number,
    /** Called once when the deadline passes, after `onExpire` (e.g. to log it). */
    private readonly onTimeout?: (deadline: Deadline) => void,
  ) {}

  get expired() {
    return this.error !== null;
  }

  /** Throws once the deadline passed; guards what an abandoned handler calls later. */
  check() {
    if (this.error) throw this.error;
  }

  /**
   * Settles as `work` does, or rejects with FunctionTimeoutError `ms` from
   * now. `onExpire` runs inside the timer callback, before any other code
   * (the abandoned handler included) runs again, so it can close a session
   * and roll back before the handler gets another chance to write. Once
   * `work` has settled the timer is cleared, so a result that came first is
   * never undone.
   */
  race<T>(work: () => Promise<T> | T, onExpire?: (err: FunctionTimeoutError) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = (this.error = new FunctionTimeoutError(this.kind, this.path, this.ms));
        try {
          onExpire?.(err);
        } catch (cleanupErr) {
          logEvent("error", { ev: "timeout_cleanup_error", path: this.path, err: cleanupErr }, ["[incibase] cleanup after a timeout failed:", cleanupErr]);
        }
        this.onTimeout?.(this);
        reject(err);
      }, this.ms);
      let pending: Promise<T>;
      try {
        pending = Promise.resolve(work());
      } catch (err) {
        pending = Promise.reject(err);
      }
      // Also handles a rejection that comes after the deadline, so it is not reported as unhandled.
      pending.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

/** `work()` under `deadline`, or just `work()`, called as before, when there is none. */
export function raceDeadline<T>(
  deadline: Deadline | undefined,
  work: () => Promise<T> | T,
  onExpire?: (err: FunctionTimeoutError) => void,
): Promise<T> | T {
  return deadline ? deadline.race(work, onExpire) : work();
}

/**
 * `ctx` with every method (and every method of its object members) checking
 * `deadline` first, so an abandoned action cannot start new work. Without a
 * deadline `ctx` is returned as it is.
 */
export function guardCtx<T extends object>(ctx: T, deadline: Deadline | undefined): T {
  if (!deadline) return ctx;
  const guard = (value: unknown): unknown => {
    if (typeof value === "function") {
      return (...args: unknown[]) => {
        deadline.check();
        return value(...args);
      };
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    out[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, guard(v)]))
        : guard(value);
  }
  return out as T;
}
