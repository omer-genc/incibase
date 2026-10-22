// No imports: schema.ts and server.ts throw DefinitionError, and they are
// loaded by client bundles too.

/**
 * How `incibase serve` exits, so a supervisor can tell a failure that a
 * restart may fix from one that fails the same way on every start. The
 * numbers follow sysexits.h.
 */
export const ExitCode = {
  OK: 0,
  /** A crash, or an error thrown by the app's own code (e.g. on import). A restart may help. */
  CRASH: 1,
  /** Bad flags or environment, or a database whose system schema is newer than this binary. */
  CONFIG: 64,
  /** The migration was refused; nothing was committed. */
  MIGRATION_REFUSED: 65,
  /** The data dir is locked by another process, or the address is in use. Try again later. */
  TEMPORARY: 75,
  /** The app defines something incibase rejects (schema export, cron target, routes, ...). */
  DEFINITION: 78,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Marks an error with the code to exit with. A symbol from the global
 * registry, not instanceof: a built app can carry its own copy of the
 * framework modules, and no unrelated error has the property by accident.
 */
export const EXIT_CODE = Symbol.for("incibase.exitCode");

const CODES = new Set<number>(Object.values(ExitCode));

/** The app's code or schema is wrong in a way incibase detects; it fails the same way on every start. */
export class DefinitionError extends Error {
  readonly [EXIT_CODE] = ExitCode.DEFINITION;

  constructor(message: string) {
    super(message);
    this.name = "DefinitionError";
  }
}

/** A flag, an environment variable or the data dir does not fit this binary. */
export class ConfigError extends Error {
  readonly [EXIT_CODE]: ExitCode = ExitCode.CONFIG;

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The exit code for an error that stopped the server from starting. */
export function exitCodeOf(err: unknown): ExitCode {
  const code = (err as { [EXIT_CODE]?: unknown } | null)?.[EXIT_CODE];
  if (typeof code === "number" && CODES.has(code)) return code as ExitCode;
  if ((err as { code?: unknown } | null)?.code === "EADDRINUSE") return ExitCode.TEMPORARY;
  return ExitCode.CRASH;
}

/** A few words on what an exit code means, for `dev`'s "server stopped" line. */
export function describeExit(code: number): string {
  switch (code) {
    case ExitCode.CONFIG:
      return "configuration error";
    case ExitCode.MIGRATION_REFUSED:
      return "migration refused";
    case ExitCode.TEMPORARY:
      return "data dir or address in use";
    case ExitCode.DEFINITION:
      return "invalid app definition";
    default:
      return `exit code ${code}`;
  }
}
