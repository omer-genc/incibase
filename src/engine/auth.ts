import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { IncibaseError } from "../errors.ts";
import { ValidationError, type DbSession } from "./database.ts";
import type { Engine, Identity } from "./engine.ts";
import { ANONYMOUS } from "./engine.ts";
import { checkPositiveInt, ConcurrencyGate, LimitError, positiveIntFromEnv } from "./limits.ts";
import { SERVICE_KEY_PREFIX } from "./service-keys.ts";
import type { Surface } from "./surface.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const credentials = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters").max(256),
});
const signUpInput = credentials.extend({ name: z.string().trim().min(1).max(200).optional() });

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface AuthResult {
  token: string;
  user: { _id: string; _creationTime: number; email: string; name?: string; emailVerified: boolean };
}

/** The session behind a user identity. Live sockets keep it so revoking or expiring it signs them out. */
export interface SessionRef {
  tokenHash: string;
  userId: string;
  expiresAt: number;
}

export interface AuthOptions {
  /**
   * Password hashes and checks run at once; `INCIBASE_AUTH_CONCURRENCY` wins
   * when set. Each takes about 64 MiB (argon2id), so this bounds what a burst
   * of sign-ins can allocate. Default: no limit, as in 0.2.0 (a host sets one
   * from its memory budget).
   */
  concurrency?: number;
  /** How long a sign-in, sign-up or password change waits for a slot before AUTH_BUSY (default 10 s). */
  queueTimeoutMs?: number;
  /** How many may wait at once (default 256 when there is a limit); the next one gets AUTH_BUSY without waiting. */
  maxQueued?: number;
}

/** Email/password accounts in `_users`, opaque bearer session tokens stored hashed in `_sessions`. */
export class AuthService {
  /** Every password hash and check runs in a slot of this gate (see AuthOptions). */
  readonly hashing: ConcurrencyGate;

  constructor(
    private readonly engine: Engine,
    options: AuthOptions = {},
  ) {
    // Unlimited unless a limit is set: a plain app keeps 0.2.0's throughput.
    const limit = positiveIntFromEnv("INCIBASE_AUTH_CONCURRENCY") ?? checkPositiveInt(options.concurrency, "auth.concurrency") ?? Infinity;
    this.hashing = new ConcurrencyGate(limit, checkPositiveInt(options.queueTimeoutMs, "auth.queueTimeoutMs") ?? 10_000, {
      busy: () =>
        new LimitError(
          { code: "AUTH_BUSY", message: `Too many sign-ins in progress (at most ${limit} at a time); try again shortly` },
          503,
          1,
        ),
      maxQueued: checkPositiveInt(options.maxQueued, "auth.maxQueued") ?? 256,
    });
  }

  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) throw new ValidationError(z.prettifyError(result.error), result.error.issues);
    return result.data;
  }

  async signUp(input: unknown): Promise<AuthResult> {
    const { email, password, name } = this.parse(signUpInput, input);
    const hash = await this.hashing.run(() => Bun.password.hash(password));
    const userId = await this.engine.writeTx((session) => {
      const users = session.systemTable("_users");
      if (this.findUserId(email)) throw new IncibaseError({ code: "EMAIL_TAKEN", message: "Email is already registered" });
      const id = session.insertRaw(users, JSON.stringify({ email, ...(name ? { name } : {}), emailVerified: false }));
      session.conn.query(`INSERT INTO _passwords (user_id, hash) VALUES (?, ?)`).run(id, hash);
      return id;
    });
    return this.createSession(userId, hash);
  }

  async signIn(input: unknown): Promise<AuthResult> {
    const { email, password } = this.parse(credentials, input);
    // The user and hash are read once the slot is ours, not before the wait: a password
    // change or deletion that commits while this sign-in waits must count.
    const checked = await this.hashing.run(async () => {
      const userId = this.findUserId(email);
      const hash = userId ? this.passwordHash(userId) : null;
      // Verify against a dummy hash when the user is unknown so timing does not reveal it.
      const ok = await Bun.password.verify(password, hash ?? (await (dummyHash ??= Bun.password.hash("incibase-dummy-password"))));
      return ok && userId && hash ? { userId, hash } : null;
    });
    // A disabled account answers like a wrong password, whatever the password: an account is often
    // disabled because it is under attack, and a distinct answer would confirm the right guess.
    if (!checked || this.isDisabled(checked.userId)) throw invalidCredentials();
    return this.createSession(checked.userId, checked.hash);
  }

  async signOut(token: string) {
    const tokenHash = sha256(token);
    await this.engine.writeTx((session) => {
      session.conn.query(`DELETE FROM _sessions WHERE token_hash = ?`).run(tokenHash);
      session.onCommit(() => this.engine.realtime.revokeSessions((s) => s.tokenHash === tokenHash));
    });
  }

  /** Revokes all sessions of a user, e.g. after a password change. Returns how many there were. */
  async revokeAll(userId: string): Promise<number> {
    this.assertUserId(userId);
    return this.engine.writeTx((session) => this.revokeIn(session, userId));
  }

  /**
   * Disables or re-enables a user. A disabled user cannot sign in, and all
   * their sessions are revoked. Writes `_users` directly: it is read-only to
   * function code and the generic admin tools.
   */
  async setDisabled(userId: string, disabled: boolean) {
    this.assertUserId(userId);
    await this.engine.writeTx(async (session) => {
      const users = session.systemTable("_users");
      const user = await session.get("_users", userId);
      if (!user) throw new IncibaseError({ code: "NOT_FOUND", message: `User "${userId}" not found` });
      const { _id, _creationTime, disabled: _, ...fields } = user;
      session.updateRaw(users, userId, JSON.stringify(disabled ? { ...fields, disabled: true } : fields));
      if (disabled) this.revokeIn(session, userId);
    });
  }

  /**
   * Deletes a user with their password and sessions. Documents in app tables
   * and stored files that reference the user are kept.
   */
  async deleteUser(userId: string) {
    this.assertUserId(userId);
    await this.engine.writeTx((session) => {
      session.deleteRaw(session.systemTable("_users"), userId);
      session.conn.query(`DELETE FROM _passwords WHERE user_id = ?`).run(userId);
      this.revokeIn(session, userId);
    });
  }

  private assertUserId(userId: string) {
    if (this.engine.store.tableOfId(userId)?.name !== "_users") {
      throw new IncibaseError({ code: "NOT_FOUND", message: `"${userId}" is not a _users id` });
    }
  }

  /** Deletes a user's sessions and, once committed, downgrades sockets signed in with them. */
  private revokeIn(session: DbSession, userId: string): number {
    const { changes } = session.conn.query(`DELETE FROM _sessions WHERE user_id = ?`).run(userId);
    session.onCommit(() => this.engine.realtime.revokeSessions((s) => s.userId === userId));
    return changes;
  }

  private isDisabled(userId: string): boolean {
    const row = this.engine.store.write
      .query(`SELECT json_extract(data, '$.disabled') AS disabled FROM _users WHERE _id = ?`)
      .get(userId) as { disabled: unknown } | null;
    return !!row?.disabled;
  }

  async changePassword(userId: string, input: unknown) {
    const { currentPassword, newPassword } = this.parse(
      z.object({ currentPassword: z.string(), newPassword: credentials.shape.password }),
      input,
    );
    const wrong = () => new IncibaseError({ code: "INVALID_CREDENTIALS", message: "Current password is wrong" });
    // One slot for the check and the new hash: they run one after the other, so they never need two.
    // The current hash is read in the slot, so a change that committed during the wait counts.
    const { current, hash } = await this.hashing.run(async () => {
      const current = this.passwordHash(userId);
      if (!current || !(await Bun.password.verify(currentPassword, current))) throw wrong();
      return { current, hash: await Bun.password.hash(newPassword) };
    });
    // Replaces only the hash that was checked: when another change committed meanwhile,
    // the current password given here is no longer the current one.
    const token = await this.engine.writeTx((session) => {
      const { changes } = session.conn
        .query(`UPDATE _passwords SET hash = ? WHERE user_id = ? AND hash = ?`)
        .run(hash, userId, current);
      if (!changes) throw wrong();
      this.revokeIn(session, userId);
      return this.insertSession(session, userId);
    });
    return this.sessionResult(userId, token);
  }

  private passwordHash(userId: string): string | null {
    const row = this.engine.store.write.query(`SELECT hash FROM _passwords WHERE user_id = ?`).get(userId) as {
      hash: string;
    } | null;
    return row?.hash ?? null;
  }

  async getUser(userId: string) {
    return (await this.engine.readTx((s) => s.get(userId))).result;
  }

  private findUserId(email: string): string | null {
    // The write connection sees the latest committed (and in-transaction) state.
    const row = this.engine.store.write
      .query(`SELECT _id FROM _users WHERE json_extract(data, '$.email') = ?`)
      .get(email) as { _id: string } | null;
    return row?._id ?? null;
  }

  /**
   * Opens a session for a user whose password matched `checkedHash`. The
   * password check awaits (and may have waited for a slot), so the session is
   * only written if that hash is still the user's and the user is not
   * disabled: a password change, deletion or disable that committed meanwhile
   * wins, and the sign-in fails as with a wrong password.
   */
  private async createSession(userId: string, checkedHash: string): Promise<AuthResult> {
    const token = await this.engine.writeTx((session) => {
      if (this.passwordHash(userId) !== checkedHash || this.isDisabled(userId)) throw invalidCredentials();
      return this.insertSession(session, userId);
    });
    return this.sessionResult(userId, token);
  }

  /** Inserts a new session for `userId` in `session`'s transaction; returns its token. */
  private insertSession(session: DbSession, userId: string): string {
    const token = `ik_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const now = Date.now();
    session.conn.query(`DELETE FROM _sessions WHERE expires_at < ?`).run(now);
    session.conn
      .query(`INSERT INTO _sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .run(sha256(token), userId, now, now + SESSION_TTL_MS);
    return token;
  }

  private async sessionResult(userId: string, token: string): Promise<AuthResult> {
    const user = (await this.getUser(userId)) as AuthResult["user"];
    return { token, user };
  }

  /**
   * Resolves an `Authorization: Bearer <token>` value. The admin key yields an
   * admin identity and a service key a service one; `asUser` lets an admin,
   * or a service key with the `impersonate` scope, act as a given user.
   */
  identify(token: unknown, asUser?: string | null): Identity {
    return this.authenticate(token, asUser).identity;
  }

  identifyRequest(req: Request): Identity {
    return this.authenticateRequest(req).identity;
  }

  /**
   * Throws (401) for a credential `surface` does not take: the admin key on
   * the public listener, a service key on the admin listener. Listeners check
   * each request's bearer with it, and `authenticate` in-band tokens.
   */
  assertAccepted(token: unknown, surface: Surface = "combined") {
    if (surface === "combined" || typeof token !== "string" || !token) return;
    const admin = safeEqual(token, this.engine.adminKey);
    if (surface === "public" && admin) {
      throw new IncibaseError({ code: "UNAUTHENTICATED", message: "The admin key is not accepted here; use the admin socket" });
    }
    if (surface === "admin" && !admin && token.startsWith(SERVICE_KEY_PREFIX)) {
      throw new IncibaseError({ code: "UNAUTHENTICATED", message: "Service keys are not accepted on the admin socket; use the admin key" });
    }
  }

  /**
   * Like `identify`, plus the session a user identity came from (null for
   * anonymous, admin and service callers). `surface` is the listener the
   * token came in on (see `assertAccepted`).
   */
  authenticate(token: unknown, asUser?: string | null, surface: Surface = "combined"): { identity: Identity; session: SessionRef | null } {
    // Tokens arrive from untrusted JSON too (WebSocket auth); anything but a string is anonymous.
    if (typeof token !== "string" || !token) return { identity: ANONYMOUS, session: null };
    this.assertAccepted(token, surface);
    if (safeEqual(token, this.engine.adminKey)) {
      const userId = asUser && this.engine.store.tableOfId(asUser)?.name === "_users" ? asUser : null;
      return { identity: { userId, admin: true }, session: null };
    }
    const service = token.startsWith(SERVICE_KEY_PREFIX) ? this.engine.options.serviceKeys?.match(token) : null;
    if (service) {
      if (asUser && !service.scopes.includes("impersonate")) {
        throw new IncibaseError({
          code: "FORBIDDEN",
          message: `x-incibase-as-user needs a service key with the impersonate scope; "${service.keyId}" does not have it`,
        });
      }
      const userId = asUser && this.engine.store.tableOfId(asUser)?.name === "_users" ? asUser : null;
      return { identity: { userId, admin: false, service }, session: null };
    }
    // An unknown or revoked service key finds no session either: anonymous, like an expired session token.
    const session = this.activeSession(sha256(token));
    return session ? { identity: { userId: session.userId, admin: false }, session } : { identity: ANONYMOUS, session: null };
  }

  authenticateRequest(req: Request) {
    const header = req.headers.get("authorization");
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    return this.authenticate(token, req.headers.get("x-incibase-as-user"));
  }

  /** The session for a token hash if it is unexpired and its user exists and is not disabled. */
  activeSession(tokenHash: string, now = Date.now()): SessionRef | null {
    const row = this.engine.store.write
      .query(
        `SELECT s.user_id, s.expires_at, json_extract(u.data, '$.disabled') AS disabled
         FROM _sessions s JOIN _users u ON u._id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as { user_id: string; expires_at: number; disabled: unknown } | null;
    if (!row || row.expires_at < now || row.disabled) return null;
    return { tokenHash, userId: row.user_id, expiresAt: row.expires_at };
  }
}

let dummyHash: Promise<string> | null = null;

const invalidCredentials = () => new IncibaseError({ code: "INVALID_CREDENTIALS", message: "Invalid email or password" });
