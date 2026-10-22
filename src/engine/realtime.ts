import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { SessionRef } from "./auth.ts";
import type { Engine, Identity } from "./engine.ts";
import { ANONYMOUS, toErrorPayload } from "./engine.ts";
import { affects, type Change, type ReadSet } from "./readset.ts";

/** Commits within this window are coalesced into one rerun per affected subscription. */
const BATCH_MS = 10;
/** Live subscriptions one socket may hold. */
export const MAX_SUBSCRIPTIONS_PER_SOCKET = 256;
/** Default for `SocketData.maxSubscriptionBytes`. */
export const DEFAULT_SUBSCRIPTION_BYTES_PER_SOCKET = 1024 * 1024;
/** How often sockets' sessions are rechecked against the database (expiry, revocation elsewhere). */
const SESSION_SWEEP_MS = 60_000;

export interface SocketData {
  identity: Identity;
  /** The session `identity` came from; revoking or expiring it downgrades the socket to anonymous. */
  session?: SessionRef | null;
  /** Client subscription id → shared subscription key. */
  subs: Map<string, string>;
  /**
   * Most JSON characters the socket's subscription keys (function path, args,
   * user) may add up to, since each subscription keeps its args. The server
   * passes its message size limit. Signing in may go a little over: it never
   * drops a subscription.
   */
  maxSubscriptionBytes?: number;
}

const clientId = z.string().max(256);
const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().nullish() }),
  z.object({ type: z.literal("sub"), id: clientId, path: z.string().max(512), args: z.unknown().optional() }),
  z.object({ type: z.literal("unsub"), id: clientId }),
]);

interface SharedSubscription {
  key: string;
  path: string;
  args: unknown;
  identity: Identity;
  clients: Map<ServerWebSocket<SocketData>, Set<string>>;
  reads: ReadSet[];
  /** Tables in `reads`, for a cheap first check. */
  tables: Set<string>;
  /** Times the query ran (initial run + reruns). */
  runs: number;
  /** Changes committed while the query was running; checked against its new reads afterwards. */
  pending: Change[];
  /** Last message body sent, to skip unchanged results. */
  last: string | null;
  dirty: boolean;
  running: boolean;
}

/**
 * Query subscriptions over WebSocket. Identical subscriptions (same function,
 * args and user) share one execution. After each commit, subscriptions that
 * read a written table are re-run and pushed only if the result changed.
 */
export class Realtime {
  private readonly subs = new Map<string, SharedSubscription>();
  private readonly sockets = new Set<ServerWebSocket<SocketData>>();
  private readonly sweep: Timer;
  private flushScheduled = false;
  private stopped = false;

  constructor(private readonly engine: Engine) {
    this.sweep = setInterval(() => this.sweepSessions(), SESSION_SWEEP_MS);
    this.sweep.unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.sweep);
  }

  get subscriptionCount() {
    return this.subs.size;
  }

  open(ws: ServerWebSocket<SocketData>) {
    ws.data.subs ??= new Map();
    ws.data.identity ??= ANONYMOUS;
    this.sockets.add(ws);
  }

  close(ws: ServerWebSocket<SocketData>) {
    this.sockets.delete(ws);
    for (const [clientId, key] of ws.data.subs) this.detach(ws, clientId, key);
    ws.data.subs.clear();
  }

  /** Handles one client message. Never throws: a bad message gets an error reply, not a crash. */
  message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    try {
      this.handle(ws, raw);
    } catch (err) {
      const { error } = toErrorPayload(err, !!this.engine.options.dev);
      ws.send(JSON.stringify({ type: "error", error }));
    }
  }

  private handle(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: { code: "BAD_MESSAGE", message: "Invalid JSON" } }));
      return;
    }
    const parsed = clientMessage.safeParse(json);
    if (!parsed.success) {
      const message = `Expected {type:"auth",token}, {type:"sub",id,path,args} or {type:"unsub",id}`;
      ws.send(JSON.stringify({ type: "error", error: { code: "BAD_MESSAGE", message } }));
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case "auth": {
        const { identity, session } = this.engine.auth.authenticate(msg.token ?? null);
        this.setIdentity(ws, identity, session);
        break;
      }
      case "sub":
        this.dropExpired([ws]);
        this.subscribe(ws, msg.id, msg.path, msg.args ?? {});
        break;
      case "unsub": {
        const key = ws.data.subs.get(msg.id);
        if (key) this.detach(ws, msg.id, key);
        ws.data.subs.delete(msg.id);
        break;
      }
    }
  }

  /** Switches a socket to another identity and re-keys its subscriptions, which rerun as that identity. */
  private setIdentity(ws: ServerWebSocket<SocketData>, identity: Identity, session: SessionRef | null) {
    ws.data.identity = identity;
    ws.data.session = session;
    ws.send(JSON.stringify({ type: "auth", userId: identity.userId }));
    const current = [...ws.data.subs.entries()].map(([id, key]) => ({ id, sub: this.subs.get(key) }));
    for (const { id, sub } of current) {
      // Only the user part of each key changes, so this skips the size budget.
      if (sub) this.subscribe(ws, id, sub.path, sub.args, { rekey: true });
    }
  }

  /** Signs out sockets whose session matches, e.g. after sign-out, revocation or a password change. */
  revokeSessions(match: (session: SessionRef) => boolean) {
    for (const ws of [...this.sockets]) {
      if (ws.data.session && match(ws.data.session)) this.setIdentity(ws, ANONYMOUS, null);
    }
  }

  /** Signs out sockets whose session expired since they authenticated. */
  private dropExpired(sockets: Iterable<ServerWebSocket<SocketData>>, now = Date.now()) {
    for (const ws of [...sockets]) {
      if (ws.data.session && ws.data.session.expiresAt < now) this.setIdentity(ws, ANONYMOUS, null);
    }
  }

  /** Rechecks every socket's session in the database: expired, deleted or disabled users are signed out. */
  sweepSessions(now = Date.now()) {
    try {
      for (const ws of [...this.sockets]) {
        const session = ws.data.session;
        if (session && !this.engine.auth.activeSession(session.tokenHash, now)) this.setIdentity(ws, ANONYMOUS, null);
      }
    } catch (err) {
      console.error("[incibase] session sweep failed:", err);
    }
  }

  private subscribe(ws: ServerWebSocket<SocketData>, clientId: string, path: string, args: unknown, { rekey = false } = {}) {
    const identity = ws.data.identity;
    const key = JSON.stringify([path, args, identity.userId, identity.admin]);
    const previous = ws.data.subs.get(clientId);
    if (previous === key) return;
    if (!previous && ws.data.subs.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
      const message = `A connection can hold at most ${MAX_SUBSCRIPTIONS_PER_SOCKET} subscriptions`;
      ws.send(JSON.stringify({ id: clientId, type: "error", error: { code: "TOO_MANY_SUBSCRIPTIONS", message } }));
      return;
    }
    if (!rekey) {
      // The count alone does not bound memory: every subscription keeps its args, failed ones too.
      const budget = ws.data.maxSubscriptionBytes ?? DEFAULT_SUBSCRIPTION_BYTES_PER_SOCKET;
      let held = key.length - (previous?.length ?? 0);
      for (const k of ws.data.subs.values()) held += k.length;
      if (held > budget) {
        // A replaced subscription goes too, so the id does not keep pushing results for its old args.
        if (previous) this.detach(ws, clientId, previous);
        ws.data.subs.delete(clientId);
        const message = `A connection's subscriptions can hold at most ${budget} bytes of function paths and args`;
        ws.send(JSON.stringify({ id: clientId, type: "error", error: { code: "SUBSCRIPTIONS_TOO_LARGE", message } }));
        return;
      }
    }
    if (previous) this.detach(ws, clientId, previous);
    ws.data.subs.set(clientId, key);

    let sub = this.subs.get(key);
    if (!sub) {
      sub = { key, path, args, identity, clients: new Map(), reads: [], tables: new Set(), runs: 0, pending: [], last: null, dirty: true, running: false };
      this.subs.set(key, sub);
    }
    let ids = sub.clients.get(ws);
    if (!ids) sub.clients.set(ws, (ids = new Set()));
    ids.add(clientId);

    // A result already computed goes out now; a rerun in flight pushes only if it changes.
    if (sub.last !== null) this.sendTo(ws, clientId, sub.last);
    if (sub.last === null || sub.dirty) void this.run(sub);
  }

  private detach(ws: ServerWebSocket<SocketData>, clientId: string, key: string) {
    const sub = this.subs.get(key);
    if (!sub) return;
    const ids = sub.clients.get(ws);
    ids?.delete(clientId);
    if (ids && ids.size === 0) sub.clients.delete(ws);
    if (sub.clients.size === 0) this.subs.delete(key);
  }

  private sendTo(ws: ServerWebSocket<SocketData>, clientId: string, body: string) {
    // body is `"type":...,"value":...` without braces/id, so one serialization serves all clients.
    ws.send(`{"id":${JSON.stringify(clientId)},${body}}`);
  }

  private async run(sub: SharedSubscription) {
    if (sub.running) {
      sub.dirty = true;
      return;
    }
    sub.running = true;
    try {
      do {
        // Sockets whose session expired leave for an anonymous subscription before this reruns.
        if (sub.identity.userId && !sub.identity.admin) this.dropExpired(sub.clients.keys());
        if (this.stopped || !this.subs.has(sub.key)) return;
        sub.dirty = false;
        sub.pending = [];
        let body: string;
        try {
          sub.runs++;
          const { value, reads } = await this.engine.callTracked(sub.path, sub.args, sub.identity, {
            expectType: "query",
            allowInternal: sub.identity.admin,
          });
          sub.reads = reads;
          sub.tables = new Set(reads.map((r) => r.table));
          // A write that landed mid-run may or may not be in this result; rerun if it could matter.
          if (sub.pending.some((change) => reads.some((read) => affects(read, change)))) sub.dirty = true;
          body = `"type":"data","value":${JSON.stringify(value)}`;
        } catch (err) {
          const { error } = toErrorPayload(err, !!this.engine.options.dev);
          body = `"type":"error","error":${JSON.stringify(error)}`;
        }
        if (this.stopped || !this.subs.has(sub.key)) return;
        if (body !== sub.last) {
          sub.last = body;
          for (const [ws, ids] of sub.clients) for (const id of ids) this.sendTo(ws, id, body);
        }
      } while (sub.dirty);
    } finally {
      sub.running = false;
    }
  }

  /** Marks subscriptions whose reads a committed change can affect, and reruns them shortly after. */
  invalidate(changes: Change[]) {
    const tables = new Set(changes.map((c) => c.table));
    let any = false;
    for (const sub of this.subs.values()) {
      if (sub.running) {
        sub.pending.push(...changes);
        continue;
      }
      if (sub.dirty) continue;
      let hit = false;
      for (const table of sub.tables) if (tables.has(table)) hit = true;
      if (!hit) continue;
      if (sub.reads.some((read) => changes.some((change) => affects(read, change)))) {
        sub.dirty = true;
        any = true;
      }
    }
    if (any && !this.flushScheduled) {
      this.flushScheduled = true;
      setTimeout(() => {
        this.flushScheduled = false;
        for (const sub of this.subs.values()) if (sub.dirty && !sub.running) void this.run(sub);
      }, BATCH_MS);
    }
  }

  /** Per-subscription run counts, for diagnostics and tests. */
  stats() {
    return [...this.subs.values()].map((s) => ({ path: s.path, args: s.args, clients: s.clients.size, runs: s.runs }));
  }
}
