// Browser/Bun/Node client (`incibase/client`). Uses only fetch and WebSocket.
import { getFunctionPath, type FunctionReference, type OptionalArgs } from "./api.ts";
import { IncibaseError } from "./errors.ts";
import type { Id } from "./values.ts";

export interface ErrorPayload {
  code: string;
  message: string;
  data?: unknown;
  /** Set when a function threw an IncibaseError. */
  application?: boolean;
}

/** Thrown for non-application failures (validation, auth, network, server errors). */
export class IncibaseRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "IncibaseRequestError";
  }
}

export interface TokenStorage {
  get(): string | null;
  set(token: string | null): void;
}

export interface AuthUser {
  _id: Id<"_users">;
  _creationTime: number;
  email: string;
  name?: string;
  emailVerified: boolean;
}

export interface ClientOptions {
  /** Where the session token is kept. Defaults to localStorage when available, else memory. */
  tokenStorage?: TokenStorage;
  /** Initial token, e.g. an admin key for server-to-server use. */
  token?: string;
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /**
   * How long a live query stays subscribed after its last listener leaves, so
   * navigating back shows the cached result at once. Default 5000 ms; 0 stops
   * it immediately.
   */
  keepAliveMs?: number;
}

function defaultStorage(): TokenStorage {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (ls) {
    return {
      get: () => ls.getItem("incibase:token"),
      set: (t) => (t ? ls.setItem("incibase:token", t) : ls.removeItem("incibase:token")),
    };
  }
  let token: string | null = null;
  return { get: () => token, set: (t) => void (token = t) };
}

function toError(status: number, error: ErrorPayload | undefined): Error {
  if (error?.application) return new IncibaseError(error.data);
  return new IncibaseRequestError(status, error?.code ?? "UNKNOWN", error?.message ?? `HTTP ${status}`, error?.data);
}

interface Subscription {
  path: string;
  args: unknown;
  onData: (value: any) => void;
  onError?: (err: Error) => void;
}

export type QueryState<T = unknown> =
  | { status: "loading"; value: undefined; error: undefined }
  | { status: "success"; value: T; error: undefined }
  | { status: "error"; value: undefined; error: Error };

/** A shared, cached live query. `getState()` returns the same object until the state changes. */
export interface QueryWatch<T = unknown> {
  getState(): QueryState<T>;
  /** Starts the subscription on the first listener; stops it a little after the last one leaves. */
  subscribe(listener: () => void): () => void;
}

interface WatchEntry {
  state: QueryState;
  listeners: Set<() => void>;
  stop: (() => void) | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const LOADING: QueryState = { status: "loading", value: undefined, error: undefined };
const DEFAULT_KEEP_ALIVE_MS = 5_000;

export class IncibaseClient {
  readonly url: string;
  private readonly tokenStorage: TokenStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly WS: typeof WebSocket;
  private readonly keepAliveMs: number;
  private readonly authListeners = new Set<(token: string | null) => void>();

  private ws: WebSocket | null = null;
  private wsOpen = false;
  private reconnectDelay = 250;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextSubId = 1;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly watches = new Map<string, WatchEntry>();
  /** Live query messages held back while a password change is in flight (see `auth.changePassword`). */
  private held: unknown[] | null = null;
  private closed = false;

  constructor(url: string, options: ClientOptions = {}) {
    this.url = url.replace(/\/+$/, "");
    this.tokenStorage = options.tokenStorage ?? defaultStorage();
    if (options.token) this.tokenStorage.set(options.token);
    this.fetchImpl = options.fetch ?? fetch.bind(globalThis);
    this.WS = options.WebSocket ?? WebSocket;
    this.keepAliveMs = Math.max(0, options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
  }

  // -------------------------------------------------------------------------
  // Calls

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    const token = this.tokenStorage.get();
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init.body && typeof init.body === "string") headers.set("content-type", "application/json");
    const res = await this.fetchImpl(`${this.url}${path}`, { ...init, headers });
    const body = (await res.json().catch(() => null)) as { error?: ErrorPayload } | null;
    if (!res.ok) throw toError(res.status, body?.error);
    return body as T;
  }

  private async call(kind: "query" | "mutation" | "action", ref: FunctionReference, args: unknown) {
    const { value } = await this.request<{ value: unknown }>(`/api/${kind}`, {
      method: "POST",
      body: JSON.stringify({ path: getFunctionPath(ref), args: args ?? {} }),
    });
    return value;
  }

  query<F extends FunctionReference<"query">>(ref: F, ...args: OptionalArgs<F>): Promise<F["_returns"]> {
    return this.call("query", ref, args[0]) as Promise<F["_returns"]>;
  }

  mutation<F extends FunctionReference<"mutation">>(ref: F, ...args: OptionalArgs<F>): Promise<F["_returns"]> {
    return this.call("mutation", ref, args[0]) as Promise<F["_returns"]>;
  }

  action<F extends FunctionReference<"action">>(ref: F, ...args: OptionalArgs<F>): Promise<F["_returns"]> {
    return this.call("action", ref, args[0]) as Promise<F["_returns"]>;
  }

  // -------------------------------------------------------------------------
  // Realtime

  /**
   * Runs a query now and again whenever its result changes. Returns an
   * unsubscribe function.
   */
  subscribe<F extends FunctionReference<"query">>(
    ref: F,
    args: F["_args"],
    onData: (value: F["_returns"]) => void,
    onError?: (err: Error) => void,
  ): () => void {
    const id = String(this.nextSubId++);
    this.subscriptions.set(id, { path: getFunctionPath(ref), args: args ?? {}, onData, onError });
    if (this.wsOpen) this.send({ type: "sub", id, path: getFunctionPath(ref), args: args ?? {} });
    else this.connect();
    return () => {
      if (!this.subscriptions.delete(id)) return;
      if (this.wsOpen) this.send({ type: "unsub", id });
    };
  }

  /**
   * A live query shared by every caller with the same function and args: one
   * server subscription, one cached result. Framework bindings build on this.
   */
  watchQuery<F extends FunctionReference<"query">>(ref: F, args?: F["_args"]): QueryWatch<F["_returns"]> {
    const path = getFunctionPath(ref);
    const key = JSON.stringify([path, args ?? {}]);
    const entry = (): WatchEntry => {
      let e = this.watches.get(key);
      if (!e) this.watches.set(key, (e = { state: LOADING, listeners: new Set(), stop: null, releaseTimer: null }));
      return e;
    };
    const update = (e: WatchEntry, state: QueryState) => {
      e.state = state;
      for (const listener of [...e.listeners]) listener();
    };
    return {
      getState: () => (this.watches.get(key)?.state ?? LOADING) as QueryState<F["_returns"]>,
      subscribe: (listener) => {
        const e = entry();
        e.listeners.add(listener);
        if (e.releaseTimer) {
          clearTimeout(e.releaseTimer);
          e.releaseTimer = null;
        }
        e.stop ??= this.subscribe(
          ref,
          args ?? {},
          (value) => update(e, { status: "success", value, error: undefined }),
          (error) => update(e, { status: "error", value: undefined, error }),
        );
        return () => {
          if (!e.listeners.delete(listener) || e.listeners.size > 0) return;
          const release = () => {
            e.releaseTimer = null;
            if (e.listeners.size > 0) return;
            e.stop?.();
            e.stop = null;
            if (this.watches.get(key) === e) this.watches.delete(key);
          };
          if (this.keepAliveMs === 0) release();
          else e.releaseTimer = setTimeout(release, this.keepAliveMs);
        };
      },
    };
  }

  private send(msg: unknown) {
    this.ws?.send(JSON.stringify(msg));
  }

  private connect() {
    if (this.ws || this.closed) return;
    const ws = new this.WS(`${this.url.replace(/^http/, "ws")}/api/ws`);
    this.ws = ws;
    // Handlers ignore a connection that `reconnect` replaced.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsOpen = true;
      this.reconnectDelay = 250;
      const token = this.tokenStorage.get();
      if (token) this.send({ type: "auth", token });
      for (const [id, sub] of this.subscriptions) this.send({ type: "sub", id, path: sub.path, args: sub.args });
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let msg: unknown;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (this.held) this.held.push(msg);
      else this.deliver(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsOpen = false;
      if (this.closed || this.subscriptions.size === 0) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    };
    ws.onerror = () => ws.close();
  }

  private deliver(msg: any) {
    const sub = msg?.id !== undefined ? this.subscriptions.get(msg.id) : undefined;
    if (!sub) return;
    if (msg.type === "data") sub.onData(msg.value);
    else if (msg.type === "error") sub.onError?.(toError(400, msg.error));
  }

  /** Replaces the connection: the new one signs in with the current token and resubscribes. */
  private reconnect() {
    const old = this.ws;
    this.ws = null;
    this.wsOpen = false;
    old?.close();
    if (this.subscriptions.size > 0) this.connect();
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const e of this.watches.values()) if (e.releaseTimer) clearTimeout(e.releaseTimer);
    this.watches.clear();
    this.subscriptions.clear();
    this.ws?.close();
    this.ws = null;
  }

  // -------------------------------------------------------------------------
  // Auth

  getToken(): string | null {
    return this.tokenStorage.get();
  }

  setToken(token: string | null) {
    this.tokenStorage.set(token);
    if (this.wsOpen) this.send({ type: "auth", token });
    for (const listener of this.authListeners) listener(token);
  }

  onAuthChange(listener: (token: string | null) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  readonly auth = {
    signUp: async (input: { email: string; password: string; name?: string }) => {
      const result = await this.request<{ token: string; user: AuthUser }>("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify(input),
      });
      this.setToken(result.token);
      return result.user;
    },
    signIn: async (input: { email: string; password: string }) => {
      const result = await this.request<{ token: string; user: AuthUser }>("/api/auth/signin", {
        method: "POST",
        body: JSON.stringify(input),
      });
      this.setToken(result.token);
      return result.user;
    },
    signOut: async () => {
      try {
        await this.request("/api/auth/signout", { method: "POST" });
      } finally {
        this.setToken(null);
      }
    },
    me: async () => (await this.request<{ user: AuthUser | null }>("/api/auth/me")).user,
    changePassword: async (input: { currentPassword: string; newPassword: string }) => {
      // The server ends every session of the user, this connection's too, before the new token
      // arrives. Live queries would rerun signed out meanwhile and push errors such as "Sign in
      // required", so their messages wait here; on success they are dropped and a new connection,
      // signed in with the new token, sends fresh results.
      const held = (this.held ??= []);
      let result: { token: string; user: AuthUser };
      try {
        result = await this.request<{ token: string; user: AuthUser }>("/api/auth/password", {
          method: "POST",
          body: JSON.stringify(input),
        });
      } catch (err) {
        // Nothing changed, so what was held is still current (unless another change replaced the connection).
        if (this.held === held) {
          this.held = null;
          for (const msg of held) this.deliver(msg);
        }
        throw err;
      }
      this.held = null;
      this.reconnect();
      // The new connection opens later and signs in with the token stored here.
      this.setToken(result.token);
      return result.user;
    },
  };

  // -------------------------------------------------------------------------
  // Storage

  readonly storage = {
    /** Uploads to a URL from `ctx.storage.generateUploadUrl()`. */
    upload: async (uploadUrl: string, file: Blob): Promise<Id<"_storage">> => {
      const res = await this.fetchImpl(uploadUrl, {
        method: "POST",
        body: file,
        headers: file.type ? { "content-type": file.type } : {},
      });
      const body = (await res.json().catch(() => null)) as { storageId?: Id<"_storage">; error?: ErrorPayload } | null;
      if (!res.ok || !body?.storageId) throw toError(res.status, body?.error);
      return body.storageId;
    },
  };
}
