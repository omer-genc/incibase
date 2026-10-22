// Function references shared by server and client. This file must stay free of
// runtime imports so client bundles stay small.
import type { z } from "zod";

export type FunctionType = "query" | "mutation" | "action";
export type FunctionVisibility = "public" | "internal";

export type ArgsValidator = Record<string, z.ZodType> | z.ZodType<Record<string, unknown>>;

export type ArgsOutput<A> = [A] extends [undefined]
  ? {}
  : A extends z.ZodType
    ? z.output<A>
    : A extends Record<string, z.ZodType>
      ? z.output<z.ZodObject<A>>
      : never;

export type ArgsInput<A> = [A] extends [undefined]
  ? {}
  : A extends z.ZodType
    ? z.input<A>
    : A extends Record<string, z.ZodType>
      ? z.input<z.ZodObject<A>>
      : never;

export interface McpToolOptions {
  /** Tool name shown to agents. Defaults to the function path with `/` and `:` replaced by `_`. */
  name?: string;
  /** Tool description. Defaults to the function's `description`. */
  description?: string;
}

/** What `query()`, `mutation()` and `action()` return. Exported from function modules. */
export interface RegisteredFunction<
  Type extends FunctionType = FunctionType,
  Visibility extends FunctionVisibility = FunctionVisibility,
  Args = any,
  Returns = any,
> {
  readonly __incibase: "function";
  readonly type: Type;
  readonly visibility: Visibility;
  readonly args?: ArgsValidator;
  readonly returns?: z.ZodType;
  readonly description?: string;
  readonly mcp?: boolean | McpToolOptions;
  /** Queue a scheduled job of it again once after an interruption (see the function definition). */
  readonly retryOnInterrupt?: boolean;
  readonly handler: (ctx: any, args: any) => unknown;
  /** Type-level only. */
  readonly _args: Args;
  /** Type-level only. */
  readonly _returns: Returns;
}

export interface FunctionReference<
  Type extends FunctionType = FunctionType,
  Visibility extends FunctionVisibility = FunctionVisibility,
  Args = any,
  Returns = any,
> {
  readonly _type: Type;
  readonly _visibility: Visibility;
  readonly _args: Args;
  readonly _returns: Returns;
}

export type FunctionArgs<F extends FunctionReference> = F["_args"];
export type FunctionReturnType<F extends FunctionReference> = F["_returns"];

/** Makes the args parameter optional when the function takes no required args. */
export type OptionalArgs<F extends FunctionReference> = {} extends F["_args"] ? [args?: F["_args"]] : [args: F["_args"]];

type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

type ModuleApi<M> = {
  [K in keyof M as M[K] extends RegisteredFunction ? K : never]: M[K] extends RegisteredFunction<
    infer T,
    infer V,
    infer A,
    infer R
  >
    ? FunctionReference<T, V, A, R>
    : never;
};

type Nest<Path extends string, V> = Path extends `${infer Head}/${infer Rest}`
  ? { [K in Head]: Nest<Rest, V> }
  : { [K in Path]: V };

/** `{ "chat/messages": typeof import("./chat/messages") }` → `{ chat: { messages: { list: FunctionReference } } }` */
export type ApiFromModules<Modules extends Record<string, unknown>> = UnionToIntersection<
  { [P in keyof Modules & string]: Nest<P, ModuleApi<Modules[P]>> }[keyof Modules & string]
>;

export type FilterApi<Api, Visibility extends FunctionVisibility> = {
  [K in keyof Api as Api[K] extends FunctionReference
    ? Api[K]["_visibility"] extends Visibility
      ? K
      : never
    : keyof FilterApi<Api[K], Visibility> extends never
      ? never
      : K]: Api[K] extends FunctionReference ? Api[K] : FilterApi<Api[K], Visibility>;
};

const PATH = Symbol.for("incibase.functionPath");

function makeReference(parts: string[]): any {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === PATH) {
          if (parts.length < 2) throw new Error(`"${parts.join(".")}" is a module, not a function reference`);
          return `${parts.slice(0, -1).join("/")}:${parts.at(-1)}`;
        }
        // Keep the proxy from looking like a promise or a JSON-able value.
        if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
        return makeReference([...parts, prop]);
      },
    },
  );
}

/** Untyped root of all function references; `_generated/api.ts` re-exports it with types. */
export const anyApi: any = makeReference([]);

/** `api.chat.messages.list` → `"chat/messages:list"`. Strings pass through. */
export function getFunctionPath(ref: FunctionReference | string): string {
  if (typeof ref === "string") return ref;
  const path = (ref as any)?.[PATH];
  if (typeof path !== "string") throw new Error("Not a function reference");
  return path;
}

/** Builds a typed reference from a path string, e.g. for dynamic calls. */
export function makeFunctionReference<
  Type extends FunctionType,
  Args = any,
  Returns = any,
>(path: string): FunctionReference<Type, "public", Args, Returns> {
  const [module, name] = path.split(":");
  if (!module || !name) throw new Error(`Invalid function path "${path}", expected "module:export"`);
  return makeReference([...module.split("/"), name]);
}
