// What a command does when it cannot write its output. Bun reports a failed
// process.stdout.write (or stderr) as an "error" event on the stream; with
// nothing listening that is a stack trace and exit 1, e.g. for
// `incibase logs shop/prod | head` once head has its lines and exits.
//
// A reader that went away (EPIPE) is how a pipeline says it has enough: a
// command people pipe (cli.ts guardsOutput: not serve, nor what systemd runs)
// stops quietly with exit 0, as a Unix filter does on SIGPIPE, and
// takes the children it streams from (logs' journalctl, tunnel's ssh) with
// it. Any other write error (a full disk under `> file`) is a failure: said
// on stderr, exit 1. console.* does not go through these streams (Bun drops
// what it cannot write), so the server's own logging is not affected.

/** A child process the command is streaming for. */
interface Child {
  kill(signal?: NodeJS.Signals | number): void;
}

const children = new Set<Child>();
let guarded = false;

/**
 * Stops `child` too when the command ends because its output cannot be
 * written. Returns the function that forgets it again, for when it ended.
 */
export function stopWithOutput(child: Child): () => void {
  children.add(child);
  return () => void children.delete(child);
}

/** Handles write errors on stdout and stderr for the rest of the process (see above); once. */
export function guardOutput(): void {
  if (guarded) return;
  guarded = true;
  process.stdout.on("error", (err) => outputFailed("stdout", err));
  process.stderr.on("error", (err) => outputFailed("stderr", err));
}

function outputFailed(stream: "stdout" | "stderr", err: NodeJS.ErrnoException): never {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
  if (err.code === "EPIPE") process.exit(0);
  // A stderr that fails cannot say so.
  if (stream === "stdout") {
    try {
      process.stderr.write(`incibase: cannot write to stdout: ${err.message}\n`);
    } catch {
      // Nothing left to tell.
    }
  }
  process.exit(1);
}
