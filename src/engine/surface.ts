// What each listener serves and whom it lets in. Without --admin-socket one
// listener serves everything ("combined", as in 0.2.0). With it (hosted mode)
// the public listener serves the app without admin power, and the admin
// listener, reached through an SSH tunnel, serves the dashboard and the admin
// tools to localhost names only.
import { ConfigError } from "./exit-codes.ts";
import { readMeta } from "./store.ts";

export type Surface = "combined" | "public" | "admin";

/**
 * Paths only the admin surface serves: the admin tools, the schema and the
 * dashboard. The public surface answers them 404, as the front proxy does.
 */
export function isAdminPath(path: string): boolean {
  return path === "/api/schema" || path === "/_" || path.startsWith("/_/") || path === "/api/admin" || path.startsWith("/api/admin/");
}

/** Host names the admin surface answers to, with any port: a browser or client on the other end of the SSH tunnel. */
const ADMIN_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * Why the admin surface refuses `req`, or null. A web page on another site
 * that the browser lets reach the tunnel's port, directly or through DNS
 * rebinding, sends its own Host or Origin; only localhost names, from a page
 * of that same origin, get through.
 */
export function adminRequestRefusal(req: Request): string | null {
  const host = req.headers.get("host");
  if (!host || !ADMIN_HOST.test(host)) {
    return `The admin socket answers only to Host localhost, 127.0.0.1 or [::1]${host ? `, not "${host}"` : ""}`;
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin.toLowerCase() !== `http://${host}`.toLowerCase()) {
    return `Origin "${origin}" is not this admin socket's origin (http://${host})`;
  }
  return null;
}

/** `INCIBASE_CORS_ORIGINS`: a comma-separated allowlist of origins (or `*`); undefined when unset. */
export function corsOriginsFromEnv(value = process.env.INCIBASE_CORS_ORIGINS): string[] | "*" | undefined {
  if (!value?.trim()) return undefined;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.includes("*")) return "*";
  for (const entry of entries) {
    let origin: string | undefined;
    try {
      origin = new URL(entry).origin;
    } catch {}
    if (origin !== entry) {
      throw new ConfigError(`INCIBASE_CORS_ORIGINS: "${entry}" is not an origin; use scheme://host[:port] with no path, e.g. https://shop.com`);
    }
  }
  return entries;
}

type Route = unknown;

/** `value` (a handler, a static Response or a method map) behind `refuse`, which answers first when it returns a response. */
function guarded(value: Route, refuse: (req: Request) => Response | null): Route {
  if (typeof value === "function") {
    return (req: Request, server: unknown) => refuse(req) ?? (value as (req: Request, server: unknown) => unknown)(req, server);
  }
  if (value instanceof Response) return (req: Request) => refuse(req) ?? value.clone();
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([method, handler]) => [method, guarded(handler, refuse)]));
  }
  return value;
}

/**
 * The routes a listener of `surface` serves. Combined keeps them as they
 * are. Public and admin put every route behind `refuse`, so a route added
 * later cannot skip the surface's checks; public also answers the admin paths
 * with `notFound`.
 */
export function routesFor<R extends Record<string, unknown>>(
  surface: Surface,
  refuse: (req: Request) => Response | null,
  notFound: (req: Request) => Response,
  routes: R,
): R {
  if (surface === "combined") return routes;
  const out: Record<string, Route> = {};
  for (const [path, value] of Object.entries(routes)) {
    out[path] = guarded(surface === "public" && isAdminPath(path) ? notFound : value, refuse);
  }
  return out as R;
}

/** Secrets hosted mode takes from the environment only. */
const HOSTED_SECRETS = [
  { env: "INCIBASE_ADMIN_KEY", meta: "admin_key" },
  { env: "INCIBASE_STORAGE_SECRET", meta: "storage_secret" },
] as const;

/**
 * Hosted mode keeps every secret out of data.db, so a copy or snapshot of
 * the database carries none: they must come from the environment, and a
 * database that still holds them is refused (ConfigError, exit 64) before
 * anything is written to it.
 */
export function checkHostedSecrets(database: string, env: Record<string, string | undefined> = process.env) {
  const missing = HOSTED_SECRETS.filter((s) => !env[s.env]).map((s) => s.env);
  if (missing.length) {
    throw new ConfigError(`--admin-socket (hosted mode) needs ${missing.join(" and ")} in the environment; it never keeps secrets in the database`);
  }
  let stored: string[];
  try {
    stored = HOSTED_SECRETS.filter((s) => readMeta(database, s.meta) !== null).map((s) => s.meta);
  } catch {
    // No database yet, or not one: opening the store reports that.
    return;
  }
  if (stored.length) {
    throw new ConfigError(
      `${database} still holds ${stored.join(" and ")} in _incibase_meta, and hosted mode keeps secrets out of the database. ` +
        `Adopt the data dir into the host (incibase host adopt), which moves them into the branch's environment and deletes them here, then start again`,
    );
  }
}
