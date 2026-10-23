// What the host layer asks of the service manager: start, stop and inspect
// units, run a transient job and read the journal. src/host/systemd.ts does
// it with systemctl, systemd-run and journalctl; tests on macOS use
// FakeDriver (src/host/fake-driver.ts), which plays the units' part.

/** A unit as `systemctl show` reports it. */
export interface UnitStatus {
  /** loaded, not-found, ... (a finished transient unit with --collect is not-found). */
  loadState: string;
  /** active, inactive, failed, activating, deactivating, reloading. */
  activeState: string;
  subState: string;
  /** success, exit-code, signal, oom-kill, timeout, start-limit-hit, core-dump, ... */
  result: string;
  mainPid: number;
  /** How the main process ended: 1 exited (status is its exit code), 2 killed, 3 dumped (status is the signal). */
  execMainCode: number;
  execMainStatus: number;
  nRestarts: number;
  /** Bytes, when the unit runs and memory accounting is on. */
  memoryCurrent: number | null;
  invocationId: string;
}

/** The signals the host sends a unit's main process. */
export type KillSignal = "SIGKILL" | "SIGTERM";
export const KILL_SIGNALS: readonly KillSignal[] = ["SIGKILL", "SIGTERM"];

export const CLD_EXITED = 1;
export const CLD_KILLED = 2;
export const CLD_DUMPED = 3;

/** One journal entry; `message` is whatever the process wrote, so callers treat it as untrusted text. */
export interface JournalEntry {
  cursor: string;
  message: string;
  /** _SYSTEMD_INVOCATION_ID: set on the lines a unit's processes wrote, missing on systemd's own. */
  invocationId?: string;
  /** Microseconds since the epoch. */
  time: number;
}

export interface JournalQuery {
  unit: string;
  /** Only entries after this cursor. */
  afterCursor?: string;
  /** Only messages matching this (journalctl --grep, a regular expression). */
  grep?: string;
  /** At most this many, the newest. */
  lines?: number;
}

export interface TransientJob {
  /** The unit name, e.g. `incibase-release-<id>-<seq>.service`. */
  unit: string;
  /** The command, run as root; safe characters only (systemd expands `$` and `%`). */
  argv: string[];
  description: string;
}

export interface Driver {
  /** `systemctl daemon-reload`: after unit files changed. */
  daemonReload(): void;
  start(unit: string): void;
  stop(unit: string): void;
  restart(unit: string): void;
  /** `systemctl reload`: ExecReload, SIGHUP for a branch. */
  reload(unit: string): void;
  /** Forgets a failed state and the start limit, so the next start is not refused. */
  resetFailed(unit: string): void;
  /** `systemctl kill --kill-whom=main`: signals only the unit's main process; with SIGKILL, Restart= starts it again. */
  killMain(unit: string, signal: KillSignal): void;
  show(unit: string): UnitStatus;
  isActive(unit: string): boolean;
  /** `systemd-run --unit=<unit> --collect`: runs on when the caller (an SSH session) goes away. */
  runTransient(job: TransientJob): void;
  journal(query: JournalQuery): JournalEntry[];
  /** The cursor of the newest journal entry, of the whole journal: later entries come after it. */
  journalCursor(): string | null;
  /** Flushes journald so a just-stopped process's lines are readable (`journalctl --sync`). */
  syncJournal(): void;
  /** The journalctl command for `incibase logs`, for the caller to run with its own terminal. */
  journalCommand(query: { unit: string; follow?: boolean; lines?: number; since?: string; json?: boolean }): string[];
}

/** Whether a unit has stopped running (or never ran), as far as `show` tells. */
export function settled(status: UnitStatus): boolean {
  return status.loadState === "not-found" || status.activeState === "inactive" || status.activeState === "failed";
}

/** Text from a process, safe to print on root's terminal: no control characters except tabs. */
export function printable(text: string, max = 2000): string {
  const clean = text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, (c) => (c === "\n" ? " " : "?"));
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}
