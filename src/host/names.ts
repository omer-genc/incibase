// Names the host layer turns into paths, unit names, user names and DNS
// labels. Everything that reaches one of those is checked here first: a
// project slug, a branch name, a branch id, an env name. A branch is reached
// at `https://<branch>--<project>.<domain>`, so the two names together must
// make one DNS label of at most 63 characters, and "--" separates them: no
// name may contain it.

/** Kinds of branch: production, development and short-lived preview branches. */
export const BRANCH_KINDS = ["prod", "dev", "preview"] as const;
export type BranchKind = (typeof BRANCH_KINDS)[number];

/** Longest DNS label (RFC 1035). */
export const MAX_LABEL_LENGTH = 63;
export const MAX_PROJECT_LENGTH = 30;
export const MAX_BRANCH_LENGTH = 20;
const MIN_PROJECT_LENGTH = 2;

/** A letter, then letters, digits and single hyphens; no hyphen at the end. */
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Names a project or branch may not take: hostnames the host keeps for itself
 * (M4 serves `deploy.<domain>` and `console.<domain>`), common service names,
 * and punycode or underscore labels, which mean something else in DNS.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "deploy",
  "console",
  "control",
  "admin",
  "api",
  "www",
  "mail",
  "smtp",
  "imap",
  "pop",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "ftp",
  "cdn",
  "static",
  "assets",
  "status",
  "host",
  "hosts",
  "root",
  "localhost",
  "incibase",
]);

export class NameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameError";
  }
}

function checkSlug(what: string, value: unknown, min: number, max: number): string {
  if (typeof value !== "string") throw new NameError(`${what} must be a string`);
  if (value.startsWith("_")) throw new NameError(`${what} "${value}" is reserved: names starting with "_" mean something else in DNS`);
  if (value.startsWith("xn--")) throw new NameError(`${what} "${value}" is reserved: "xn--" starts a punycode label`);
  if (value.length < min || value.length > max) {
    throw new NameError(`${what} "${value}" must be ${min} to ${max} characters long`);
  }
  if (!SLUG.test(value)) {
    throw new NameError(
      `${what} "${value}" must be lowercase letters, digits and single hyphens, start with a letter and not end with a hyphen ` +
        `("--" separates the branch from the project in the hostname)`,
    );
  }
  if (RESERVED_NAMES.has(value)) throw new NameError(`${what} "${value}" is reserved`);
  return value;
}

/** Checks a project slug, e.g. `shop`, and returns it. */
export function checkProjectSlug(value: unknown): string {
  return checkSlug("Project name", value, MIN_PROJECT_LENGTH, MAX_PROJECT_LENGTH);
}

/** Checks a branch name, e.g. `prod`, and returns it. */
export function checkBranchName(value: unknown): string {
  return checkSlug("Branch name", value, 1, MAX_BRANCH_LENGTH);
}

/** The DNS label of a branch, `<branch>--<project>`; also its link name under `hosts/` and `admin/`. */
export function branchLabel(project: string, branch: string): string {
  const label = `${checkBranchName(branch)}--${checkProjectSlug(project)}`;
  if (label.length > MAX_LABEL_LENGTH) throw new NameError(`"${label}" is longer than a DNS label (${MAX_LABEL_LENGTH} characters)`);
  return label;
}

/** A label `branchLabel` made: one "--" between two valid names. */
const LABEL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Checks a branch label before it becomes a path; returns it. */
export function checkLabel(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_LABEL_LENGTH || !LABEL.test(value)) {
    throw new NameError(`Invalid branch label ${JSON.stringify(value)}: expected "<branch>--<project>"`);
  }
  return value;
}

/** `shop/prod`, how people name a branch on the command line and in logs. */
export function branchRef(project: string, branch: string): string {
  return `${project}/${branch}`;
}

/** Splits and checks `shop/prod`. */
export function parseBranchRef(ref: string): { project: string; branch: string } {
  const parts = ref.split("/");
  if (parts.length !== 2) throw new NameError(`Expected <project>/<branch>, e.g. shop/prod, got "${ref}"`);
  return { project: checkProjectSlug(parts[0]), branch: checkBranchName(parts[1]) };
}

export function checkBranchKind(value: unknown): BranchKind {
  if (!BRANCH_KINDS.includes(value as BranchKind)) {
    throw new NameError(`Branch kind must be one of ${BRANCH_KINDS.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as BranchKind;
}

/** The kind a branch gets when none is given: `prod` and `dev` by name, anything else is a preview. */
export function defaultKind(branch: string): BranchKind {
  return branch === "prod" ? "prod" : branch === "dev" ? "dev" : "preview";
}

/** Production branches are protected unless the owner says otherwise: stopping or deleting one needs a confirmation. */
export function defaultProtected(kind: BranchKind): boolean {
  return kind === "prod";
}

const MiB = 1024 * 1024;

/** What a new branch may use, by kind (limits_json). */
export function defaultLimits(kind: BranchKind): { memoryMax: number } {
  return { memoryMax: kind === "prod" ? 512 * MiB : 256 * MiB };
}

// Branch ids name the unit (`incibase-branch@<id>`), the OS user (`ib-<id>`)
// and the directory (`branches/<id>`). They are random, not derived from the
// names, so a name used again after a delete never meets the old one's files.
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const BRANCH_ID_REGEX = /^b[0-9a-hjkmnp-tv-z]{7}$/;

/** A new branch id: "b" and 7 random base32 characters (35 bits), e.g. `b7k2m9q4`. */
export function newBranchId(random: (n: number) => Uint8Array = randomBytes): string {
  let id = "b";
  // 256 is a multiple of 32, so the low 5 bits of a random byte are uniform.
  for (const byte of random(7)) id += ID_ALPHABET[byte & 31];
  return id;
}

export function checkBranchId(value: unknown): string {
  if (typeof value !== "string" || !BRANCH_ID_REGEX.test(value)) throw new NameError(`Invalid branch id ${JSON.stringify(value)}`);
  return value;
}

/** The OS user (and its group) of a branch. */
export function branchUser(id: string): string {
  return `ib-${checkBranchId(id)}`;
}

/** Strong random bytes. */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Checks an environment variable name before it is written to an env file. */
export function checkEnvName(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !ENV_NAME.test(value)) {
    throw new NameError(`Invalid environment variable name ${JSON.stringify(value)}: letters, digits and "_", not starting with a digit`);
  }
  return value;
}

/** A lowercase hostname of dot-separated labels, e.g. `incibase.omergenc.net`. */
const DOMAIN = /^(?=.{1,190}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Checks the base domain branches are served under. */
export function checkDomain(value: unknown): string {
  if (typeof value !== "string" || !DOMAIN.test(value)) {
    throw new NameError(`Invalid domain ${JSON.stringify(value)}: expected a lowercase hostname such as incibase.example.net`);
  }
  return value;
}

/** Checks an IANA time zone name, e.g. `Europe/Istanbul`. */
export function checkTimezone(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) throw new NameError(`Invalid time zone ${JSON.stringify(value)}`);
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    throw new NameError(`Unknown time zone "${value}"`);
  }
  return value;
}
