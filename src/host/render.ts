// The contents of files rendered from the registry. Writing them (atomically,
// with owner and mode) is provision.ts's job; these functions only build text.
import { checkEnvName } from "./names.ts";
import type { BranchRow, EnvRow, ServiceKeyRow } from "./registry.ts";

/** Values systemd reads the same unquoted: no spaces, quotes, backslashes or comment marks. */
const PLAIN_VALUE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/**
 * One value for a systemd EnvironmentFile. Inside double quotes systemd
 * turns `\"` and `\\` into `"` and `\`, keeps `$` and newlines as they are,
 * and strips nothing (verified on systemd 255).
 */
export function quoteEnvValue(value: string): string {
  if (value.includes("\0")) throw new Error("An environment value cannot contain a NUL character");
  if (PLAIN_VALUE.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** An EnvironmentFile: one `NAME=value` per entry, later entries win. */
export function envFileContent(entries: [name: string, value: string][]): string {
  let out = "# Rendered by incibase from control/registry.db; changes here are overwritten.\n";
  for (const [name, value] of entries) out += `${checkEnvName(name)}=${quoteEnvValue(value)}\n`;
  return out;
}

/** The env a branch process gets: the registry's rows (system ones first), then what the host derives. */
export function branchEnv(rows: EnvRow[], derived: Record<string, string>): [string, string][] {
  const sorted = [...rows].sort((a, b) => b.system - a.system || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries: [string, string][] = sorted.filter((r) => !(r.name in derived)).map((r) => [r.name, r.value]);
  for (const [name, value] of Object.entries(derived)) entries.push([name, value]);
  return entries;
}

/** `INCIBASE_SERVICE_KEYS_FILE` for serve: sha256 and scopes of the keys not revoked. */
export function serviceKeysContent(rows: ServiceKeyRow[]): string {
  const keys = rows
    .filter((r) => r.revoked_at === null)
    .map((r) => ({ id: r.id, sha256: r.sha256, scopes: r.scopes.split(",").filter(Boolean), label: r.label }));
  return `${JSON.stringify(keys, null, 2)}\n`;
}

/**
 * `admin/index.json`, what `incibase tunnel` reads over SSH to find a
 * branch's admin socket and its fixed laptop port. Ready branches only.
 */
export function adminIndexContent(branches: BranchRow[], domain: string | null): string {
  const index: Record<string, { label: string; socket: string; port: number; kind: string; url: string | null }> = {};
  for (const b of [...branches].sort((x, y) => x.label.localeCompare(y.label))) {
    if (b.phase !== "ready") continue;
    index[`${b.project}/${b.name}`] = {
      label: b.label,
      socket: `${b.label}.sock`,
      port: b.tunnel_port,
      kind: b.kind,
      url: domain ? `https://${b.label}.${domain}` : null,
    };
  }
  return `${JSON.stringify(index, null, 2)}\n`;
}
