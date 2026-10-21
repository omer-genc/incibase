import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { IncibaseError } from "../errors.ts";
import { ValidationError } from "./database.ts";
import type { Engine, Identity } from "./engine.ts";
import { ANONYMOUS } from "./engine.ts";

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

/** Email/password accounts in `_users`, opaque bearer session tokens stored hashed in `_sessions`. */
export class AuthService {
  constructor(private readonly engine: Engine) {}

  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) throw new ValidationError(z.prettifyError(result.error), result.error.issues);
    return result.data;
  }

  async signUp(input: unknown): Promise<AuthResult> {
    const { email, password, name } = this.parse(signUpInput, input);
    const hash = await Bun.password.hash(password);
    const userId = await this.engine.writeTx((session) => {
      const users = session.systemTable("_users");
      if (this.findUserId(email)) throw new IncibaseError({ code: "EMAIL_TAKEN", message: "Email is already registered" });
      const id = session.insertRaw(users, JSON.stringify({ email, ...(name ? { name } : {}), emailVerified: false }));
      session.conn.query(`INSERT INTO _passwords (user_id, hash) VALUES (?, ?)`).run(id, hash);
      return id;
    });
    return this.createSession(userId);
  }

  async signIn(input: unknown): Promise<AuthResult> {
    const { email, password } = this.parse(credentials, input);
    const userId = this.findUserId(email);
    const row = userId
      ? (this.engine.store.write.query(`SELECT hash FROM _passwords WHERE user_id = ?`).get(userId) as { hash: string } | null)
      : null;
    // Verify against a dummy hash when the user is unknown so timing does not reveal it.
    const ok = await Bun.password.verify(password, row?.hash ?? (await (dummyHash ??= Bun.password.hash("incibase-dummy-password"))));
    if (!userId || !row || !ok) {
      throw new IncibaseError({ code: "INVALID_CREDENTIALS", message: "Invalid email or password" });
    }
    return this.createSession(userId);
  }

  async signOut(token: string) {
    await this.engine.writeTx((session) => {
      session.conn.query(`DELETE FROM _sessions WHERE token_hash = ?`).run(sha256(token));
    });
  }

  /** Revokes all sessions of a user, e.g. after a password change. */
  async revokeAll(userId: string) {
    await this.engine.writeTx((session) => {
      session.conn.query(`DELETE FROM _sessions WHERE user_id = ?`).run(userId);
    });
  }

  async changePassword(userId: string, input: unknown) {
    const { currentPassword, newPassword } = this.parse(
      z.object({ currentPassword: z.string(), newPassword: credentials.shape.password }),
      input,
    );
    const row = this.engine.store.write.query(`SELECT hash FROM _passwords WHERE user_id = ?`).get(userId) as {
      hash: string;
    } | null;
    if (!row || !(await Bun.password.verify(currentPassword, row.hash))) {
      throw new IncibaseError({ code: "INVALID_CREDENTIALS", message: "Current password is wrong" });
    }
    const hash = await Bun.password.hash(newPassword);
    await this.engine.writeTx((session) => {
      session.conn.query(`UPDATE _passwords SET hash = ? WHERE user_id = ?`).run(hash, userId);
      session.conn.query(`DELETE FROM _sessions WHERE user_id = ?`).run(userId);
    });
    return this.createSession(userId);
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

  private async createSession(userId: string): Promise<AuthResult> {
    const token = `ik_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const now = Date.now();
    await this.engine.writeTx((session) => {
      session.conn.query(`DELETE FROM _sessions WHERE expires_at < ?`).run(now);
      session.conn
        .query(`INSERT INTO _sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
        .run(sha256(token), userId, now, now + SESSION_TTL_MS);
    });
    const user = (await this.getUser(userId)) as AuthResult["user"];
    return { token, user };
  }

  /**
   * Resolves an `Authorization: Bearer <token>` value. The admin key yields an
   * admin identity; `asUser` lets an admin act as a given user.
   */
  identify(token: string | null | undefined, asUser?: string | null): Identity {
    if (!token) return ANONYMOUS;
    if (safeEqual(token, this.engine.adminKey)) {
      const userId = asUser && this.engine.store.tableOfId(asUser)?.name === "_users" ? asUser : null;
      return { userId, admin: true };
    }
    const row = this.engine.store.write
      .query(`SELECT user_id, expires_at FROM _sessions WHERE token_hash = ?`)
      .get(sha256(token)) as { user_id: string; expires_at: number } | null;
    if (!row || row.expires_at < Date.now()) return ANONYMOUS;
    return { userId: row.user_id, admin: false };
  }

  identifyRequest(req: Request): Identity {
    const header = req.headers.get("authorization");
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    return this.identify(token, req.headers.get("x-incibase-as-user"));
  }
}

let dummyHash: Promise<string> | null = null;
