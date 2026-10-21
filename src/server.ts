// Everything a backend module (`incibase/*.ts`) imports. Builders only create
// plain descriptor objects; the engine runs them.
import type { z } from "zod";
import { getFunctionPath } from "./api.ts";
import type {
  ArgsInput,
  ArgsOutput,
  ArgsValidator,
  FunctionReference,
  FunctionType,
  FunctionVisibility,
  McpToolOptions,
  OptionalArgs,
  RegisteredFunction,
} from "./api.ts";
import type { DocumentOf, GenericDataModel, SystemDataModel, WritableTableNames } from "./schema.ts";
import type { Id, PaginationOptions } from "./values.ts";

export * from "./index.ts";

// ---------------------------------------------------------------------------
// Database

type Primitive = string | number | boolean | null;

type FieldValue<Doc, F extends string> = F extends keyof Doc
  ? Doc[F]
  : F extends `${infer Head}.${infer Rest}`
    ? Head extends keyof Doc
      ? FieldValue<NonNullable<Doc[Head]>, Rest>
      : Primitive
    : Primitive;

export interface IndexRangeBuilder<Doc, Fields extends readonly string[]> {
  eq<F extends Fields[number] | "_creationTime">(field: F, value: FieldValue<Doc, F>): IndexRangeBuilder<Doc, Fields>;
  gt<F extends Fields[number] | "_creationTime">(field: F, value: FieldValue<Doc, F>): IndexRangeBuilder<Doc, Fields>;
  gte<F extends Fields[number] | "_creationTime">(field: F, value: FieldValue<Doc, F>): IndexRangeBuilder<Doc, Fields>;
  lt<F extends Fields[number] | "_creationTime">(field: F, value: FieldValue<Doc, F>): IndexRangeBuilder<Doc, Fields>;
  lte<F extends Fields[number] | "_creationTime">(field: F, value: FieldValue<Doc, F>): IndexRangeBuilder<Doc, Fields>;
}

export interface PaginationResult<Doc> {
  page: Doc[];
  continueCursor: string;
  isDone: boolean;
}

export interface Query<Doc> {
  /** Equality filter evaluated in SQL. Fields may be dotted paths. */
  where(fields: Partial<{ [K in keyof Doc]: Doc[K] & Primitive }> & Record<string, Primitive>): Query<Doc>;
  /** Arbitrary filter evaluated in JS after SQL. Prefer indexes for large tables. */
  filter(predicate: (doc: Doc) => boolean): Query<Doc>;
  order(order: "asc" | "desc"): Query<Doc>;
  collect(): Promise<Doc[]>;
  take(n: number): Promise<Doc[]>;
  first(): Promise<Doc | null>;
  /** Returns the only matching document, null if none, and throws if several match. */
  unique(): Promise<Doc | null>;
  paginate(options: PaginationOptions): Promise<PaginationResult<Doc>>;
  count(): Promise<number>;
}

export interface QueryInitializer<Doc, Indexes extends Record<string, readonly string[]>> extends Query<Doc> {
  withIndex<I extends keyof Indexes & string>(
    index: I,
    range?: (q: IndexRangeBuilder<Doc, Indexes[I]>) => IndexRangeBuilder<Doc, Indexes[I]>,
  ): Query<Doc>;
}

export interface DatabaseReader<DM extends GenericDataModel> {
  get<T extends keyof DM & string>(id: Id<T>): Promise<DocumentOf<DM, T> | null>;
  query<T extends keyof DM & string>(table: T): QueryInitializer<DocumentOf<DM, T>, DM[T]["indexes"]>;
  /** Returns the id typed for `table` when the string is an id of that table, else null. */
  normalizeId<T extends keyof DM & string>(table: T, id: string): Id<T> | null;
}

export interface DatabaseWriter<DM extends GenericDataModel> extends DatabaseReader<DM> {
  insert<T extends WritableTableNames<DM>>(table: T, value: DM[T]["insert"]): Promise<Id<T>>;
  /** Shallow merge. Fields set to `undefined` are removed. */
  patch<T extends WritableTableNames<DM>>(id: Id<T>, value: Partial<DM[T]["insert"]>): Promise<void>;
  replace<T extends WritableTableNames<DM>>(id: Id<T>, value: DM[T]["insert"]): Promise<void>;
  delete(id: Id<WritableTableNames<DM>>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Context

export type AuthUser = SystemDataModel["_users"]["document"];

export interface Auth {
  getUserId(): Promise<Id<"_users"> | null>;
  getUser(): Promise<AuthUser | null>;
  /** Like getUser but throws an `UNAUTHENTICATED` IncibaseError when signed out. */
  requireUser(): Promise<AuthUser>;
  /** True when the caller used the admin key. */
  readonly isAdmin: boolean;
}

export interface StorageReader {
  getUrl(id: Id<"_storage">): Promise<string | null>;
  getMetadata(id: Id<"_storage">): Promise<SystemDataModel["_storage"]["document"] | null>;
}

export interface StorageWriter extends StorageReader {
  /** A short-lived URL the client can POST a file body to. The response is `{ storageId }`. */
  generateUploadUrl(): Promise<string>;
  delete(id: Id<"_storage">): Promise<void>;
}

export interface StorageActionWriter extends StorageWriter {
  get(id: Id<"_storage">): Promise<Blob | null>;
  store(blob: Blob, options?: { contentType?: string }): Promise<Id<"_storage">>;
}

type SchedulableReference = FunctionReference<"mutation" | "action", FunctionVisibility>;

export interface Scheduler {
  runAfter<F extends SchedulableReference>(delayMs: number, fn: F, ...args: OptionalArgs<F>): Promise<Id<"_scheduled">>;
  runAt<F extends SchedulableReference>(
    timestamp: number | Date,
    fn: F,
    ...args: OptionalArgs<F>
  ): Promise<Id<"_scheduled">>;
  cancel(id: Id<"_scheduled">): Promise<void>;
}

export interface QueryCtx<DM extends GenericDataModel = GenericDataModel> {
  db: DatabaseReader<DM>;
  auth: Auth;
  storage: StorageReader;
}

export interface MutationCtx<DM extends GenericDataModel = GenericDataModel> {
  db: DatabaseWriter<DM>;
  auth: Auth;
  storage: StorageWriter;
  scheduler: Scheduler;
}

export interface ActionCtx {
  runQuery<F extends FunctionReference<"query">>(fn: F, ...args: OptionalArgs<F>): Promise<F["_returns"]>;
  runMutation<F extends FunctionReference<"mutation">>(fn: F, ...args: OptionalArgs<F>): Promise<F["_returns"]>;
  runAction<F extends FunctionReference<"action">>(fn: F, ...args: OptionalArgs<F>): Promise<F["_returns"]>;
  auth: Auth;
  storage: StorageActionWriter;
  scheduler: Scheduler;
}

// ---------------------------------------------------------------------------
// Builders

interface FunctionDefinition<Ctx, A extends ArgsValidator | undefined, R> {
  args?: A;
  /** Validates (and strips) the return value before it reaches the caller. */
  returns?: z.ZodType;
  description?: string;
  /** Expose as an MCP tool on `/mcp`. Only public functions can be exposed. */
  mcp?: boolean | McpToolOptions;
  handler: (ctx: Ctx, args: ArgsOutput<A>) => R | Promise<R>;
}

type Builder<Type extends FunctionType, Visibility extends FunctionVisibility, Ctx> = <
  A extends ArgsValidator | undefined = undefined,
  R = unknown,
>(
  definition: FunctionDefinition<Ctx, A, R>,
) => RegisteredFunction<Type, Visibility, ArgsInput<A>, Awaited<R>>;

function builder(type: FunctionType, visibility: FunctionVisibility): any {
  return (definition: FunctionDefinition<any, any, any>) => {
    if (typeof definition?.handler !== "function") throw new Error(`${type} definition needs a handler`);
    if (visibility === "internal" && definition.mcp) throw new Error("Internal functions cannot be MCP tools");
    return { __incibase: "function", type, visibility, ...definition };
  };
}

export interface FunctionBuilders<DM extends GenericDataModel> {
  query: Builder<"query", "public", QueryCtx<DM>>;
  internalQuery: Builder<"query", "internal", QueryCtx<DM>>;
  mutation: Builder<"mutation", "public", MutationCtx<DM>>;
  internalMutation: Builder<"mutation", "internal", MutationCtx<DM>>;
  action: Builder<"action", "public", ActionCtx>;
  internalAction: Builder<"action", "internal", ActionCtx>;
  httpAction: (handler: (ctx: ActionCtx, request: Request) => Response | Promise<Response>) => HttpAction;
}

/** `_generated/server.ts` calls this with the schema's data model to get typed builders. */
export function makeFunctionBuilders<DM extends GenericDataModel>(): FunctionBuilders<DM> {
  return {
    query: builder("query", "public"),
    internalQuery: builder("query", "internal"),
    mutation: builder("mutation", "public"),
    internalMutation: builder("mutation", "internal"),
    action: builder("action", "public"),
    internalAction: builder("action", "internal"),
    httpAction,
  };
}

export const { query, internalQuery, mutation, internalMutation, action, internalAction } =
  makeFunctionBuilders<GenericDataModel>();

// ---------------------------------------------------------------------------
// HTTP routes (`incibase/http.ts`, default export)

export interface HttpAction {
  readonly __incibase: "httpAction";
  readonly handler: (ctx: ActionCtx, request: Request) => Response | Promise<Response>;
}

export function httpAction(handler: HttpAction["handler"]): HttpAction {
  return { __incibase: "httpAction", handler };
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

export interface HttpRoute {
  method: HttpMethod;
  /** Exact path, e.g. `/webhooks/stripe`. */
  path?: string;
  /** Prefix match, must end with `/`, e.g. `/files/`. */
  pathPrefix?: string;
  handler: HttpAction;
}

export class HttpRouter {
  readonly __incibase = "httpRouter" as const;
  readonly routes: HttpRoute[] = [];

  route(route: HttpRoute): this {
    if (!route.path === !route.pathPrefix) throw new Error("A route needs exactly one of path or pathPrefix");
    if (route.pathPrefix && !route.pathPrefix.endsWith("/")) throw new Error("pathPrefix must end with /");
    const path = route.path ?? route.pathPrefix!;
    if (path.startsWith("/api/") || path === "/mcp") throw new Error(`"${path}" is reserved`);
    this.routes.push(route);
    return this;
  }

  match(method: string, pathname: string): HttpAction | null {
    const exact = this.routes.find((r) => r.method === method && r.path === pathname);
    if (exact) return exact.handler;
    let best: HttpRoute | null = null;
    for (const r of this.routes) {
      if (r.method === method && r.pathPrefix && pathname.startsWith(r.pathPrefix)) {
        if (!best || r.pathPrefix.length > best.pathPrefix!.length) best = r;
      }
    }
    return best?.handler ?? null;
  }
}

export function httpRouter(): HttpRouter {
  return new HttpRouter();
}

// ---------------------------------------------------------------------------
// Cron jobs (`incibase/crons.ts`, default export)

export interface IntervalSchedule {
  seconds?: number;
  minutes?: number;
  hours?: number;
}

export interface CronJob {
  name: string;
  /** Interval in ms, or a 5-field cron expression. */
  schedule: { kind: "interval"; ms: number } | { kind: "cron"; expression: string; tz?: string };
  path: string;
  args: Record<string, unknown>;
}

export class CronJobs {
  readonly __incibase = "crons" as const;
  readonly jobs: CronJob[] = [];

  interval<F extends SchedulableReference>(name: string, schedule: IntervalSchedule, fn: F, ...args: OptionalArgs<F>) {
    const ms = ((schedule.hours ?? 0) * 3600 + (schedule.minutes ?? 0) * 60 + (schedule.seconds ?? 0)) * 1000;
    if (ms < 1000) throw new Error(`Cron "${name}": interval must be at least 1 second`);
    this.add({ name, schedule: { kind: "interval", ms }, path: pathOf(fn), args: args[0] ?? {} });
  }

  /** Standard 5-field cron expression, e.g. `"0 9 * * MON-FRI"`, interpreted in `tz` (default: system zone). */
  cron<F extends SchedulableReference>(
    name: string,
    expression: string,
    fn: F,
    args?: F["_args"],
    options?: { tz?: string },
  ) {
    this.add({ name, schedule: { kind: "cron", expression, tz: options?.tz }, path: pathOf(fn), args: args ?? {} });
  }

  private add(job: CronJob) {
    if (this.jobs.some((j) => j.name === job.name)) throw new Error(`Duplicate cron job "${job.name}"`);
    this.jobs.push(job);
  }
}

export function cronJobs(): CronJobs {
  return new CronJobs();
}

function pathOf(ref: FunctionReference): string {
  return getFunctionPath(ref);
}
