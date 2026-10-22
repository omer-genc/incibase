// The `admin_sql` tool. A query must be one read statement that does not name
// a table holding secrets; it then runs in a child process on its own
// short-lived read-only connection, so it cannot attach other databases, leave
// state on the engine's connections or block the event loop, and a query that
// runs past its time is killed outright.
import { dirname, resolve } from "node:path";
import { IncibaseError } from "../errors.ts";

export const SQL_MAX_ROWS = 1000;
export const SQL_TIMEOUT_MS = 5000;
/** Query processes running at once; the rest wait for a slot. */
const MAX_RUNNING = 2;
/** How long past its deadline a query process lives on if the server dies before killing it. */
const ORPHAN_GRACE_MS = 1000;

/** Admin key and storage secret, password hashes, session hashes, and raw pages of every table. */
const HIDDEN_TABLES = new Set(["_incibase_meta", "_passwords", "_sessions", "sqlite_dbpage"]);
/** Keywords that start the main statement after a `WITH` clause. */
const STATEMENT_VERBS = new Set(["SELECT", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE"]);

interface Token {
  type: "word" | "quoted" | "string" | "punct";
  text: string;
}

function refuse(message: string): never {
  throw new IncibaseError({ code: "SQL_NOT_ALLOWED", message });
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
const isWordChar = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

/** Splits SQL into tokens by SQLite's rules, dropping whitespace and comments. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (isSpace(c)) {
      i++;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2); // SQLite lets a block comment run to the end
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      // Strings and quoted identifiers; the closing quote doubled is a literal quote ([...] has no escape).
      const close = c === "[" ? "]" : c;
      let text = "";
      let j = i + 1;
      while (true) {
        const end = sql.indexOf(close, j);
        if (end < 0) refuse(`Unterminated ${c} in query`);
        text += sql.slice(j, end);
        if (close !== "]" && sql[end + 1] === close) {
          text += close;
          j = end + 2;
        } else {
          i = end + 1;
          break;
        }
      }
      tokens.push({ type: c === "'" ? "string" : "quoted", text });
    } else if (isWordChar(c)) {
      let j = i + 1;
      while (j < sql.length && isWordChar(sql[j]!)) j++;
      tokens.push({ type: "word", text: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ type: "punct", text: c });
      i++;
    }
  }
  return tokens;
}

const keyword = (t: Token | undefined) => (t?.type === "word" ? t.text.toUpperCase() : "");

/** For `WITH ... AS (...) <verb>`: the first statement keyword outside parentheses. */
function verbAfterWith(tokens: Token[]): string {
  let depth = 0;
  for (const t of tokens.slice(1)) {
    if (t.type === "punct" && t.text === "(") depth++;
    else if (t.type === "punct" && t.text === ")") depth--;
    else if (depth === 0 && STATEMENT_VERBS.has(keyword(t))) return keyword(t);
  }
  return "";
}

function checkStatement(tokens: Token[], explained = false) {
  const verb = keyword(tokens[0]);
  if (verb === "EXPLAIN" && !explained) {
    const plan = keyword(tokens[1]) === "QUERY" && keyword(tokens[2]) === "PLAN";
    return checkStatement(tokens.slice(plan ? 3 : 1), true);
  }
  const main = verb === "WITH" ? verbAfterWith(tokens) : verb;
  if (main !== "SELECT" && main !== "VALUES") {
    refuse(`admin_sql only runs read queries (SELECT, VALUES, WITH or EXPLAIN)${main ? `, not ${main}` : ""}`);
  }
}

/**
 * Throws unless `sql` is exactly one read statement that names no hidden table.
 * Names are compared unquoted and case-insensitively, string literals included:
 * SQLite accepts `FROM '_passwords'` as a table name.
 */
export function assertReadQuery(sql: string) {
  const tokens = tokenize(sql);
  for (const t of tokens) {
    const name = t.type === "punct" ? "" : t.text.trim().toLowerCase();
    if (HIDDEN_TABLES.has(name)) refuse(`admin_sql cannot read ${name}: it holds server secrets or credentials`);
  }
  const statements: Token[][] = [[]];
  for (const t of tokens) {
    if (t.type === "punct" && t.text === ";") statements.push([]);
    else statements.at(-1)!.push(t);
  }
  const nonEmpty = statements.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) refuse("admin_sql needs a query");
  if (nonEmpty.length > 1) refuse("admin_sql runs exactly one statement");
  checkStatement(nonEmpty[0]!);
}

// Plain JS for `bun -e`; a compiled binary runs it too, as the bun CLI under BUN_BE_BUN=1.
const CHILD_SOURCE = `
import { Database } from "bun:sqlite";
const { path, query, params, maxRows, killAt } = JSON.parse(await Bun.stdin.text());
// The server kills this process at its deadline. If the server dies first, a
// second thread does it, since the query blocks this one. A blob Worker fails
// under --disallow-code-generation-from-strings=strict; the server's kill still applies then.
try {
  const watchdog = "setTimeout(() => process.kill(process.pid, 'SIGKILL'), " + killAt + " - Date.now())";
  new Worker(URL.createObjectURL(new Blob([watchdog])), { ref: false });
} catch {}
let db;
let out;
try {
  db = new Database(path, { readonly: true, strict: true });
  db.run("PRAGMA query_only = ON");
  db.run("PRAGMA busy_timeout = 5000");
  const stmt = db.query(query);
  const rows = [];
  let truncated = false;
  for (const row of stmt.iterate(...params)) {
    if (rows.length === maxRows) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  stmt.finalize();
  // "temp" is this connection's own scratch schema; anything else was attached.
  const attached = db.query("SELECT name FROM pragma_database_list WHERE name NOT IN ('main', 'temp')").all();
  if (attached.length) throw new Error("admin_sql must not attach databases");
  out = JSON.stringify({ rows, truncated });
} catch (err) {
  out = JSON.stringify({ error: String(err?.message ?? err) });
} finally {
  db?.close();
}
await Bun.write(Bun.stdout, out);
process.exit(0);
`;

let running = 0;
const waiting: (() => void)[] = [];

/** Takes one of the MAX_RUNNING query slots, waiting up to `timeoutMs` for one to free up. */
function acquireSlot(timeoutMs: number): Promise<void> {
  if (running < MAX_RUNNING) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const wake = () => {
      clearTimeout(timer);
      running++;
      resolve();
    };
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(wake), 1);
      reject(new IncibaseError({ code: "SQL_BUSY", message: "Earlier admin_sql queries are still running; try again when they finish" }));
    }, timeoutMs);
    waiting.push(wake);
  });
}

function releaseSlot() {
  running--;
  waiting.shift()?.();
}

function spawnQuery(file: string, request: string) {
  return Bun.spawn([process.execPath, "--no-env-file", "-e", CHILD_SOURCE], {
    // The data directory, so no bunfig.toml of the app preloads anything into the child.
    cwd: dirname(file),
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdin: new Blob([request]),
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Runs a checked read query against the database file at `path` and returns at
 * most `maxRows` rows. `timeoutMs` covers the whole call, waiting for a slot
 * included: at the deadline the caller gets SQL_TIMEOUT and the query process
 * is killed with SIGKILL, which stops even a single SQLite step that never
 * yields a row and releases its CPU and its WAL read snapshot. bun:sqlite has
 * no sqlite3_interrupt, so a thread in this process could not be stopped.
 */
export async function runAdminSql(
  path: string,
  query: string,
  params: (string | number | null)[],
  options: { timeoutMs?: number; maxRows?: number } = {},
): Promise<{ rows: unknown[]; truncated: boolean }> {
  assertReadQuery(query);
  return runUncheckedQuery(path, query, params, options);
}

/**
 * runAdminSql without assertReadQuery: only the child's read-only, query_only
 * connection and its attach check apply. Exported for tests of those layers.
 */
export async function runUncheckedQuery(
  path: string,
  query: string,
  params: (string | number | null)[],
  { timeoutMs = SQL_TIMEOUT_MS, maxRows = SQL_MAX_ROWS } = {},
): Promise<{ rows: unknown[]; truncated: boolean }> {
  const deadline = Date.now() + timeoutMs;
  await acquireSlot(timeoutMs);
  const file = resolve(path);
  let proc: ReturnType<typeof spawnQuery>;
  try {
    proc = spawnQuery(file, JSON.stringify({ path: file, query, params, maxRows, killAt: deadline + ORPHAN_GRACE_MS }));
  } catch (err) {
    releaseSlot();
    throw err;
  }
  // The slot is held until the process is gone, killed or not.
  void proc.exited.then(releaseSlot);
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new IncibaseError({ code: "SQL_TIMEOUT", message: `admin_sql query stopped after ${timeoutMs}ms` }));
    }, Math.max(0, deadline - Date.now()));
  });
  try {
    const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const [out, errors, code] = await Promise.race([output, timeout]);
    let data: { rows: unknown[]; truncated: boolean; error?: string } | undefined;
    try {
      data = code === 0 ? JSON.parse(out) : undefined;
    } catch {}
    if (!data) throw new Error(`admin_sql process failed (exit code ${code}): ${errors.trim().slice(-500)}`);
    if (data.error !== undefined) throw new IncibaseError({ code: "SQL_ERROR", message: data.error });
    return { rows: data.rows, truncated: data.truncated };
  } finally {
    clearTimeout(timer);
  }
}
