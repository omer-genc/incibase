// Where serve listens: TCP as in 0.2.0, or unix sockets behind a front proxy
// (--socket) and an SSH tunnel (--admin-socket). With --admin-socket the
// surfaces split: the public listener has no admin power, the admin one has
// the dashboard and the admin tools (see surface.ts).
import type { Server } from "bun";
import { chmodSync, lstatSync, unlinkSync, type Stats } from "node:fs";
import { connect } from "node:net";
import type { Engine } from "./engine.ts";
import { ConfigError, EXIT_CODE, ExitCode } from "./exit-codes.ts";
import { startServer } from "./http.ts";
import type { SocketData } from "./realtime.ts";

/** Who may connect: the socket's owner and group (the front proxy, or the admins). */
const SOCKET_MODE = 0o770;

/** Something else listens on a socket path. It may stop, so exit 75 (a restart may fix it). */
export class SocketInUseError extends ConfigError {
  override readonly [EXIT_CODE] = ExitCode.TEMPORARY;

  constructor(message: string) {
    super(message);
    this.name = "SocketInUseError";
  }
}

export interface ListenOptions {
  port: number;
  hostname: string;
  dashboard?: boolean;
  /** Serve the public surface (the combined one without `adminSocket`) on this unix socket instead of TCP. */
  socket?: string;
  /** Serve the admin surface on this unix socket, and split the surfaces (hosted mode). */
  adminSocket?: string;
}

export interface Listeners {
  /** The public listener (combined without an admin socket). */
  readonly public: Server<SocketData>;
  readonly admin: Server<SocketData> | null;
  /** The public listener's URL, `unix://<path>` on a socket. */
  readonly url: URL;
  /** Where the public listener is, for the log: its socket path or its origin. */
  readonly listen: string;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

/** Flags that do not go together; ConfigError (exit 64). */
export function checkListenFlags(flags: { socket?: string; adminSocket?: string; port?: string; host?: string; url?: string }) {
  if (flags.socket === "") throw new ConfigError("--socket needs a path");
  if (flags.adminSocket === "") throw new ConfigError("--admin-socket needs a path");
  if (flags.socket !== undefined && (flags.port !== undefined || flags.host !== undefined)) {
    throw new ConfigError("--socket takes the place of --port and --host; pass one or the other");
  }
  if (flags.socket !== undefined && !flags.url) {
    throw new ConfigError("--socket needs --url (or INCIBASE_URL), the public URL clients reach the server at");
  }
  if (flags.socket !== undefined && flags.socket === flags.adminSocket) {
    throw new ConfigError("--socket and --admin-socket must be different paths");
  }
}

function kindOf(stat: Stats): string {
  if (stat.isSymbolicLink()) return "a symbolic link";
  if (stat.isDirectory()) return "a directory";
  if (stat.isFile()) return "a file";
  return "not a socket";
}

/** Whether a process accepts connections on the socket at `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = connect(path);
    const done = (live: boolean) => {
      clearTimeout(timer);
      conn.destroy();
      resolve(live);
    };
    // A listener too busy to accept within this is still a listener.
    const timer = setTimeout(() => done(true), 2000);
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
  });
}

/**
 * Removes the socket a killed server left at `path`, so a new one can bind
 * it. Only call it while holding the data dir's LOCK: that proves the server
 * that made the socket is gone. Never removes anything that is not a socket
 * (a symlink is not followed), nor a socket a process still listens on.
 */
export async function clearStaleSocket(path: string) {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return;
    throw new ConfigError(`Cannot listen on ${path}: ${(err as Error).message}`);
  }
  if (!stat.isSocket()) {
    throw new ConfigError(`Cannot listen on ${path}: it is ${kindOf(stat)}, and only a stale socket is removed. Move it away, or pick another path`);
  }
  if (await answers(path)) throw new SocketInUseError(`Cannot listen on ${path}: another process is listening on it`);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw new ConfigError(`Cannot remove the stale socket ${path}: ${(err as Error).message}`);
  }
}

/** Unix listen failures no restart fixes, and how to say them. */
const PERMANENT_SOCKET_ERRORS: Record<string, string> = {
  EACCES: "permission denied",
  EPERM: "permission denied",
  ENOENT: "its directory does not exist",
  ENOTDIR: "a part of the path is not a directory",
  ENAMETOOLONG: "the path is too long for a unix socket (at most 103 bytes on macOS, 107 on Linux)",
  EROFS: "the file system is read-only",
  EINVAL: "the path cannot be a unix socket",
};

function socketListenError(err: unknown, path: string): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return new SocketInUseError(`Cannot listen on ${path}: the address is in use`);
  if (typeof code === "string" && PERMANENT_SOCKET_ERRORS[code]) return new ConfigError(`Cannot listen on ${path}: ${PERMANENT_SOCKET_ERRORS[code]}`);
  return err;
}

/** Binds a unix socket for `start` and gives it mode 0770 (Bun creates it from the umask, e.g. 0755). */
async function onSocket(path: string, start: () => Server<SocketData>): Promise<Server<SocketData>> {
  await clearStaleSocket(path);
  let server: Server<SocketData>;
  try {
    server = start();
  } catch (err) {
    throw socketListenError(err, path);
  }
  try {
    chmodSync(path, SOCKET_MODE);
  } catch (err) {
    server.stop(true);
    throw new ConfigError(`Cannot set the mode of ${path} to ${SOCKET_MODE.toString(8)}: ${(err as Error).message}`);
  }
  return server;
}

/**
 * Starts the listeners `options` asks for: one combined TCP listener as in
 * 0.2.0, the public one on a unix socket, and with `adminSocket` the admin
 * one. Call it once `engine` holds the data dir's LOCK. A TCP bind failure
 * comes as Bun reports it (see `listenError`); socket failures come as
 * ConfigError (exit 64) or SocketInUseError (exit 75).
 */
export async function startListeners(engine: Engine, options: ListenOptions): Promise<Listeners> {
  const split = options.adminSocket !== undefined;
  const serve = (surface: "combined" | "public" | "admin", unix?: string) => () =>
    startServer(engine, { port: options.port, hostname: options.hostname, dashboard: options.dashboard, surface, unix });
  const publicServe = serve(split ? "public" : "combined", options.socket);
  const pub = options.socket ? await onSocket(options.socket, publicServe) : publicServe();
  let admin: Server<SocketData> | null = null;
  if (options.adminSocket) {
    try {
      admin = await onSocket(options.adminSocket, serve("admin", options.adminSocket));
    } catch (err) {
      pub.stop(true);
      throw err;
    }
  }
  return {
    public: pub,
    admin,
    url: pub.url,
    listen: options.socket ?? pub.url.origin,
    async stop(closeActiveConnections?: boolean) {
      await Promise.all([pub.stop(closeActiveConnections), admin?.stop(closeActiveConnections)]);
    },
  };
}
