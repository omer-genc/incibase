import type { Server } from "bun";
import { lookup } from "node:dns/promises";
import { createServer } from "node:net";
import { getFunctionPath, type FunctionType } from "../api.ts";
import { IncibaseError } from "../errors.ts";
import { adminTools, invokeAdminTool } from "./admin.ts";
import { dashboardHtml } from "./dashboard.ts";
import { describeApp } from "./describe.ts";
import { toErrorPayload, type Engine, type Identity } from "./engine.ts";
import { ConfigError } from "./exit-codes.ts";
import { LimitError, limitResponse } from "./limits.ts";
import { ridFrom, withRid } from "./log.ts";
import { handleMcp } from "./mcp.ts";
import type { SocketData } from "./realtime.ts";
import { allowsInternal, hasScope } from "./service-keys.ts";
import { adminRequestRefusal, corsOriginsFromEnv, routesFor, type Surface } from "./surface.ts";
import { VERSION } from "./version.ts";

export interface ServeOptions {
  port: number;
  hostname?: string;
  /**
   * Listen on this unix socket instead of `port` and `hostname`, behind a
   * front proxy that owns the HTTP timeouts. `startListeners` (listeners.ts)
   * removes a stale socket at the path first and sets mode 0770 after binding.
   */
  unix?: string;
  /** What this listener serves and accepts (see surface.ts). Default `"combined"`, everything as in 0.2.0. */
  surface?: Surface;
  /**
   * Allowed CORS origins. Default `INCIBASE_CORS_ORIGINS` or `*` (auth uses
   * bearer tokens, not cookies). The admin surface sends no CORS headers.
   */
  corsOrigins?: string[] | "*";
  /** Serve the admin dashboard at `/_/`. Default true. */
  dashboard?: boolean;
  /**
   * Largest JSON body (API routes, MCP) and WebSocket message accepted, in
   * bytes; also what one socket's subscriptions may hold. Default
   * `INCIBASE_MAX_JSON_BYTES` or 1 MiB. Uploads use the storage limit.
   */
  maxJsonBytes?: number;
}

const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

/** `INCIBASE_MAX_JSON_BYTES`, so a server started by the CLI can raise the limit. */
export function maxJsonBytesFromEnv(): number | undefined {
  const value = process.env.INCIBASE_MAX_JSON_BYTES;
  if (!value) return undefined;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new ConfigError(`INCIBASE_MAX_JSON_BYTES must be a positive whole number of bytes, got "${value}"`);
  }
  return bytes;
}

/** A body over its route's limit; answered with 413. */
class BodyTooLargeError extends IncibaseError<{ code: string; message: string }> {}

/**
 * Reads a body up to `limit` bytes. A larger declared Content-Length is
 * refused before reading; a chunked body is counted as it streams in and
 * refused as soon as it passes the limit.
 */
async function readBody(req: Request, limit: number, error: { code: string; message: string }): Promise<Blob> {
  const tooLarge = () => new BodyTooLargeError(error);
  if (Number(req.headers.get("content-length")) > limit) throw tooLarge();
  if (!req.body) return new Blob([]);
  const chunks: BlobPart[] = [];
  let size = 0;
  const reader = req.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value as Uint8Array<ArrayBuffer>);
  }
  return new Blob(chunks);
}

/** Bind failures no restart fixes, and how to say them. */
const PERMANENT_BIND_ERRORS: Record<string, (port: number) => string> = {
  EACCES: (port) => (port < 1024 ? "permission denied (ports below 1024 need privileges)" : "permission denied"),
  EPERM: () => "permission denied",
  EADDRNOTAVAIL: () => "the address is not on this machine",
  EAFNOSUPPORT: () => "this machine does not support the address family",
};

/**
 * Why `startServer` could not listen on `hostname:port`. Bun reports every
 * listen failure as EADDRINUSE with errno 0, including a hostname that does
 * not resolve, an address that is not on this machine and a port this user
 * may not bind. Those fail the same way on every start, so this resolves the
 * host and binds the address with node:net to find the real cause: a
 * ConfigError (exit 64) for those, and `err` itself (exit 75) for an address
 * in use or one that is free again by now.
 */
export async function listenError(err: unknown, hostname: string, port: number): Promise<unknown> {
  const code = (err as { code?: unknown } | null)?.code;
  const fail = (reason: string) => new ConfigError(`Cannot listen on ${hostname}:${port}: ${reason}`);
  if (typeof code === "string" && PERMANENT_BIND_ERRORS[code]) return fail(PERMANENT_BIND_ERRORS[code](port));
  if (code !== "EADDRINUSE") return err;
  let address: string;
  try {
    ({ address } = await lookup(hostname));
  } catch {
    return fail("the hostname does not resolve");
  }
  const real = await new Promise<string | undefined>((resolve) => {
    const probe = createServer();
    probe.once("error", (e) => resolve((e as { code?: string }).code));
    probe.listen(port, address, () => probe.close(() => resolve(undefined)));
  });
  return real && PERMANENT_BIND_ERRORS[real] ? fail(PERMANENT_BIND_ERRORS[real](port)) : err;
}

type Handler = (req: Request & { params: Record<string, string> }, server: Server<SocketData>) => Response | Promise<Response | undefined> | undefined;

export function startServer(engine: Engine, options: ServeOptions): Server<SocketData> {
  const dev = !!engine.options.dev;
  const surface = options.surface ?? "combined";
  const origins = options.corsOrigins ?? (surface === "admin" ? undefined : corsOriginsFromEnv()) ?? "*";
  const maxJsonBytes = options.maxJsonBytes ?? maxJsonBytesFromEnv() ?? DEFAULT_MAX_JSON_BYTES;

  const cors = (req: Request): Record<string, string> => {
    const origin = req.headers.get("origin");
    // The admin surface is for its own origin only (the tunnel's), never cross-site.
    if (!origin || surface === "admin") return {};
    if (origins !== "*" && !origins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origins === "*" ? "*" : origin,
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-incibase-as-user, x-request-id, mcp-protocol-version, mcp-session-id",
      "access-control-expose-headers": "x-request-id",
      "access-control-max-age": "86400",
      ...(origins === "*" ? {} : { vary: "origin" }),
    };
  };

  const withCors = (req: Request, res: Response) => {
    for (const [k, v] of Object.entries(cors(req))) res.headers.set(k, v);
    return res;
  };

  const errorResponse = (err: unknown, { admin = false } = {}) => {
    const { status, error } = toErrorPayload(err, dev);
    // Admin callers get the message of an internal error (not the stack) in production too, as on MCP.
    if (status === 500 && admin && !dev) error.message = String(err);
    if (err instanceof LimitError) return limitResponse(err, error);
    return Response.json({ error }, { status: err instanceof BodyTooLargeError ? 413 : status });
  };

  const jsonTooLarge = { code: "PAYLOAD_TOO_LARGE", message: `Body exceeds ${maxJsonBytes} bytes` };
  const readText = async (req: Request) => (await readBody(req, maxJsonBytes, jsonTooLarge)).text();

  const readJson = async (req: Request): Promise<any> => {
    const text = await readText(req);
    try {
      return JSON.parse(text);
    } catch {
      throw new IncibaseError({ code: "BAD_REQUEST", message: "Body must be JSON" });
    }
  };

  /** Sets the request id header, unless the response already has one or cannot take headers. */
  const withRequestId = (res: Response, rid: string) => {
    try {
      if (!res.headers.has("x-request-id")) res.headers.set("x-request-id", rid);
    } catch {}
    return res;
  };

  /**
   * Wraps a handler with CORS, preflight and error handling. The request runs
   * with its id (the client's `x-request-id` or a new one) for the log, and the
   * response carries it back.
   */
  const route = (methods: Partial<Record<"GET" | "POST" | "DELETE", Handler>>) => {
    const wrapped: Record<string, Handler> = {
      OPTIONS: (req) => withCors(req, new Response(null, { status: 204 })),
    };
    for (const [method, handler] of Object.entries(methods)) {
      wrapped[method] = (req, server) => {
        const rid = ridFrom(req.headers.get("x-request-id"));
        return withRid(rid, async () => {
          try {
            const res = await handler(req, server);
            return res ? withRequestId(withCors(req, res), rid) : res;
          } catch (err) {
            return withRequestId(withCors(req, errorResponse(err)), rid);
          }
        });
      };
    }
    return wrapped;
  };

  const callRoute = (type: FunctionType) =>
    route({
      POST: async (req) => {
        const body = await readJson(req);
        if (typeof body?.path !== "string") {
          throw new IncibaseError({ code: "BAD_REQUEST", message: 'Body must be { "path": "module:function", "args": {...} }' });
        }
        const path = getFunctionPath(body.path);
        const identity = engine.auth.identifyRequest(req);
        const value = await engine.call(path, body?.args ?? {}, identity, { expectType: type, allowInternal: allowsInternal(identity) });
        return Response.json({ value });
      },
    });

  const requireUser = (identity: Identity) => {
    if (!identity.userId) throw new IncibaseError({ code: "UNAUTHENTICATED", message: "Sign in required" });
    return identity.userId;
  };

  const requireAdmin = (req: Request) => {
    if (!engine.auth.identifyRequest(req).admin) throw new IncibaseError({ code: "FORBIDDEN", message: "Admin key required" });
  };

  const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? null;

  /**
   * What a split surface answers before any route runs, or null to go on: the
   * admin surface refuses other Host and Origin headers, and each surface the
   * bearer it does not accept (the admin key on public, service keys on admin).
   */
  const refuse = (req: Request): Response | null => {
    if (surface === "combined") return null;
    if (surface === "admin") {
      const reason = adminRequestRefusal(req);
      if (reason) return Response.json({ error: { code: "FORBIDDEN", message: reason } }, { status: 403 });
    }
    try {
      engine.auth.assertAccepted(bearer(req), surface);
    } catch (err) {
      return withCors(req, errorResponse(err));
    }
    return null;
  };

  const notFound = (req: Request) => withCors(req, Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 }));

  const mcp = route({
    GET: (req) => handleMcp(engine, req, undefined, surface),
    POST: (req) => handleMcp(engine, req, () => readText(req), surface),
    DELETE: (req) => handleMcp(engine, req, undefined, surface),
  });

  /** Runs the app's httpAction for `req`, if one matches. */
  const httpAction = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return withCors(req, new Response(null, { status: 204 }));
    const action = engine.http?.match(req.method, url.pathname);
    if (!action) return withCors(req, Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 }));
    const started = performance.now();
    try {
      const res = await engine.runHttpAction(action.handler, engine.auth.identifyRequest(req), req, `${req.method} ${url.pathname}`);
      engine.log({ type: "http", path: `${req.method} ${url.pathname}`, durationMs: performance.now() - started, ok: true });
      return res;
    } catch (err) {
      engine.log(
        {
          type: "http",
          path: `${req.method} ${url.pathname}`,
          durationMs: performance.now() - started,
          ok: false,
          error: (err as Error)?.message,
        },
        { err },
      );
      return withCors(req, errorResponse(err));
    }
  };

  return Bun.serve<SocketData>({
    ...(options.unix
      ? // The front proxy owns the timeouts: Bun's default (10 s) would cut requests it still waits for.
        // Bun's types leave idleTimeout out for unix sockets, but it applies there too.
        ({ unix: options.unix, idleTimeout: 0 } as { unix: string })
      : { port: options.port, hostname: options.hostname }),
    // Bun's debug error pages show messages and source; keep them to dev.
    development: dev,
    // Routes read their bodies with their own limits; this caps everything else (HTTP actions).
    maxRequestBodySize: Math.max(engine.storage.maxUploadBytes, maxJsonBytes) + 1024 * 1024,
    error: (err) => errorResponse(err),
    routes: routesFor(surface, refuse, notFound, {
      // `generation` tells a host's deploy gate which release this process runs (it sets INCIBASE_GENERATION per start).
      // The admin socket also says which service keys file it uses, so a revoke checks the reload took (see ServiceKeysStatus).
      "/api/health": route({
        GET: () =>
          Response.json({
            ok: true,
            version: VERSION,
            startedAt: engine.startedAt,
            generation: process.env.INCIBASE_GENERATION || null,
            ...(surface === "admin" && engine.options.serviceKeys ? { serviceKeys: engine.options.serviceKeys.status } : {}),
          }),
      }),
      "/api/query": callRoute("query"),
      "/api/mutation": callRoute("mutation"),
      "/api/action": callRoute("action"),

      "/api/auth/signup": route({ POST: async (req) => Response.json(await engine.auth.signUp(await readJson(req))) }),
      "/api/auth/signin": route({ POST: async (req) => Response.json(await engine.auth.signIn(await readJson(req))) }),
      "/api/auth/signout": route({
        POST: async (req) => {
          const token = bearer(req);
          if (token) await engine.auth.signOut(token);
          return Response.json({ ok: true });
        },
      }),
      "/api/auth/me": route({
        GET: async (req) => {
          const { userId } = engine.auth.identifyRequest(req);
          return Response.json({ user: userId ? await engine.auth.getUser(userId) : null });
        },
      }),
      "/api/auth/password": route({
        POST: async (req) => {
          const userId = requireUser(engine.auth.identifyRequest(req));
          return Response.json(await engine.auth.changePassword(userId, await readJson(req)));
        },
      }),

      "/api/storage/upload": route({
        POST: async (req) => {
          const url = new URL(req.url);
          const identity = engine.auth.identifyRequest(req);
          // The signed upload URL decides visibility; an admin (or the upload scope) may pass ?visibility= directly.
          const grant = identity.admin || hasScope(identity, "upload")
            ? {
                visibility: (url.searchParams.get("visibility") ?? undefined) as "public" | "private" | undefined,
                ownerId: null,
                // A service key's upload is marked as its own: it may attach that file, not the admin's.
                serviceKeyId: identity.admin ? undefined : identity.service?.keyId,
              }
            : engine.storage.verifyUploadToken(url.searchParams.get("token"));
          if (!grant) {
            throw new IncibaseError({ code: "FORBIDDEN", message: "Invalid or expired upload URL" });
          }
          // Streamed to disk and counted as it arrives, so a chunked body without Content-Length cannot skip the limit.
          const storageId = await engine.storage.receive(req, grant);
          return Response.json({ storageId });
        },
      }),
      "/api/storage/:id": route({ GET: (req) => engine.storage.serve(req.params.id!, new URL(req.url)) }),

      "/api/schema": route({
        GET: (req) => {
          requireAdmin(req);
          return Response.json(describeApp(engine, { counts: true }));
        },
      }),

      "/api/admin/:tool": route({
        POST: async (req) => {
          requireAdmin(req);
          const tool = adminTools(engine, { surface })[req.params.tool!];
          if (!tool) throw new IncibaseError({ code: "NOT_FOUND", message: `Unknown admin tool "${req.params.tool}"` });
          const args = await readJson(req);
          try {
            return Response.json({ value: (await invokeAdminTool(req.params.tool!, tool, args, "http")) ?? null });
          } catch (err) {
            // Admins get the message of an internal error too, as on MCP.
            return errorResponse(err, { admin: true });
          }
        },
      }),

      ...(options.dashboard === false
        ? {}
        : {
            "/_": () => Response.redirect("/_/", 302),
            "/_/": async () => {
              try {
                return new Response(await dashboardHtml(), {
                  headers: {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "no-cache",
                    "x-frame-options": "DENY",
                    "referrer-policy": "no-referrer",
                  },
                });
              } catch (err) {
                return errorResponse(err);
              }
            },
          }),

      "/api/ws": (req: Request, server: Server<SocketData>) => {
        try {
          const { identity, session } = engine.auth.authenticateRequest(req);
          const data: SocketData = { identity, session, subs: new Map(), maxSubscriptionBytes: maxJsonBytes, surface };
          if (server.upgrade(req, { data })) return undefined;
          return new Response("Expected a WebSocket upgrade", { status: 426 });
        } catch (err) {
          return errorResponse(err);
        }
      },

      "/mcp": mcp,
    }),

    // The app's own responses are left as they are: the id is only for the log.
    // The admin socket runs no HTTP actions: its origin holds the dashboard's admin key.
    fetch: (req) =>
      refuse(req) ?? (surface === "admin" ? notFound(req) : withRid(ridFrom(req.headers.get("x-request-id")), () => httpAction(req))),

    websocket: {
      // Behind a proxy (unix socket) the first ping comes before common 60-100 s idle cutoffs.
      idleTimeout: options.unix ? 60 : 120,
      sendPings: true,
      // Larger messages close the connection.
      maxPayloadLength: maxJsonBytes,
      open: (ws) => engine.realtime.open(ws),
      message: (ws, msg) => engine.realtime.message(ws, msg),
      close: (ws) => engine.realtime.close(ws),
    },
  });
}
