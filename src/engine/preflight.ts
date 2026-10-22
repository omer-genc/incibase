// `serve --migrate-only`: a host's preflight. It starts exactly as serve does
// (flags, bundle or dir, data dir lock, hosted-mode checks), runs the
// migration on a copy of the database, and exits without listening. Failures
// exit with their code (exit-codes.ts) before this runs, as serve's do.
import type { Engine } from "./engine.ts";
import { color, logEvent } from "./log.ts";

/** Logs the migration report, releases the data dir and exits 0 (1 when the engine could not stop cleanly). */
export async function finishMigrateOnly(engine: Engine): Promise<never> {
  const m = engine.migration;
  const changed =
    [m.createdTables, m.addedIndexes, m.droppedIndexes, m.deactivatedTables, m.removedFields].some((l) => l.length) || m.rewrittenDocuments > 0;
  let code = 0;
  try {
    await engine.stop();
  } catch (err) {
    logEvent("error", { ev: "shutdown_failed", err }, ["[incibase] shutdown failed:", err]);
    code = 1;
  }
  const msg = changed ? "migrated; not serving (--migrate-only)" : "schema up to date; not serving (--migrate-only)";
  logEvent("info", { ev: "migrate_only", msg, changed, ...m }, [color.green(msg)]);
  process.exit(code);
}
