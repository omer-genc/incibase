import type { ServerWebSocket } from "bun";
import type { Engine, Identity } from "./engine.ts";
import { ANONYMOUS, toErrorPayload } from "./engine.ts";

export interface SocketData {
  identity: Identity;
  /** Client subscription id → shared subscription key. */
  subs: Map<string, string>;
}

type ClientMessage =
  | { type: "auth"; token?: string | null }
  | { type: "sub"; id: string; path: string; args?: unknown }
  | { type: "unsub"; id: string };

interface SharedSubscription {
  key: string;
  path: string;
  args: unknown;
  identity: Identity;
  clients: Map<ServerWebSocket<SocketData>, Set<string>>;
  readTables: Set<string>;
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
  private flushScheduled = false;
  private stopped = false;

  constructor(private readonly engine: Engine) {}

  stop() {
    this.stopped = true;
  }

  get subscriptionCount() {
    return this.subs.size;
  }

  open(ws: ServerWebSocket<SocketData>) {
    ws.data.subs ??= new Map();
    ws.data.identity ??= ANONYMOUS;
  }

  close(ws: ServerWebSocket<SocketData>) {
    for (const [clientId, key] of ws.data.subs) this.detach(ws, clientId, key);
    ws.data.subs.clear();
  }

  message(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: { code: "BAD_MESSAGE", message: "Invalid JSON" } }));
      return;
    }
    switch (msg.type) {
      case "auth": {
        ws.data.identity = this.engine.auth.identify(msg.token ?? null);
        ws.send(JSON.stringify({ type: "auth", userId: ws.data.identity.userId }));
        // Re-key every subscription of this socket under the new identity.
        const current = [...ws.data.subs.entries()].map(([id, key]) => ({ id, sub: this.subs.get(key) }));
        for (const { id, sub } of current) {
          if (sub) this.subscribe(ws, id, sub.path, sub.args);
        }
        break;
      }
      case "sub":
        if (typeof msg.id !== "string" || typeof msg.path !== "string") return;
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

  private subscribe(ws: ServerWebSocket<SocketData>, clientId: string, path: string, args: unknown) {
    const identity = ws.data.identity;
    const key = JSON.stringify([path, args, identity.userId, identity.admin]);
    const previous = ws.data.subs.get(clientId);
    if (previous === key) return;
    if (previous) this.detach(ws, clientId, previous);
    ws.data.subs.set(clientId, key);

    let sub = this.subs.get(key);
    if (!sub) {
      sub = { key, path, args, identity, clients: new Map(), readTables: new Set(), last: null, dirty: true, running: false };
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
        sub.dirty = false;
        let body: string;
        try {
          const { value, readTables } = await this.engine.callTracked(sub.path, sub.args, sub.identity, {
            expectType: "query",
            allowInternal: sub.identity.admin,
          });
          sub.readTables = readTables;
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

  invalidate(tables: Set<string>) {
    let any = false;
    for (const sub of this.subs.values()) {
      if (sub.dirty) continue;
      for (const t of sub.readTables) {
        if (tables.has(t)) {
          sub.dirty = true;
          any = true;
          break;
        }
      }
    }
    if (any && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        for (const sub of this.subs.values()) if (sub.dirty) void this.run(sub);
      });
    }
  }
}
