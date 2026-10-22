// Keys other servers call a branch with: `ik_svc_<id>_<secret>`. The host
// layer keeps only their sha256 in a JSON file (INCIBASE_SERVICE_KEYS_FILE),
// which serve reads again on SIGHUP, so a key is added or revoked without a
// restart. A service key is never the admin: its scopes say what it may do
// beyond what an anonymous caller may.
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ServiceIdentity, ServiceScope } from "../server.ts";
import type { Identity } from "./engine.ts";
import { ConfigError } from "./exit-codes.ts";
import { logEvent } from "./log.ts";
import type { Realtime } from "./realtime.ts";

export type { ServiceIdentity, ServiceScope };

export const SERVICE_KEY_PREFIX = "ik_svc_";

const SCOPES = ["internal", "impersonate", "upload"] as const satisfies readonly ServiceScope[];

// No "_": it ends the id inside the key.
const KEY_ID = /^[A-Za-z0-9-]{1,64}$/;

const keyEntry = z.object({
  id: z.string().regex(KEY_ID, "an id is 1 to 64 letters, digits or -"),
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "the sha256 is 64 hex digits, of the whole key")
    .transform((hex) => hex.toLowerCase()),
  scopes: z.array(z.enum(SCOPES)).default(["internal"]),
  label: z.string().optional(),
  revoked: z.boolean().optional(),
});
const keysFile = z.array(keyEntry);

type KeyEntry = z.output<typeof keyEntry>;

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** A new key for `id`, and the sha256 the keys file holds for it. */
export function newServiceKey(id: string): { key: string; sha256: string } {
  if (!KEY_ID.test(id)) throw new Error(`Invalid service key id "${id}": use 1 to 64 letters, digits or -`);
  const key = `${SERVICE_KEY_PREFIX}${id}_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  return { key, sha256: sha256(key) };
}

/** Reads and checks a keys file; ConfigError when it cannot be used. */
function readKeys(path: string): Map<string, KeyEntry> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read the service keys file ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`The service keys file ${path} is not JSON`);
  }
  const parsed = keysFile.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`The service keys file ${path} must be [{ id, sha256, scopes, label?, revoked? }]:\n${z.prettifyError(parsed.error)}`);
  }
  const keys = new Map<string, KeyEntry>();
  for (const entry of parsed.data) {
    if (keys.has(entry.id)) throw new ConfigError(`The service keys file ${path} lists the id "${entry.id}" twice`);
    keys.set(entry.id, entry);
  }
  return keys;
}

/** Ids whose key no longer gives what it gave: removed, revoked, replaced, or with a scope taken away. */
function narrowed(before: Map<string, KeyEntry>, after: Map<string, KeyEntry>): Set<string> {
  const ids = new Set<string>();
  for (const [id, old] of before) {
    if (old.revoked) continue;
    const now = after.get(id);
    if (!now || now.revoked || now.sha256 !== old.sha256 || old.scopes.some((s) => !now.scopes.includes(s))) ids.add(id);
  }
  return ids;
}

export class ServiceKeys {
  private keys: Map<string, KeyEntry>;

  /** Reads `path`; throws ConfigError (exit 64) when it is missing or malformed. */
  constructor(readonly path: string) {
    this.keys = readKeys(path);
  }

  /** The keys in the file, revoked ones included. */
  get size() {
    return this.keys.size;
  }

  /** Who `token` is, when it is an unrevoked key in the file. The hash is compared in constant time. */
  match(token: string): ServiceIdentity | null {
    if (!token.startsWith(SERVICE_KEY_PREFIX)) return null;
    const rest = token.slice(SERVICE_KEY_PREFIX.length);
    const end = rest.indexOf("_");
    if (end <= 0 || end === rest.length - 1) return null;
    const entry = this.keys.get(rest.slice(0, end));
    if (!entry || entry.revoked) return null;
    if (!timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(entry.sha256))) return null;
    return { keyId: entry.id, scopes: [...entry.scopes] };
  }

  /**
   * Reads the file again. A file that cannot be used is logged and the
   * previous keys stay. Returns the ids whose access narrowed (see
   * `narrowed`), or null when the file was kept.
   */
  reload(): Set<string> | null {
    let next: Map<string, KeyEntry>;
    try {
      next = readKeys(this.path);
    } catch (err) {
      const msg = `${(err as Error).message}\nKeeping the service keys read before.`;
      logEvent("error", { ev: "service_keys_reload_failed", msg, file: this.path }, [`[incibase] ${msg}`]);
      return null;
    }
    const changed = narrowed(this.keys, next);
    this.keys = next;
    const active = [...next.values()].filter((k) => !k.revoked).length;
    logEvent("info", { ev: "service_keys_reloaded", file: this.path, keys: active, narrowed: [...changed] }, [
      `[incibase] reloaded ${active} service key(s) from ${this.path}`,
    ]);
    return changed;
  }
}

/** The keys file `INCIBASE_SERVICE_KEYS_FILE` names, or null when it is not set. */
export function serviceKeysFromEnv(): ServiceKeys | null {
  const path = process.env.INCIBASE_SERVICE_KEYS_FILE;
  return path ? new ServiceKeys(path) : null;
}

/** Whether `identity` came from a service key with `scope`. */
export function hasScope(identity: Identity, scope: ServiceScope): boolean {
  return !!identity.service?.scopes.includes(scope);
}

/** Who may call internal functions over the API: the admin, and service keys with the `internal` scope. */
export function allowsInternal(identity: Identity): boolean {
  return identity.admin || hasScope(identity, "internal");
}

/** What a reload acts on; serve fills it in as it starts. */
export interface ReloadTarget {
  keys?: ServiceKeys | null;
  realtime?: Realtime;
}

/**
 * Makes SIGHUP (`systemctl reload`) read the service keys again instead of
 * ending the process. Install it before anything else: a reload that comes
 * while serve is still starting would otherwise end it, and systemd would not
 * restart it. Before the keys are first read there is nothing to reload; the
 * first read sees the file as it is then. Open WebSockets signed in with a
 * key whose access narrowed become anonymous.
 */
export function handleReloads(target: ReloadTarget) {
  process.on("SIGHUP", () => {
    if (!target.keys) {
      const msg = process.env.INCIBASE_SERVICE_KEYS_FILE ? "SIGHUP before the service keys were read" : "SIGHUP: no INCIBASE_SERVICE_KEYS_FILE to reload";
      logEvent("info", { ev: "reload", msg }, [`[incibase] ${msg}`]);
      return;
    }
    const changed = target.keys.reload();
    if (changed?.size) target.realtime?.revokeIdentities((identity) => !!identity.service && changed.has(identity.service.keyId));
  });
}
