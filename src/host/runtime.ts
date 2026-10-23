// The runtimes a host runs branches with (design sections 6, 7 and step 14):
// standalone incibase binaries at `<runtime root>/<version>/incibase`, root
// 0755, each one checked against a sha256 before it is installed and
// recorded with it in the registry. Every branch pins one (runtime_version);
// `upgradeBranch` moves the pin through a release's gate and revert.
//
//   installRuntime  a local file with its SHA256SUMS (or an explicit sha256),
//                   or a published release: incibase-linux-<arch> and
//                   SHA256SUMS from GitHub. Nothing unverified is kept: the
//                   bytes are staged in a root-only temp file, hashed, and only
//                   renamed into place when they match. Installing the same
//                   bytes again changes nothing; other bytes under an installed
//                   version are refused.
//   useCli          points /usr/local/bin/incibase at an installed runtime.
//   gcRuntimes      removes the runtimes nothing uses: no branch pins them,
//                   the CLI link does not point at them, and this process does
//                   not run from them.
import { closeSync, fsyncSync, openSync, realpathSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { VERSION } from "../engine/version.ts";
import { defaults, type OpsContext } from "./context.ts";
import { checkRuntimeVersion, RUNTIME_VERSION_REGEX } from "./layout.ts";
import { randomBytes } from "./names.ts";
import { audited, gcTrash, OpError, parse } from "./ops.ts";
import { currentActor, type RuntimeRow } from "./registry.ts";

/** Where `v<version>/incibase-linux-<arch>` and `v<version>/SHA256SUMS` are published. */
export const DEFAULT_RELEASES_URL = "https://github.com/omer-genc/incibase/releases/download";
export const SUMS_FILE = "SHA256SUMS";
const MiB = 1024 * 1024;
/** A standalone binary is about 72 MB; anything far bigger is not one. */
export const MAX_RUNTIME_BYTES = 512 * MiB;
const MAX_SUMS_BYTES = 1 * MiB;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export interface RuntimeContext extends OpsContext {
  /** The releases base URL (default GitHub's); https, or http on a loopback host (tests). */
  releasesUrl?: string;
  /** The architecture to download for, as `process.arch` names it (default this machine's). */
  arch?: string;
}

const actor = (ctx: OpsContext) => ctx.actor ?? currentActor();
const now = (ctx: OpsContext) => (ctx.now ?? Date.now)();

// ---- names --------------------------------------------------------------------

/** The release asset of the Linux runtime for `arch` (`process.arch` names). */
export function runtimeAsset(arch: string = process.arch): string {
  if (arch === "x64") return "incibase-linux-x64";
  if (arch === "arm64") return "incibase-linux-arm64";
  throw new OpError("INVALID", `No incibase runtime is published for the ${JSON.stringify(arch)} architecture: only x64 and arm64`);
}

/** The releases base URL, checked: https (or http on a loopback host), no credentials, query or fragment. */
export function releasesBase(raw: string = DEFAULT_RELEASES_URL): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpError("INVALID", `Invalid releases URL ${JSON.stringify(raw)}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new OpError("INVALID", `The releases URL must be https (http only on localhost), without credentials, query or fragment: ${JSON.stringify(raw)}`);
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * A SHA256SUMS file as `sha256sum` writes it (`<hex>  <name>`, or
 * `<hex> *<name>` in binary mode): file name to lowercase sha256. A line that
 * is not one, or a name listed twice with different sums, refuses the file.
 */
export function parseSums(text: string, what = SUMS_FILE): Map<string, string> {
  const sums = new Map<string, string>();
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) continue;
    const match = /^([0-9a-fA-F]{64}) [ *](?:\.\/)?([^\u0000-\u001f/]+)$/.exec(line);
    if (!match) throw new OpError("FAILED", `${what} line ${i + 1} is not "<sha256>  <file name>"`);
    const [, hex, name] = match as unknown as [string, string, string];
    const seen = sums.get(name);
    if (seen !== undefined && seen !== hex.toLowerCase()) throw new OpError("FAILED", `${what} lists ${name} twice with different checksums`);
    sums.set(name, hex.toLowerCase());
  }
  return sums;
}

/** sha256 and size of a file, read as a stream. */
export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: hasher.digest("hex"), bytes };
}

// ---- downloads ----------------------------------------------------------------------

const isLoopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

async function get(url: string, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    // identity: Content-Length is then the size of the bytes read, so a cut-off download is noticed.
    res = await fetch(url, { redirect: "follow", signal, headers: { "accept-encoding": "identity", "user-agent": `incibase/${VERSION}` } });
  } catch (err) {
    throw new OpError("FAILED", `Could not download ${url}: ${(err as Error).message}`);
  }
  // GitHub redirects release assets to its object store; a redirect must not leave https.
  const final = new URL(res.url || url);
  if (final.protocol !== "https:" && !(final.protocol === "http:" && isLoopback(final))) {
    await res.body?.cancel();
    throw new OpError("FAILED", `${url} redirected to ${final.protocol}//${final.host}, which is not https`);
  }
  if (res.status === 404) {
    await res.body?.cancel();
    throw new OpError("NOT_FOUND", `${url} does not exist (404)`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new OpError("FAILED", `${url} answered ${res.status}`);
  }
  return res;
}

/** Feeds the body to `sink`, at most `maxBytes`, and checks it was as long as Content-Length said. */
async function readBody(url: string, res: Response, maxBytes: number, sink: (chunk: Uint8Array) => void): Promise<number> {
  const declared = res.headers.get("content-length");
  const encoded = (res.headers.get("content-encoding") ?? "identity") !== "identity";
  if (declared !== null && Number(declared) > maxBytes) {
    await res.body?.cancel();
    throw new OpError("FAILED", `${url} is ${declared} bytes, more than the ${maxBytes} a runtime may be`);
  }
  let bytes = 0;
  try {
    for await (const chunk of res.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new OpError("FAILED", `${url} is more than the ${maxBytes} bytes a runtime may be`);
      sink(chunk);
    }
  } catch (err) {
    if (err instanceof OpError) throw err;
    throw new OpError("FAILED", `The download of ${url} broke off after ${bytes} bytes: ${(err as Error).message}`);
  }
  if (declared !== null && !encoded && bytes !== Number(declared)) {
    throw new OpError("FAILED", `The download of ${url} ended after ${bytes} of ${declared} bytes`);
  }
  return bytes;
}

async function downloadText(url: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  const res = await get(url, signal);
  const parts: Uint8Array[] = [];
  await readBody(url, res, maxBytes, (chunk) => void parts.push(chunk));
  return Buffer.concat(parts).toString("utf8");
}

/** Downloads `url` into a new file `dest` (root-only), synced; the caller removes it on failure. */
async function downloadFile(url: string, dest: string, signal: AbortSignal): Promise<void> {
  const res = await get(url, signal);
  // wx: O_CREAT|O_EXCL, never a file or link someone planted. 0700: only root reads or runs it until it is checked.
  const fd = openSync(dest, "wx", 0o700);
  try {
    await readBody(url, res, MAX_RUNTIME_BYTES, (chunk) => {
      let written = 0;
      while (written < chunk.byteLength) written += writeSync(fd, chunk, written);
    });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---- install ------------------------------------------------------------------------

/** A Zod string checked by checkRuntimeVersion, keeping its message. */
const version = z.string().transform((value, zctx) => {
  try {
    return checkRuntimeVersion(value);
  } catch (err) {
    zctx.addIssue({ code: "custom", message: (err as Error).message });
    return z.NEVER;
  }
});
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => isAbsolute(p) && !p.includes("\0"), "must be an absolute path");
const sha256 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be a sha256 in hex (64 characters)")
  .transform((v) => v.toLowerCase());

const installSchema = z
  .strictObject({
    version,
    /** A standalone binary on this machine; without it, the release's incibase-linux-<arch> is downloaded. */
    binary: absolutePath.optional(),
    /** What the local binary must hash to. */
    sha256: sha256.optional(),
    /** A SHA256SUMS file whose entry for the binary's file name it must match. */
    sums: absolutePath.optional(),
    /** Install without asking the binary for its version: one build under another version string (tests). */
    skipVersionCheck: z.boolean().default(false),
  })
  .superRefine((v, zctx) => {
    if (v.binary !== undefined && (v.sha256 === undefined) === (v.sums === undefined)) {
      zctx.addIssue({ code: "custom", message: "a local binary needs its checksum: give exactly one of sha256 or sums" });
    }
    if (v.binary === undefined && (v.sha256 !== undefined || v.sums !== undefined)) {
      zctx.addIssue({ code: "custom", message: "sha256 and sums go with a local binary; a download is checked against its release's SHA256SUMS" });
    }
  });

export interface InstallResult {
  version: string;
  path: string;
  sha256: string;
  /** False when these bytes were installed already. */
  installed: boolean;
  source: string;
}

/** What `<binary> --version` prints; the runtime is the platform's own code, checked before it runs. */
function askVersion(path: string): { ok: boolean; said: string } {
  const result = Bun.spawnSync([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" }, timeout: 30_000 });
  const said = result.stdout.toString().trim();
  return { ok: result.exitCode === 0, said: (said || result.stderr.toString().trim()).slice(0, 200) };
}

/**
 * Installs a runtime as `<runtime root>/<version>/incibase` (root 0755, its
 * directories root 0755) once its sha256 matches: from a local file with
 * `sums` or `sha256`, or downloaded from the release v<version> with its
 * SHA256SUMS. Idempotent; refuses other bytes under an installed version.
 */
export async function installRuntime(ctx: RuntimeContext, input: z.input<typeof installSchema>): Promise<InstallResult> {
  const data = parse(installSchema, input);
  return audited(ctx, "runtime.install", null, async () => {
    const { sys, layout, registry } = ctx;
    const path = layout.runtimeBinary(data.version);
    let expected: string | null = data.sha256 ?? null;
    let source: string;
    let url: string | null = null;
    let base = "";
    if (data.binary !== undefined) {
      if (sys.lstat(data.binary)?.type !== "file") throw new OpError("INVALID", `${data.binary} is not a file`);
      source = `file:${data.binary}`;
      if (data.sums !== undefined) {
        const info = sys.lstat(data.sums);
        if (info?.type !== "file" || info.size > MAX_SUMS_BYTES) throw new OpError("INVALID", `${data.sums} is not a SHA256SUMS file`);
        const listed = parseSums(sys.readFile(data.sums) ?? "", data.sums).get(basename(data.binary));
        if (listed === undefined) {
          throw new OpError("NOT_FOUND", `${data.sums} has no entry for ${basename(data.binary)}; refusing a runtime that cannot be checked`);
        }
        expected = listed;
      }
    } else {
      base = `${releasesBase(ctx.releasesUrl)}/v${data.version}`;
      url = `${base}/${runtimeAsset(ctx.arch)}`;
      source = url;
    }

    // The same bytes again: nothing to do (and no download).
    const existing = registry.getRuntime(data.version);
    if (existing) {
      if (expected !== null && expected !== existing.sha256) throw conflict(data.version, existing.sha256, expected);
      if (sys.lstat(path)?.type === "file" && (await sha256File(path)).sha256 === existing.sha256) {
        await registry.withLock(() =>
          registry.audit({ actor: actor(ctx), action: "runtime.install", detail: { version: data.version, sha256: existing.sha256, unchanged: true }, ok: true }, now(ctx)),
        );
        return { version: data.version, path, sha256: existing.sha256, installed: false, source: existing.source };
      }
      // Its file is missing or damaged: put the recorded bytes back.
      expected ??= existing.sha256;
    }

    const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
    if (url !== null) {
      const sumsUrl = `${base}/${SUMS_FILE}`;
      const asset = runtimeAsset(ctx.arch);
      const listed = parseSums(await downloadText(sumsUrl, MAX_SUMS_BYTES, signal), sumsUrl).get(asset);
      if (listed === undefined) throw new OpError("NOT_FOUND", `${sumsUrl} has no entry for ${asset}; refusing a runtime that cannot be checked`);
      if (expected !== null && expected !== listed) throw conflict(data.version, expected, listed);
      expected = listed;
    }

    const dir = layout.runtimeDir(data.version);
    const createdDir = !sys.lstat(dir);
    for (const d of [layout.runtimeRoot, dir]) {
      if (!sys.lstat(d)) sys.mkdir(d, 0o755);
      sys.chown(d, 0, 0);
      sys.chmod(d, 0o755);
    }
    // A name of its own, so two installs never write the same file; root-only until it is checked.
    const staged = join(dir, `.incibase-${Buffer.from((ctx.random ?? randomBytes)(8)).toString("hex")}.partial`);
    try {
      if (url !== null) {
        defaults.log(ctx)(`downloading ${url}`);
        await downloadFile(url, staged, signal);
      } else sys.copyFile(data.binary!, staged, { uid: 0, gid: 0, mode: 0o700 });
      const got = await sha256File(staged);
      if (got.sha256 !== expected) {
        throw new OpError("FAILED", `${url ?? data.binary} has sha256 ${got.sha256}, not ${expected}: the runtime ${data.version} was not installed`);
      }
      sys.chown(staged, 0, 0);
      sys.chmod(staged, 0o755);
      const { ok, said } = askVersion(staged);
      if (!ok || (!data.skipVersionCheck && said !== data.version)) {
        throw new OpError("FAILED", `${url ?? data.binary} says it is ${JSON.stringify(said)}, not ${data.version}`);
      }
      return await registry.withLock(() => {
        const current = registry.getRuntime(data.version);
        if (current && current.sha256 !== expected) throw conflict(data.version, current.sha256, expected!);
        sys.rename(staged, path);
        const row: RuntimeRow = { version: data.version, sha256: expected!, bytes: got.bytes, source, reported: said, installed_at: now(ctx) };
        registry.tx(() => {
          registry.putRuntime(row);
          registry.audit(
            {
              actor: actor(ctx),
              action: "runtime.install",
              detail: { version: data.version, path, sha256: expected, bytes: got.bytes, source, ...(data.skipVersionCheck ? { reported: said } : {}) },
              ok: true,
            },
            now(ctx),
          );
        });
        return { version: data.version, path, sha256: expected!, installed: true, source };
      });
    } finally {
      if (sys.lstat(staged)) sys.remove(staged);
      if (createdDir && sys.lstat(dir)?.type === "dir" && sys.readdir(dir).length === 0) sys.remove(dir);
    }
  });
}

function conflict(version: string, installed: string, given: string) {
  return new OpError("CONFLICT", `The runtime ${version} is installed with sha256 ${installed}, not ${given}: a version is never replaced by other bytes`);
}

/** The installed runtime `version` (recorded and its file present); NOT_FOUND otherwise. */
export function requireInstalled(ctx: OpsContext, version: string): RuntimeRow {
  const row = ctx.registry.getRuntime(version);
  if (!row || ctx.sys.lstat(ctx.layout.runtimeBinary(version))?.type !== "file") {
    throw new OpError("NOT_FOUND", `The runtime ${version} is not installed: run incibase host install-runtime --version ${version} first`);
  }
  return row;
}

/** The runtime version `path` is (or links to) `<runtime root>/<version>/incibase` of; null when none. */
export function runtimeOf(ctx: OpsContext, path: string | undefined): string | null {
  if (!path || !isAbsolute(path)) return null;
  const candidates = [path];
  const target = ctx.sys.readlink(path);
  if (target !== null) candidates.push(resolve(dirname(path), target));
  const roots = [ctx.layout.runtimeRoot];
  try {
    candidates.push(realpathSync(path));
    roots.push(realpathSync(ctx.layout.runtimeRoot));
  } catch {
    // Missing: what readlink said is all there is.
  }
  for (const candidate of candidates) {
    for (const root of roots) {
      const match = /^([^/]+)\/incibase$/.exec(relative(root, candidate));
      if (match && RUNTIME_VERSION_REGEX.test(match[1]!)) return match[1]!;
    }
  }
  return null;
}

// ---- the CLI link -----------------------------------------------------------------

const useCliSchema = z.strictObject({
  version,
  /** Put the link in place of a regular file (e.g. a binary copied there by hand). */
  replace: z.boolean().default(false),
});

/** Points the CLI link (/usr/local/bin/incibase) at an installed runtime, atomically. */
export async function useCli(ctx: OpsContext, input: z.input<typeof useCliSchema>) {
  const data = parse(useCliSchema, input);
  return audited(ctx, "runtime.use_cli", null, () =>
    ctx.registry.withLock(() => {
      const { sys, layout, registry } = ctx;
      requireInstalled(ctx, data.version);
      const link = layout.cliLink;
      const target = layout.runtimeBinary(data.version);
      if (sys.lstat(dirname(link))?.type !== "dir") throw new OpError("NOT_FOUND", `${dirname(link)} does not exist`);
      const info = sys.lstat(link);
      const previous = info?.type === "symlink" ? sys.readlink(link) : null;
      if (info && info.type !== "symlink" && !(info.type === "file" && data.replace)) {
        throw new OpError("CONFLICT", `${link} is a ${info.type}, not a link${info.type === "file" ? `; pass replace to put a link to ${target} in its place` : ""}`);
      }
      if (previous !== target) sys.symlink(target, link);
      registry.setSetting("cli_version", data.version);
      registry.audit({ actor: actor(ctx), action: "runtime.use_cli", detail: { version: data.version, link, previous: previous ?? info?.type ?? null }, ok: true }, now(ctx));
      return { version: data.version, link, target, previous };
    }),
  );
}

// ---- listing and gc ----------------------------------------------------------------

/** The installed runtimes, which branches pin each, and which one the CLI link runs. */
export async function listRuntimes(ctx: OpsContext, _input: Record<string, never> = {}) {
  const pinned = ctx.registry.pinnedRuntimes();
  const cli = runtimeOf(ctx, ctx.layout.cliLink);
  const runtimes = ctx.registry.listRuntimes().map((row) => ({
    ...row,
    path: ctx.layout.runtimeBinary(row.version),
    present: ctx.sys.lstat(ctx.layout.runtimeBinary(row.version))?.type === "file",
    pinnedBy: pinned.get(row.version) ?? [],
    cli: row.version === cli,
  }));
  return { runtimes, cli };
}

const gcRuntimesSchema = z.strictObject({ dryRun: z.boolean().default(false) });

/**
 * Removes the installed runtimes nothing uses: no branch that is not
 * deleted pins it, the CLI link does not point at it and this process does
 * not run from it. While a branch is being upgraded (its job's target is
 * not pinned yet) it removes nothing.
 */
export async function gcRuntimes(ctx: OpsContext, input: z.input<typeof gcRuntimesSchema> = {}) {
  const { dryRun } = parse(gcRuntimesSchema, input);
  return audited(ctx, "runtime.gc", null, async () => {
    const { registry, layout, sys } = ctx;
    const result = await registry.withLock(() => {
      const upgrading = registry.listBranches({ phase: "ready" }).filter((b) => b.busy_unit?.startsWith(`${layout.units.prefix}-upgrade-`));
      const pinned = registry.pinnedRuntimes();
      const cli = runtimeOf(ctx, layout.cliLink);
      const self = runtimeOf(ctx, ctx.self[0]);
      const kept: { version: string; by: string[] }[] = [];
      const removed: string[] = [];
      for (const row of registry.listRuntimes()) {
        const by = [...(pinned.get(row.version) ?? []), ...(row.version === cli ? [layout.cliLink] : []), ...(row.version === self ? ["this process"] : [])];
        if (by.length || upgrading.length) kept.push({ version: row.version, by: by.length ? by : ["an upgrade in progress"] });
        else removed.push(row.version);
      }
      if (!dryRun) {
        registry.tx(() => {
          for (const v of removed) registry.deleteRuntime(v);
          registry.audit({ actor: actor(ctx), action: "runtime.gc", detail: { removed, kept: kept.map((k) => k.version) }, ok: true }, now(ctx));
        });
      }
      return { removed, kept, dryRun, ...(upgrading.length ? { skipped: `upgrading ${upgrading.map((b) => `${b.project}/${b.name}`).join(", ")}` } : {}) };
    });
    // After the commit: a version without its row is not installed, so nothing starts from it meanwhile.
    if (!dryRun) for (const v of result.removed) if (sys.lstat(layout.runtimeDir(v))) sys.remove(layout.runtimeDir(v));
    return result;
  });
}

const gcSchema = z.strictObject({ olderThanDays: z.number().min(0).max(3650).optional() });

/** `incibase host gc`: trash older than `olderThanDays` (7), then the runtimes nothing uses. */
export async function gc(ctx: OpsContext, input: z.input<typeof gcSchema> = {}) {
  const { olderThanDays } = parse(gcSchema, input);
  const trash = await gcTrash(ctx, olderThanDays === undefined ? {} : { olderThanDays });
  const runtimes = await gcRuntimes(ctx, {});
  return { trash: trash.removed, runtimes };
}
