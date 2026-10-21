"use client";
// React bindings (`incibase/react`). Live queries go through the client's
// shared watch cache, so components asking for the same query share one
// subscription and remounts render the cached result immediately.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getFunctionPath, type FunctionReference, type OptionalArgs } from "./api.ts";
import type { AuthUser, IncibaseClient, QueryState, QueryWatch } from "./client.ts";
import type { PaginationOptions } from "./values.ts";

const ClientContext = createContext<IncibaseClient | null>(null);
const AuthContext = createContext<AuthState | null>(null);

export interface AuthState {
  /** `undefined` while the session is being checked. */
  user: AuthUser | null | undefined;
  isLoading: boolean;
  isAuthenticated: boolean;
  signUp: IncibaseClient["auth"]["signUp"];
  signIn: IncibaseClient["auth"]["signIn"];
  signOut: IncibaseClient["auth"]["signOut"];
}

export function IncibaseProvider({ client, children }: { client: IncibaseClient; children?: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);

  useEffect(() => {
    let current = 0;
    const refresh = (token: string | null) => {
      const request = ++current;
      if (!token) return setUser(null);
      setUser(undefined);
      client.auth.me().then(
        (me) => request === current && setUser(me),
        () => request === current && setUser(null),
      );
    };
    refresh(client.getToken());
    const off = client.onAuthChange(refresh);
    return () => {
      current++;
      off();
    };
  }, [client]);

  const auth = useMemo<AuthState>(
    () => ({
      user,
      isLoading: user === undefined,
      isAuthenticated: !!user,
      signUp: client.auth.signUp,
      signIn: client.auth.signIn,
      signOut: client.auth.signOut,
    }),
    [client, user],
  );

  return createElement(ClientContext.Provider, { value: client }, createElement(AuthContext.Provider, { value: auth }, children));
}

export function useIncibase(): IncibaseClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("Wrap your app in <IncibaseProvider client={...}>");
  return client;
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("Wrap your app in <IncibaseProvider client={...}>");
  return auth;
}

// ---------------------------------------------------------------------------
// Queries

/** Args for a query hook: the function's args, or `"skip"` to not run it. */
export type QueryArgs<F extends FunctionReference> = {} extends F["_args"]
  ? [args?: F["_args"] | "skip"]
  : [args: F["_args"] | "skip"];

export interface QueryResult<T> {
  /** `undefined` while loading, after an error, or when skipped. */
  data: T | undefined;
  error: Error | undefined;
  isLoading: boolean;
}

const SKIPPED: QueryState = { status: "loading", value: undefined, error: undefined };
const noop = () => {};

function useWatch<F extends FunctionReference<"query">>(ref: F, args: F["_args"] | "skip" | undefined) {
  const client = useIncibase();
  const skip = args === "skip";
  const key = skip ? null : JSON.stringify([getFunctionPath(ref), args ?? {}]);
  // `key` captures ref and args by value, so inline object args don't resubscribe.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const watch: QueryWatch<F["_returns"]> | null = useMemo(() => (skip ? null : client.watchQuery(ref, args)), [client, key]);
  const subscribe = useCallback((listener: () => void) => (watch ? watch.subscribe(listener) : noop), [watch]);
  const getSnapshot = useCallback(() => (watch ? watch.getState() : SKIPPED) as QueryState<F["_returns"]>, [watch]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { state, skip };
}

/** Live query state without throwing: `{ data, error, isLoading }`. */
export function useQueryResult<F extends FunctionReference<"query">>(ref: F, ...args: QueryArgs<F>): QueryResult<F["_returns"]> {
  const { state, skip } = useWatch(ref, args[0]);
  return { data: state.value, error: state.error, isLoading: !skip && state.status === "loading" };
}

/**
 * Live query result: `undefined` while loading (or skipped), then the latest
 * value, updated whenever it changes on the server. Errors are thrown to the
 * nearest error boundary; use `useQueryResult` to handle them inline.
 */
export function useQuery<F extends FunctionReference<"query">>(ref: F, ...args: QueryArgs<F>): F["_returns"] | undefined {
  const { state } = useWatch(ref, args[0]);
  if (state.status === "error") throw state.error;
  return state.value;
}

// ---------------------------------------------------------------------------
// Mutations and actions

export function useMutation<F extends FunctionReference<"mutation">>(ref: F): (...args: OptionalArgs<F>) => Promise<F["_returns"]> {
  const client = useIncibase();
  const path = getFunctionPath(ref);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((...args: OptionalArgs<F>) => client.mutation(ref, ...args), [client, path]);
}

export function useAction<F extends FunctionReference<"action">>(ref: F): (...args: OptionalArgs<F>) => Promise<F["_returns"]> {
  const client = useIncibase();
  const path = getFunctionPath(ref);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((...args: OptionalArgs<F>) => client.action(ref, ...args), [client, path]);
}

// ---------------------------------------------------------------------------
// Pagination

export interface PaginationPage<T> {
  page: T[];
  continueCursor: string;
  isDone: boolean;
}

/** A query whose args include `paginationOpts` (see `paginationOptsValidator`). */
export type PaginatedQueryReference = FunctionReference<
  "query",
  "public",
  { paginationOpts: PaginationOptions },
  PaginationPage<any>
>;

type PageItem<F extends PaginatedQueryReference> = F["_returns"]["page"][number];
type ArgsWithoutPagination<F extends PaginatedQueryReference> = Omit<F["_args"], "paginationOpts">;

export type PaginationStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

export interface PaginatedQueryResult<T> {
  results: T[];
  status: PaginationStatus;
  isLoading: boolean;
  /** Requests `numItems` more; returns false when nothing more can be loaded right now. */
  loadMore: (numItems: number) => boolean;
}

interface PaginatedSnapshot {
  results: unknown[];
  status: PaginationStatus;
  error: Error | undefined;
  states: QueryState[];
}

/**
 * Pages are live queries chained by cursor: page n+1 starts at page n's
 * current `continueCursor`, so when a page grows or shrinks the next one
 * follows it and nothing is skipped or shown twice.
 */
class PaginatedStore {
  private readonly sizes: number[];
  private pages: { watch: QueryWatch<PaginationPage<unknown>>; cursor: string | null; stop: () => void }[] = [];
  private readonly listeners = new Set<() => void>();
  private snapshot: PaginatedSnapshot = { results: [], status: "LoadingFirstPage", error: undefined, states: [] };

  constructor(
    private readonly client: IncibaseClient,
    private readonly ref: PaginatedQueryReference,
    private readonly args: Record<string, unknown>,
    initialNumItems: number,
  ) {
    this.sizes = [initialNumItems];
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.sync();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        for (const p of this.pages) p.stop();
        this.pages = [];
      }
    };
  };

  getSnapshot = () => this.snapshot;

  loadMore = (numItems: number): boolean => {
    if (this.snapshot.status !== "CanLoadMore") return false;
    this.sizes.push(numItems);
    this.sync();
    return true;
  };

  private sync = () => {
    if (this.listeners.size === 0) return;
    let cursor: string | null = null;
    let count = 0;
    for (let i = 0; i < this.sizes.length; i++) {
      if (i > 0) {
        const prev = this.pages[i - 1]!.watch.getState();
        if (prev.status !== "success" || prev.value.isDone) break;
        cursor = prev.value.continueCursor;
      }
      const existing = this.pages[i];
      if (!existing || existing.cursor !== cursor) {
        existing?.stop();
        const watch = this.client.watchQuery(this.ref, {
          ...this.args,
          paginationOpts: { cursor, numItems: this.sizes[i]! },
        }) as QueryWatch<PaginationPage<unknown>>;
        this.pages[i] = { watch, cursor, stop: watch.subscribe(this.sync) };
      }
      count = i + 1;
    }
    for (const p of this.pages.splice(count)) p.stop();
    this.publish();
  };

  private publish() {
    const states = this.pages.map((p) => p.watch.getState());
    const prev = this.snapshot;
    if (states.length === prev.states.length && states.every((s, i) => s === prev.states[i]) && prev.states.length > 0) {
      return;
    }
    const error = states.find((s) => s.status === "error")?.error;
    const results: unknown[] = [];
    for (const s of states) if (s.status === "success") results.push(...s.value.page);
    const last = states.at(-1);
    let status: PaginationStatus;
    if (!states[0] || states[0].status !== "success") status = "LoadingFirstPage";
    else if (states.some((s) => s.status === "loading")) status = "LoadingMore";
    else if (last?.status === "success" && last.value.isDone) status = "Exhausted";
    else if (states.length < this.sizes.length) status = "LoadingMore";
    else status = "CanLoadMore";
    this.snapshot = { results, status, error, states };
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Infinite list over a paginated query. The query must accept
 * `paginationOpts` and return `ctx.db.query(...).paginate(paginationOpts)`.
 */
export function usePaginatedQuery<F extends PaginatedQueryReference>(
  ref: F,
  args: ArgsWithoutPagination<F> | "skip",
  options: { initialNumItems: number },
): PaginatedQueryResult<PageItem<F>> {
  const client = useIncibase();
  const skip = args === "skip";
  const key = skip ? null : JSON.stringify([getFunctionPath(ref), args, options.initialNumItems]);
  const store = useMemo(
    () => (skip ? null : new PaginatedStore(client, ref, args as Record<string, unknown>, options.initialNumItems)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, key],
  );
  const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : noop), [store]);
  const getSnapshot = useCallback(() => (store ? store.getSnapshot() : EMPTY_PAGES), [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (snapshot.error) throw snapshot.error;
  return {
    results: snapshot.results as PageItem<F>[],
    status: snapshot.status,
    isLoading: snapshot.status === "LoadingFirstPage" || snapshot.status === "LoadingMore",
    loadMore: store ? store.loadMore : () => false,
  };
}

const EMPTY_PAGES: PaginatedSnapshot = { results: [], status: "LoadingFirstPage", error: undefined, states: [] };
