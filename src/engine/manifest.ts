// The manifest line of a release bundle (`app.ib`). Reading it never imports
// or evaluates the bundle: the host layer runs as root and calls this on
// files anyone could have uploaded.
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { z } from "zod";
import { ConfigError } from "./exit-codes.ts";

/** A bundle's first line is `/*! incibase-manifest {json} *\/`; the module follows on the next line. */
export const MANIFEST_PREFIX = "/*! incibase-manifest ";
export const MANIFEST_SUFFIX = " */";
/** Longer first lines are refused unread, so a huge file without a newline is not read whole. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Module paths as the loader discovers them (`"chat/messages"`); other characters would break function paths. */
export const MODULE_PATH_REGEX = /^[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
/** Export names a function reference (`api.chat.messages.list`) can spell. */
export const EXPORT_NAME_REGEX = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FUNCTION_PATH = new RegExp(`^${MODULE_PATH_REGEX.source.slice(1, -1)}:${EXPORT_NAME_REGEX.source.slice(1, -1)}$`);

// Root prints what a manifest says, so nothing in it may carry terminal
// control sequences: text without C0/C1 controls (descriptions may keep tabs
// and newlines), and printable ASCII where that is all there can be.
/** Text without control characters, at most `max` characters. */
const text = (max: number) => z.string().max(max).regex(/^[^\u0000-\u001f\u007f-\u009f]*$/, "must not contain control characters");
/** Printable ASCII, 1 to `max` characters. */
const ascii = (max: number) => z.string().regex(/^[\x20-\x7e]+$/, "must be printable ASCII").max(max);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const functionSchema = z.strictObject({
  path: z.string().max(512).regex(FUNCTION_PATH, 'must be "module/path:export"'),
  type: z.enum(["query", "mutation", "action"]),
  visibility: z.enum(["public", "internal"]),
  description: z
    .string()
    .regex(/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f]*$/, "must not contain control characters other than tabs and newlines")
    .optional(),
});

const cronSchema = z.strictObject({
  name: text(256),
  schedule: z.union([
    z.strictObject({ kind: z.literal("interval"), ms: z.number() }),
    z.strictObject({ kind: z.literal("cron"), expression: ascii(256), tz: ascii(128).optional() }),
  ]),
  path: z.string().max(512).regex(FUNCTION_PATH, 'must be "module/path:export"'),
});

const routeSchema = z.strictObject({
  method: z.string().regex(/^[A-Z]{1,16}$/, "must be an HTTP method"),
  path: ascii(2048).optional(),
  pathPrefix: ascii(2048).optional(),
});

/** What the app defines, as `describeApp` reports it, without a database. */
export const appSummarySchema = z.strictObject({
  functions: z.array(functionSchema),
  tables: z.record(
    text(256),
    z.strictObject({ indexes: z.array(z.strictObject({ name: text(256), fields: z.array(text(1024)), unique: z.boolean() })) }),
  ),
  crons: z.array(cronSchema),
  http: z.array(routeSchema),
});

/** Strict throughout: a key the writer never writes is refused, not passed on. */
export const manifestSchema = z.strictObject({
  format: z.literal(1),
  incibaseVersion: z.string().max(64).regex(SEMVER, "must be a version such as 0.3.0"),
  /** Of the bundle's bytes after the manifest line's newline. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
  app: appSummarySchema,
  /** Environment variables the code reads (`process.env.X`, `Bun.env.X`, `import.meta.env.X`). */
  envNames: z.array(z.string().max(256).regex(ENV_NAME)),
});

export type AppSummary = z.infer<typeof appSummarySchema>;
export type BundleManifest = z.infer<typeof manifestSchema>;

/** The manifest line for `manifest`. `*\/` in a string would end the comment, so it is written `*\\/`. */
export function manifestLine(manifest: BundleManifest): string {
  return `${MANIFEST_PREFIX}${JSON.stringify(manifest).replaceAll("*/", "*\\/")}${MANIFEST_SUFFIX}`;
}

/**
 * Parses and validates a manifest line (without its newline); ConfigError naming `file` otherwise.
 * A raw `*\/` in the JSON is refused: it would end the comment early, and
 * whatever followed it would run as module code without being in the sha256.
 * `manifestLine` never writes one.
 */
export function parseManifestLine(line: string, file: string): BundleManifest {
  if (!line.startsWith(MANIFEST_PREFIX) || !line.endsWith(MANIFEST_SUFFIX)) {
    throw new ConfigError(`${file} is not an incibase bundle: its first line is not an incibase-manifest comment`);
  }
  const jsonText = line.slice(MANIFEST_PREFIX.length, -MANIFEST_SUFFIX.length);
  if (jsonText.includes("*/")) {
    throw new ConfigError(`${file}: the manifest contains "*/", which would end its comment and run what follows; it was not written by incibase bundle`);
  }
  let json: unknown;
  try {
    json = JSON.parse(jsonText);
  } catch (err) {
    throw new ConfigError(`${file}: the manifest is not valid JSON (${(err as Error).message})`);
  }
  const result = manifestSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new ConfigError(`${file}: invalid manifest at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return result.data;
}

/** Reads and validates the manifest from the first line of `file` only; the rest of the file is never read. */
export function readManifest(file: string): BundleManifest {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    throw new ConfigError(`Cannot read bundle ${file}: ${(err as Error).message}`);
  }
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    const chunk = Buffer.alloc(64 * 1024);
    while (length <= MAX_MANIFEST_BYTES) {
      const n = readSync(fd, chunk, 0, chunk.length, length);
      if (n === 0) break;
      const newline = chunk.subarray(0, n).indexOf(0x0a);
      if (newline !== -1) {
        // The same limit verifyBundle applies, so what this accepts serve accepts too.
        if (length + newline > MAX_MANIFEST_BYTES) throw tooLong(file);
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        return parseManifestLine(decode(Buffer.concat(chunks), file), file);
      }
      chunks.push(Buffer.from(chunk.subarray(0, n)));
      length += n;
    }
    throw noNewline(Buffer.concat(chunks), file);
  } finally {
    closeSync(fd);
  }
}

export interface VerifiedBundle {
  manifest: BundleManifest;
  /** The whole file, manifest line included, as it was hashed: import exactly this text. */
  source: string;
}

/** Reads `file` once and checks its manifest and sha256; ConfigError when either is wrong. Executes nothing. */
export function verifyBundle(file: string): VerifiedBundle {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    throw new ConfigError(`Cannot read bundle ${file}: ${(err as Error).message}`);
  }
  const newline = bytes.subarray(0, MAX_MANIFEST_BYTES + 1).indexOf(0x0a);
  if (newline === -1) {
    throw noNewline(bytes, file);
  }
  const manifest = parseManifestLine(decode(bytes.subarray(0, newline), file), file);
  const sha256 = sha256Hex(bytes.subarray(newline + 1));
  if (sha256 !== manifest.sha256) {
    throw new ConfigError(
      `${file}: sha256 mismatch (manifest ${manifest.sha256}, contents ${sha256}); the bundle was changed after it was built`,
    );
  }
  return { manifest, source: decode(bytes, file) };
}

/** Why a file whose first `MAX_MANIFEST_BYTES` hold no newline is refused. */
function noNewline(start: Buffer, file: string): ConfigError {
  if (start.length > MAX_MANIFEST_BYTES) return tooLong(file);
  // Not a manifest at all is the more useful message.
  parseManifestLine(decode(start, file), file);
  return new ConfigError(`${file} is not an incibase bundle: no module after the manifest line`);
}

function tooLong(file: string): ConfigError {
  return new ConfigError(`${file}: the manifest line is longer than ${MAX_MANIFEST_BYTES} bytes`);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function decode(bytes: Uint8Array, file: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConfigError(`${file} is not an incibase bundle: it is not UTF-8 text`);
  }
}

/** Env var names read as `process.env.X`, `Bun.env.X`, `import.meta.env.X` or with `["X"]`, sorted. */
export function envNamesOf(source: string): string[] {
  const names = new Set<string>();
  const pattern = /\b(?:process\.env|Bun\.env|import\.meta\.env)\s*(?:\??\.\s*([A-Za-z_$][\w$]*)|\??\.?\[\s*(["'`])([^"'`\\\n]+)\2\s*\])/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1] ?? match[3]!;
    if (ENV_NAME.test(name)) names.add(name);
  }
  return [...names].sort();
}
