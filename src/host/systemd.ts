// The Driver on a real machine: systemctl, systemd-run and journalctl, each
// from an argument array (never a shell), with every unit name checked first.
import { SystemCommandError } from "./system.ts";
import { KILL_SIGNALS, type Driver, type JournalEntry, type JournalQuery, type KillSignal, type TransientJob, type UnitStatus } from "./driver.ts";

/** Unit names this layer passes to systemctl: a prefix, an optional `@instance`, a known suffix. */
const UNIT_NAME = /^[a-z][a-z0-9-]{0,80}(?:@[a-z0-9]{1,32})?\.(?:service|slice|timer)$/;
/** What may reach systemd-run's command line: systemd itself expands `$VAR` and `%` specifiers there. */
const SAFE_ARG = /^[A-Za-z0-9_./:=@,+-]+$/;
/** journalctl --since values: what `incibase logs --since` passes on (`1h`, `2026-10-22 10:00`, `today`). */
const SINCE = /^[A-Za-z0-9 :.+-]{1,40}$/;

export function checkUnitName(unit: string): string {
  if (!UNIT_NAME.test(unit)) throw new Error(`Invalid unit name ${JSON.stringify(unit)}`);
  return unit;
}

const ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C", SYSTEMD_COLORS: "0", SYSTEMD_PAGER: "" };

/** `systemctl show` output as a status; missing or unset numbers are 0 (memory: null). */
export function parseShow(text: string): UnitStatus {
  const props = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const int = (key: string) => {
    const n = Number(props.get(key));
    return Number.isSafeInteger(n) ? n : 0;
  };
  const memory = Number(props.get("MemoryCurrent"));
  return {
    loadState: props.get("LoadState") ?? "",
    activeState: props.get("ActiveState") ?? "",
    subState: props.get("SubState") ?? "",
    result: props.get("Result") ?? "",
    mainPid: int("MainPID"),
    execMainCode: int("ExecMainCode"),
    execMainStatus: int("ExecMainStatus"),
    nRestarts: int("NRestarts"),
    // systemd prints [not set], or 2^64-1 when accounting is off.
    memoryCurrent: Number.isSafeInteger(memory) ? memory : null,
    invocationId: props.get("InvocationID") ?? "",
  };
}

/** journalctl -o json lines; MESSAGE is a string, or an array of bytes when it was not UTF-8. */
export function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const raw = json.MESSAGE;
    const message = typeof raw === "string" ? raw : Array.isArray(raw) ? Buffer.from(raw.filter((b) => typeof b === "number")).toString("utf8") : "";
    entries.push({
      cursor: String(json.__CURSOR ?? ""),
      message,
      ...(typeof json._SYSTEMD_INVOCATION_ID === "string" ? { invocationId: json._SYSTEMD_INVOCATION_ID } : {}),
      time: Number(json.__REALTIME_TIMESTAMP ?? 0),
    });
  }
  return entries;
}

export class SystemdDriver implements Driver {
  private run(command: string[], okCodes: number[] = [0]): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: ENV });
    const exitCode = result.exitCode ?? -1;
    const stderr = result.stderr.toString();
    if (!okCodes.includes(exitCode)) throw new SystemCommandError(command, result.exitCode, stderr);
    return { exitCode, stdout: result.stdout.toString(), stderr };
  }

  /**
   * A unit that is not loaded has nothing to stop or reset: `stop` exits 5
   * then, `reset-failed` 1 (systemd 255), both saying "not loaded".
   */
  private systemctl(verb: string, unit: string, tolerateNotLoaded = false) {
    const command = ["systemctl", verb, "--", checkUnitName(unit)];
    const { exitCode, stderr } = this.run(command, tolerateNotLoaded ? [0, 1, 5] : [0]);
    if (exitCode !== 0 && !/not loaded|not found/i.test(stderr)) throw new SystemCommandError(command, exitCode, stderr);
  }

  daemonReload() {
    this.run(["systemctl", "daemon-reload"]);
  }

  start(unit: string) {
    this.systemctl("start", unit);
  }

  stop(unit: string) {
    this.systemctl("stop", unit, true);
  }

  restart(unit: string) {
    this.systemctl("restart", unit);
  }

  reload(unit: string) {
    this.systemctl("reload", unit);
  }

  resetFailed(unit: string) {
    this.systemctl("reset-failed", unit, true);
  }

  killMain(unit: string, signal: KillSignal) {
    if (!KILL_SIGNALS.includes(signal)) throw new Error(`Invalid signal ${JSON.stringify(signal)}`);
    this.run(["systemctl", "kill", "--kill-whom=main", `--signal=${signal}`, "--", checkUnitName(unit)]);
  }

  show(unit: string): UnitStatus {
    const props = "LoadState,ActiveState,SubState,Result,MainPID,ExecMainCode,ExecMainStatus,NRestarts,MemoryCurrent,InvocationID";
    const { stdout } = this.run(["systemctl", "show", "--property", props, "--", checkUnitName(unit)]);
    return parseShow(stdout);
  }

  isActive(unit: string): boolean {
    // is-active exits 0 when active (or reloading), 3 otherwise; 4 when there is no such unit.
    const { exitCode } = this.run(["systemctl", "is-active", "--quiet", "--", checkUnitName(unit)], [0, 3, 4]);
    return exitCode === 0;
  }

  runTransient(job: TransientJob) {
    if (!job.argv.length) throw new Error("A transient job needs a command");
    for (const arg of job.argv) if (!SAFE_ARG.test(arg)) throw new Error(`Refusing to pass ${JSON.stringify(arg)} to systemd-run`);
    if (!/^[A-Za-z0-9 _./:=@,+#-]{1,200}$/.test(job.description)) throw new Error(`Invalid job description ${JSON.stringify(job.description)}`);
    this.run([
      "systemd-run",
      `--unit=${checkUnitName(job.unit)}`,
      "--collect",
      "--quiet",
      "--service-type=exec",
      `--description=${job.description}`,
      "--setenv=NO_COLOR=1",
      "--",
      ...job.argv,
    ]);
  }

  journal(query: JournalQuery): JournalEntry[] {
    // --all: without it, -o json prints fields longer than 4096 bytes (a long log line) as null.
    const args = ["journalctl", "--unit", checkUnitName(query.unit), "--output", "json", "--all", "--no-pager", "--quiet"];
    if (query.afterCursor !== undefined) args.push("--after-cursor", checkCursor(query.afterCursor));
    if (query.grep !== undefined) args.push("--grep", query.grep);
    if (query.lines !== undefined) args.push("--lines", String(Math.max(1, Math.trunc(query.lines))));
    // journalctl exits 1 when --grep matches nothing.
    const { stdout } = this.run(args, query.grep !== undefined ? [0, 1] : [0]);
    return parseJournal(stdout);
  }

  journalCursor(): string | null {
    const { stdout } = this.run(["journalctl", "--lines", "0", "--show-cursor", "--no-pager"]);
    const match = /^-- cursor: (\S+)$/m.exec(stdout);
    return match ? match[1]! : null;
  }

  syncJournal() {
    // journalctl --sync returns once journald has flushed everything written so far.
    this.run(["journalctl", "--sync"], [0, 1]);
  }

  journalCommand(query: { unit: string; follow?: boolean; lines?: number; since?: string; json?: boolean; grep?: string }): string[] {
    const args = ["journalctl", "--unit", checkUnitName(query.unit), "--output", query.json ? "json" : "cat", "--no-pager"];
    if (query.lines !== undefined) args.push("--lines", String(Math.max(1, Math.trunc(query.lines))));
    if (query.since !== undefined) {
      if (!SINCE.test(query.since)) throw new Error(`Invalid --since ${JSON.stringify(query.since)}`);
      args.push("--since", query.since);
    }
    if (query.grep !== undefined) args.push("--grep", query.grep);
    if (query.follow) args.push("--follow");
    return args;
  }
}

/** journald cursors are `s=…;i=…;b=…;m=…;t=…;x=…`. */
function checkCursor(cursor: string): string {
  if (!/^[A-Za-z0-9=;]{1,512}$/.test(cursor)) throw new Error(`Invalid journal cursor ${JSON.stringify(cursor)}`);
  return cursor;
}
