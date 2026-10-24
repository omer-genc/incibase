// `incibase tunnel <project>/<branch> --ssh <user@host>`, on the owner's
// laptop (design section 3.2 C): reads admin/index.json on the server over
// SSH for the branch's admin socket and its laptop port, forwards
// 127.0.0.1:<port> to that socket with `ssh -N -L`, waits until the branch
// answers /api/health through it and prints the dashboard URL and the MCP
// command. Ctrl-C closes the tunnel. The admin key never passes through
// here: the owner fetches it with `ssh <host> sudo incibase admin-key …`.
//
// Needs no root, and runs on macOS and Linux. Every value that reaches the
// ssh command line is checked first; ssh gets an argument array.
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { stopWithOutput } from "../engine/output.ts";
import { printable } from "./driver.ts";
import { DEFAULT_ROOT } from "./layout.ts";
import { branchRef, NameError, parseBranchRef } from "./names.ts";

export const TUNNEL_USAGE = `Usage (on your laptop): incibase tunnel <project>/<branch> --ssh <user@host> [flags]

Opens the branch's dashboard and MCP over SSH: forwards 127.0.0.1:<port> to its admin socket.
Your account on the server must be an admin: sudo incibase host add-admin <you>.

Flags:
  --ssh <user@host>             Where the server is, as ssh takes it (a ~/.ssh/config alias works) (required)
  --open                        Open the dashboard in the browser
  --local-port <n>              The laptop port (default the branch's own, so its dashboard keeps its origin)
  --root <dir>                  The server's host root (default ${DEFAULT_ROOT})
  --ssh-config <file>           An ssh config file to use instead of ~/.ssh/config (ssh -F)
  --timeout <s>                 How long to wait for the branch to answer (default 30)
  --json                        Print one JSON line once the tunnel is up
  -h, --help                    This help

The admin key: ssh <host> sudo incibase admin-key <project>/<branch>`;

/** What ssh may be given as a destination: user@host or a config alias; never something it reads as an option. */
const DESTINATION = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,254}$/;
const ROOT = /^\/[A-Za-z0-9._/-]{1,4000}$/;
const SOCKET = /^[a-z0-9][a-z0-9-]{0,62}\.sock$/;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

class TunnelError extends Error {
  constructor(
    message: string,
    readonly usage = false,
  ) {
    super(message);
    this.name = "TunnelError";
  }
}

export interface IndexEntry {
  label: string;
  socket: string;
  port: number;
}

/** The branch's entry of admin/index.json, checked: it names a path and a port on this machine. */
export function indexEntry(text: string, ref: string): IndexEntry {
  let index: unknown;
  try {
    index = JSON.parse(text);
  } catch {
    throw new TunnelError("admin/index.json on the server is not JSON");
  }
  const entry = (index && typeof index === "object" ? (index as Record<string, unknown>)[ref] : undefined) as Partial<IndexEntry> | undefined;
  if (!entry || typeof entry !== "object") throw new TunnelError(`No ready branch ${ref} on the server (see sudo incibase branch list there)`);
  if (typeof entry.socket !== "string" || !SOCKET.test(entry.socket)) throw new TunnelError(`admin/index.json gives ${ref} an invalid socket name`);
  if (!Number.isInteger(entry.port) || entry.port! < 1 || entry.port! > 65535) throw new TunnelError(`admin/index.json gives ${ref} an invalid port`);
  return { label: String(entry.label ?? entry.socket.slice(0, -5)), socket: entry.socket, port: entry.port! };
}

/** Whether something already listens on 127.0.0.1:port. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/** The last line ssh wrote, for an error message. */
const lastLine = (text: string) => printable(text.trim().split("\n").at(-1) ?? "", 300);

export async function tunnelCli(argv: string[]): Promise<number> {
  let ssh: ReturnType<typeof Bun.spawn> | null = null;
  const json = argv.includes("--json");
  const fail = (err: unknown) => {
    const message = (err as Error)?.message ?? String(err);
    const usage = (err instanceof TunnelError && err.usage) || err instanceof NameError || (err instanceof TypeError && String((err as { code?: string }).code).startsWith("ERR_PARSE_ARGS"));
    if (json) process.stderr.write(`${JSON.stringify({ error: { code: usage ? "USAGE" : "FAILED", message } })}\n`);
    else process.stderr.write(`incibase tunnel: ${message}\n${usage ? "Usage: incibase tunnel <project>/<branch> --ssh <user@host> [--open] [--local-port <n>] (see --help)\n" : ""}`);
    return usage ? 2 : 1;
  };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        ssh: { type: "string" },
        open: { type: "boolean", default: false },
        "local-port": { type: "string" },
        root: { type: "string" },
        "ssh-config": { type: "string" },
        timeout: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) {
      process.stdout.write(`${TUNNEL_USAGE}\n`);
      return 0;
    }
    if (positionals.length !== 1) throw new TunnelError("tunnel takes one <project>/<branch>", true);
    const { project, branch } = parseBranchRef(positionals[0]!);
    const ref = branchRef(project, branch);
    const dest = values.ssh;
    if (!dest) throw new TunnelError("--ssh <user@host> is required", true);
    if (!DESTINATION.test(dest)) throw new TunnelError(`--ssh takes user@host or an ssh config alias, got ${JSON.stringify(dest)}`, true);
    const root = values.root ?? DEFAULT_ROOT;
    if (!ROOT.test(root) || root.split("/").includes("..")) throw new TunnelError(`--root takes an absolute path, got ${JSON.stringify(root)}`, true);
    const number = (name: string, text: string | undefined, min: number, max: number) => {
      if (text === undefined) return undefined;
      if (!/^\d{1,6}$/.test(text) || Number(text) < min || Number(text) > max) throw new TunnelError(`--${name} takes a number from ${min} to ${max}`, true);
      return Number(text);
    };
    const configFile = values["ssh-config"] === undefined ? undefined : resolve(values["ssh-config"]);
    if (configFile !== undefined && (!existsSync(configFile) || /[\s"'$`\\]/.test(configFile))) {
      throw new TunnelError(`--ssh-config takes an existing file without spaces or quotes, got ${JSON.stringify(values["ssh-config"])}`, true);
    }
    const sshBase = configFile === undefined ? ["ssh"] : ["ssh", "-F", configFile];
    // Never through a ControlMaster from the user's config: as a mux client, `ssh -N -L`
    // hands the forward to a master that outlives it (ControlPersist), exits at once,
    // and Ctrl-C here could not close the port. Each call is its own connection.
    const sshArgs = [...sshBase, "-o", "ControlMaster=no", "-o", "ControlPath=none"];
    const localPort = number("local-port", values["local-port"], 1024, 65535);
    const timeoutMs = (number("timeout", values.timeout, 1, 600) ?? 30) * 1000;

    // 1. Where the branch's socket is, from the server.
    const indexPath = `${root}/admin/index.json`;
    const read = Bun.spawn([...sshArgs, "-o", "ConnectTimeout=15", "--", dest, "cat", indexPath], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
    const [out, errText, code] = await Promise.all([new Response(read.stdout).text(), new Response(read.stderr).text(), read.exited]);
    if (code !== 0) {
      const denied = /permission denied/i.test(errText) && !/publickey|password/i.test(errText);
      throw new TunnelError(
        `Could not read ${indexPath} on ${dest} (ssh exited ${code}): ${lastLine(errText) || "no output"}` +
          (denied ? `. Make your account an admin there: sudo incibase host add-admin <you>, then log in again` : ""),
      );
    }
    if (out.length > MAX_INDEX_BYTES) throw new TunnelError(`${indexPath} is too large`);
    const entry = indexEntry(out, ref);
    const port = localPort ?? entry.port;
    const socket = `${root}/admin/${entry.socket}`;
    if (await portInUse(port)) throw new TunnelError(`127.0.0.1:${port} is in use (another tunnel?); close it or pass --local-port`);

    // 2. The tunnel.
    ssh = Bun.spawn([...sshArgs, "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-L", `127.0.0.1:${port}:${socket}`, "--", dest], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const child = ssh;
    // `incibase tunnel … | head -1`: the tunnel closes when this process stops for its reader (output.ts).
    stopWithOutput(child);
    let exited: number | null = null;
    void child.exited.then((c) => (exited = c));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);

    // 3. Until the branch answers through it.
    const deadline = performance.now() + timeoutMs;
    while (!(await healthy(port))) {
      if (stopping) {
        await child.exited;
        return 130;
      }
      if (exited !== null) throw new TunnelError(`ssh exited ${exited} before the tunnel was up (is AllowStreamLocalForwarding on in sshd, and the branch running?)`);
      if (performance.now() > deadline) {
        stop();
        await child.exited;
        throw new TunnelError(`${ref} did not answer /api/health through the tunnel in ${timeoutMs / 1000} s; is it running? (sudo incibase status on the server)`);
      }
      await Bun.sleep(200);
    }

    const base = `http://127.0.0.1:${port}`;
    const keyCommand = `${sshBase.join(" ")} ${dest} sudo incibase admin-key ${ref}${root === DEFAULT_ROOT ? "" : ` --root ${root}`}`;
    const mcp = `claude mcp add --transport http incibase-${entry.label} ${base}/mcp --header "Authorization: Bearer $(${keyCommand})"`;
    if (json) process.stdout.write(`${JSON.stringify({ branch: ref, port, socket, dashboard: `${base}/_/`, mcp: `${base}/mcp`, mcpCommand: mcp, adminKeyCommand: keyCommand })}\n`);
    else {
      process.stdout.write(
        [
          `${ref} is reachable at ${base}`,
          `  Dashboard  ${base}/_/`,
          `  MCP        ${mcp}`,
          `  Admin key  ${keyCommand}`,
          `Ctrl-C closes the tunnel.`,
          "",
        ].join("\n"),
      );
    }
    if (values.open) {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      try {
        Bun.spawn([opener, `${base}/_/`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
      } catch {
        process.stderr.write(`Could not run ${opener}; open ${base}/_/ yourself\n`);
      }
    }

    const codeAtEnd = await child.exited;
    if (stopping) {
      if (!json) process.stdout.write("Tunnel closed.\n");
      return 0;
    }
    throw new TunnelError(`The tunnel closed: ssh exited ${codeAtEnd}`);
  } catch (err) {
    if (ssh && ssh.exitCode === null) {
      ssh.kill("SIGTERM");
      await ssh.exited;
    }
    return fail(err);
  }
}
