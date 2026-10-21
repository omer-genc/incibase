/**
 * Error type meant to reach the client. Throw it from a function handler and
 * `data` is sent to the caller as-is; any other error is reported as an
 * internal error (with its message only in dev mode).
 */
export class IncibaseError<T = unknown> extends Error {
  readonly data: T;
  readonly __incibaseError = true;

  constructor(data: T) {
    super(typeof data === "string" ? data : JSON.stringify(data));
    this.name = "IncibaseError";
    this.data = data;
  }
}

export function isIncibaseError(err: unknown): err is IncibaseError {
  return typeof err === "object" && err !== null && (err as { __incibaseError?: unknown }).__incibaseError === true;
}
