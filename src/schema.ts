import { z } from "zod";
import type { Id, SystemFields } from "./values.ts";

export const NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;
export const FIELD_PATH_REGEX = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

export type TableShape = Record<string, z.ZodType>;
type FieldOf<Shape> = keyof Shape & string;

export interface IndexDefinition {
  name: string;
  fields: string[];
  unique: boolean;
}

export class TableDefinition<
  Shape extends TableShape = TableShape,
  Indexes extends Record<string, readonly string[]> = {},
> {
  readonly __incibase = "table" as const;
  readonly validator: z.ZodObject<Shape, any>;
  readonly indexes: readonly IndexDefinition[];

  constructor(validator: z.ZodObject<Shape, any>, indexes: readonly IndexDefinition[] = []) {
    for (const key of Object.keys(validator.shape)) {
      if (!NAME_REGEX.test(key)) {
        throw new Error(`Invalid field name "${key}": use letters, digits and "_", starting with a letter`);
      }
    }
    this.validator = validator;
    this.indexes = indexes;
  }

  /**
   * Adds an index. Queries can use it with `.withIndex(name, q => q.eq(...))`
   * and get results ordered by its fields, then by `_creationTime`.
   */
  index<const Name extends string, const Fields extends readonly [FieldOf<Shape>, ...FieldOf<Shape>[]]>(
    name: Name,
    fields: Fields,
    options: { unique?: boolean } = {},
  ): TableDefinition<Shape, Indexes & { [K in Name]: Fields }> {
    if (!NAME_REGEX.test(name)) throw new Error(`Invalid index name "${name}"`);
    if (name === "by_creation_time" || this.indexes.some((i) => i.name === name)) {
      throw new Error(`Duplicate index name "${name}"`);
    }
    for (const field of fields) {
      if (!FIELD_PATH_REGEX.test(field)) throw new Error(`Invalid index field "${field}" in "${name}"`);
    }
    return new TableDefinition(this.validator, [
      ...this.indexes,
      { name, fields: [...fields], unique: options.unique ?? false },
    ]);
  }
}

export type AnyTableDefinition = TableDefinition<any, any>;

export function defineTable<Shape extends TableShape>(
  definition: Shape | z.ZodObject<Shape, any>,
): TableDefinition<Shape> {
  const validator = definition instanceof z.ZodObject ? definition : z.object(definition as Shape);
  return new TableDefinition(validator as z.ZodObject<Shape, any>);
}

export class SchemaDefinition<Tables extends Record<string, AnyTableDefinition> = Record<string, AnyTableDefinition>> {
  readonly __incibase = "schema" as const;
  constructor(readonly tables: Tables) {}
}

export function defineSchema<const Tables extends Record<string, AnyTableDefinition>>(
  tables: Tables,
): SchemaDefinition<Tables> {
  for (const name of Object.keys(tables)) {
    if (!NAME_REGEX.test(name)) {
      throw new Error(`Invalid table name "${name}": use letters, digits and "_", starting with a letter`);
    }
  }
  return new SchemaDefinition(tables);
}

// ---------------------------------------------------------------------------
// Data model types

type Expand<T> = { [K in keyof T]: T[K] };

export interface TableTypes {
  document: SystemFields<any> & Record<string, any>;
  insert: Record<string, any>;
  indexes: Record<string, readonly string[]>;
}

export type GenericDataModel = Record<string, TableTypes>;

export type ScheduledJobState = "pending" | "running" | "success" | "failed" | "canceled";

export type SystemDataModel = {
  _users: {
    document: Expand<SystemFields<"_users"> & { email: string; name?: string; emailVerified: boolean }>;
    insert: never;
    indexes: { by_creation_time: ["_creationTime"]; by_email: ["email"] };
  };
  _storage: {
    /** `visibility` is missing on files stored before it existed; treat that as "public". */
    document: Expand<
      SystemFields<"_storage"> & {
        contentType?: string;
        size: number;
        sha256: string;
        visibility?: "public" | "private";
        /** The user who uploaded it; missing for admin uploads and files stored before ownership existed. */
        ownerId?: Id<"_users">;
      }
    >;
    insert: never;
    indexes: { by_creation_time: ["_creationTime"] };
  };
  _scheduled: {
    document: Expand<
      SystemFields<"_scheduled"> & {
        name: string;
        args: Record<string, unknown>;
        runAt: number;
        state: ScheduledJobState;
        startedAt?: number;
        completedAt?: number;
        error?: string;
      }
    >;
    insert: never;
    indexes: { by_creation_time: ["_creationTime"]; by_state_runAt: ["state", "runAt"] };
  };
};

export type DataModelFromSchema<S> =
  S extends SchemaDefinition<infer Tables>
    ? {
        [T in keyof Tables & string]: Tables[T] extends TableDefinition<infer Shape, infer Indexes>
          ? {
              document: Expand<SystemFields<T> & z.output<z.ZodObject<Shape>>>;
              insert: z.input<z.ZodObject<Shape>>;
              indexes: Expand<Indexes & { by_creation_time: ["_creationTime"] }>;
            }
          : never;
      } & SystemDataModel
    : GenericDataModel;

/** Tables a function may write to: everything except the `_` system tables. */
export type WritableTableNames<DM> = Exclude<keyof DM & string, `_${string}`>;

export type DocumentOf<DM, T extends keyof DM> = DM[T] extends { document: infer D } ? D : never;

export type { Id };
