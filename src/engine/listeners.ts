// Where serve listens: TCP as in 0.2.0, or unix sockets behind a front proxy
// (--socket) and an SSH tunnel (--admin-socket). With --admin-socket the
// surfaces split: the public listener has no admin power, the admin one has
// the dashboard and the admin tools (see surface.ts).
import type { Server } from "bun";
import { chmodSync, lstatSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
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
  /**
   * Stops accepting connections at once and removes the socket files; the
   * promise resolves once every open connection (WebSockets included) closed.
   * `closeActiveConnections` closes them now instead.
   */
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
  if (flags.socket !== undefined && flags.adminSocket !== undefined && samePath(flags.socket, flags.adminSocket)) {
    throw new ConfigError("--socket and --admin-socket must be different paths");
  }
}

/** Whether two paths name the same file: run/a.sock and ./run/a.sock, or the same name in a symlinked directory. */
function samePath(a: string, b: string): boolean {
  const real = (path: string) => {
    const full = resolve(path);
    try {
      return join(realpathSync(dirname(full)), basename(full));
    } catch {
      return full;
    }
  };
  return resolve(a) === resolve(b) || real(a) === real(b);
}

function kindOf(stat: Stats): string {
  if (stat.isSymbolicLink()) return "a symbolic link";
  if (stat.isDirectory()) return "a directory";
  if (stat.isFile()) return "a file";
  return "not a socket";
}

function notASocket(path: string, stat: Stats) {
  return new ConfigError(`Cannot listen on ${path}: it is ${kindOf(stat)}, and only a stale socket is removed. Move it away, or pick another path`);
}

/** `lstat` of `path`, or null when nothing is there. */
function lstatAt(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw new ConfigError(`Cannot listen on ${path}: ${(err as Error).message}`);
  }
}

/**
 * Whether a process accepts connections on the socket at `path`. Only a
 * refused connection says none does; when that cannot be told (no permission
 * to connect, another error) it throws, so the socket is left alone.
 */
function answers(path: string): Promise<boolean> {
  return new Promise((settle, fail) => {
    const conn = connect(path);
    const done = (live: boolean | Error) => {
      clearTimeout(timer);
      conn.destroy();
      if (live instanceof Error) fail(live);
      else settle(live);
    };
    // A listener too busy to accept within this is still a listener.
    const timer = setTimeout(() => done(true), 2000);
    conn.once("connect", () => done(true));
    conn.once("error", (err: Error & { code?: string }) => {
      // ENOENT: the socket is gone already.
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") return done(false);
      if (err.code === "EACCES" || err.code === "EPERM") {
        return done(new ConfigError(`Cannot listen on ${path}: permission denied to check the socket there, so it is left alone`));
      }
      done(new SocketInUseError(`Cannot listen on ${path}: cannot tell whether a process listens on it (${err.code ?? err.message}), so it is left alone`));
    });
  });
}

/**
 * Removes the socket a killed server left at `path`, so a new one can bind
 * it. Only call it while holding the data dir's LOCK: that proves the server
 * that made the socket is gone. Never removes anything that is not a socket
 * (a symlink is not followed), nor a socket a process still listens on.
 */
export async function clearStaleSocket(path: string) {
  const stat = lstatAt(path);
  if (!stat) return;
  if (!stat.isSocket()) throw notASocket(path, stat);
  if (await answers(path)) throw new SocketInUseError(`Cannot listen on ${path}: another process is listening on it`);
  // Looked at again right before the unlink: something else may have taken the path during the check.
  const now = lstatAt(path);
  if (!now) return;
  if (!now.isSocket()) throw notASocket(path, now);
  if (now.dev !== stat.dev || now.ino !== stat.ino) {
    throw new SocketInUseError(`Cannot listen on ${path}: another socket took its place while it was checked`);
  }
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

/** The socket this process bound at a path, to remove it on stop and nothing that took its place. */
interface BoundSocket {
  path: string;
  dev: number;
  ino: number;
}

/** Removes the socket file at `bound.path` when it is still the one bound there (Bun usually removes it itself). */
function removeSocket(bound: BoundSocket) {
  try {
    const stat = lstatSync(bound.path);
    if (stat.isSocket() && stat.dev === bound.dev && stat.ino === bound.ino) unlinkSync(bound.path);
  } catch {
    // Gone already, or not ours to remove.
  }
}

/** Binds a unix socket for `start` and gives it mode 0770 (Bun creates it from the umask, e.g. 0755). */
async function onSocket(path: string, start: () => Server<SocketData>, bound: BoundSocket[]): Promise<Server<SocketData>> {
  await clearStaleSocket(path);
  let server: Server<SocketData>;
  try {
    server = start();
  } catch (err) {
    throw socketListenError(err, path);
  }
  try {
    // chmod follows a symlink: make sure the path is still the socket just bound.
    const stat = lstatSync(path);
    if (!stat.isSocket()) throw new Error("it is no longer a socket");
    chmodSync(path, SOCKET_MODE);
    bound.push({ path, dev: stat.dev, ino: stat.ino });
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
  const bound: BoundSocket[] = [];
  const pub = options.socket ? await onSocket(options.socket, publicServe, bound) : publicServe();
  let admin: Server<SocketData> | null = null;
  if (options.adminSocket) {
    try {
      admin = await onSocket(options.adminSocket, serve("admin", options.adminSocket), bound);
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
      const stopped = Promise.all([pub.stop(closeActiveConnections), admin?.stop(closeActiveConnections)]);
      // Once nothing listens, the socket files go (a graceful stop no longer accepts connections right away).
      for (const socket of bound) removeSocket(socket);
      await stopped;
    },
  };
}
