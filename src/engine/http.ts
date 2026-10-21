import type { Server } from "bun";
import { z } from "zod";
import { getFunctionPath, type FunctionType } from "../api.ts";
import { IncibaseError } from "../errors.ts";
import { adminTools } from "./admin.ts";
import { dashboardHtml } from "./dashboard.ts";
import { describeApp } from "./describe.ts";
import { ValidationError } from "./database.ts";
import { toErrorPayload, type Engine, type Identity } from "./engine.ts";
import { handleMcp } from "./mcp.ts";
import type { SocketData } from "./realtime.ts";
import { VERSION } from "./version.ts";

export interface ServeOptions {
  port: number;
  hostname?: string;
  /** Allowed CORS origins. Default `*` (auth uses bearer tokens, not cookies). */
  corsOrigins?: string[] | "*";
  /** Serve the admin dashboard at `/_/`. Default true. */
  dashboard?: boolean;
}

type Handler = (req: Request & { params: Record<string, string> }, server: Server<SocketData>) => Response | Promise<Response | undefined> | undefined;

export function startServer(engine: Engine, options: ServeOptions): Server<SocketData> {
  const dev = !!engine.options.dev;
  const origins = options.corsOrigins ?? "*";

  const cors = (req: Request): Record<string, string> => {
    const origin = req.headers.get("origin");
    if (!origin) return {};
    if (origins !== "*" && !origins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origins === "*" ? "*" : origin,
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-incibase-as-user, mcp-protocol-version, mcp-session-id",
      "access-control-max-age": "86400",
      ...(origins === "*" ? {} : { vary: "origin" }),
    };
  };

  const withCors = (req: Request, res: Response) => {
    for (const [k, v] of Object.entries(cors(req))) res.headers.set(k, v);
    return res;
  };

  const errorResponse = (err: unknown) => {
    const { status, error } = toErrorPayload(err, dev);
    return Response.json({ error }, { status });
  };

  const readJson = async (req: Request): Promise<any> => {
    try {
      return await req.json();
    } catch {
      throw new IncibaseError({ code: "BAD_REQUEST", message: "Body must be JSON" });
    }
  };

  /** Wraps a handler with CORS, preflight and error handling. */
  const route = (methods: Partial<Record<"GET" | "POST" | "DELETE", Handler>>) => {
    const wrapped: Record<string, Handler> = {
      OPTIONS: (req) => withCors(req, new Response(null, { status: 204 })),
    };
    for (const [method, handler] of Object.entries(methods)) {
      wrapped[method] = async (req, server) => {
        try {
          const res = await handler(req, server);
          return res ? withCors(req, res) : res;
        } catch (err) {
          return withCors(req, errorResponse(err));
        }
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
        const value = await engine.call(path, body?.args ?? {}, identity, { expectType: type, allowInternal: identity.admin });
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

  const mcp = route({ GET: (req) => handleMcp(engine, req), POST: (req) => handleMcp(engine, req), DELETE: (req) => handleMcp(engine, req) });

  return Bun.serve<SocketData>({
    port: options.port,
    hostname: options.hostname,
    maxRequestBodySize: engine.storage.maxUploadBytes + 1024 * 1024,
    routes: {
      "/api/health": route({ GET: () => Response.json({ ok: true, version: VERSION, startedAt: engine.startedAt }) }),
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
          if (!identity.admin && !engine.storage.verifyUploadToken(url.searchParams.get("token"))) {
            throw new IncibaseError({ code: "FORBIDDEN", message: "Invalid or expired upload URL" });
          }
          const blob = await req.blob();
          const storageId = await engine.storage.store(blob, req.headers.get("content-type") ?? undefined);
          return Response.json({ storageId });
        },
      }),
      "/api/storage/:id": route({ GET: (req) => engine.storage.serve(req.params.id!) }),

      "/api/schema": route({
        GET: (req) => {
          requireAdmin(req);
          return Response.json(describeApp(engine, { counts: true }));
        },
      }),

      "/api/admin/:tool": route({
        POST: async (req) => {
          requireAdmin(req);
          const tool = adminTools(engine)[req.params.tool!];
          if (!tool) throw new IncibaseError({ code: "NOT_FOUND", message: `Unknown admin tool "${req.params.tool}"` });
          const parsed = tool.input.safeParse(await readJson(req));
          if (!parsed.success) throw new ValidationError(`Invalid arguments:\n${z.prettifyError(parsed.error)}`, parsed.error.issues);
          return Response.json({ value: (await tool.run(parsed.data)) ?? null });
        },
      }),

      ...(options.dashboard === false
        ? {}
        : {
            "/_": () => Response.redirect("/_/", 302),
            "/_/": async () =>
              new Response(await dashboardHtml(), {
                headers: {
                  "content-type": "text/html; charset=utf-8",
                  "cache-control": "no-cache",
                  "x-frame-options": "DENY",
                  "referrer-policy": "no-referrer",
                },
              }),
          }),

      "/api/ws": (req: Request, server: Server<SocketData>) => {
        if (server.upgrade(req, { data: { identity: engine.auth.identifyRequest(req), subs: new Map() } })) return undefined;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      },

      "/mcp": mcp,
    },

    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return withCors(req, new Response(null, { status: 204 }));
      const action = engine.http?.match(req.method, url.pathname);
      if (!action) return withCors(req, Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 }));
      const started = performance.now();
      try {
        const res = await action.handler(engine.actionCtx(engine.auth.identifyRequest(req)), req);
        engine.log({ type: "http", path: `${req.method} ${url.pathname}`, durationMs: performance.now() - started, ok: true });
        return res;
      } catch (err) {
        engine.log({
          type: "http",
          path: `${req.method} ${url.pathname}`,
          durationMs: performance.now() - started,
          ok: false,
          error: (err as Error)?.message,
        });
        return withCors(req, errorResponse(err));
      }
    },

    websocket: {
      idleTimeout: 120,
      sendPings: true,
      open: (ws) => engine.realtime.open(ws),
      message: (ws, msg) => engine.realtime.message(ws, msg),
      close: (ws) => engine.realtime.close(ws),
    },
  });
}
