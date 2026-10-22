import { z } from "zod";

declare const tableBrand: unique symbol;

/** A document id that belongs to `TableName`. Plain strings are not assignable to it. */
export type Id<TableName extends string> = string & { readonly [tableBrand]: TableName };

/** 26 chars of base32 UUIDv7 followed by 2 chars of table number. */
export const ID_REGEX = /^[0-9a-hjkmnp-tv-z]{28}$/;

/** JSON Schema / registry key that records which table an id points to. */
export const ID_TABLE_META_KEY = "x-incibase-table";

/** The running engine installs this to map an id to its table name. */
export const ID_TABLE_RESOLVER = Symbol.for("incibase.idTableResolver");

/** Validator for an id of a document in `tableName`. On the server it also checks the id's table. */
export function id<TableName extends string>(tableName: TableName): z.ZodType<Id<TableName>, Id<TableName>> {
  return z
    .string()
    .regex(ID_REGEX, { message: `Invalid id for table "${tableName}"`, abort: true })
    .refine(
      (value) => {
        const resolve = (globalThis as Record<symbol, ((id: string) => string | null) | undefined>)[ID_TABLE_RESOLVER];
        return !resolve || resolve(value) === tableName;
      },
      { message: `Expected an id of table "${tableName}"` },
    )
    .meta({ [ID_TABLE_META_KEY]: tableName }) as unknown as z.ZodType<Id<TableName>, Id<TableName>>;
}

/** JSON Schema / registry key carrying a `file()` field's options. */
export const FILE_META_KEY = "x-incibase-file";

export interface FileFieldOptions {
  /** Files in this field are private: only signed, expiring URLs open them. Default false (public). */
  private?: boolean;
  /** Largest accepted file in bytes. */
  maxBytes?: number;
  /** Accepted content types; `"image/*"` style wildcards allowed. */
  contentTypes?: string[];
}

/**
 * A file that belongs to this document. Writing one checks that the writer
 * uploaded it and that no other document holds it; a query that can read the
 * document can get the file's URL (even when private); replacing the value or
 * deleting the document deletes the file. Use `id("_storage")` instead for
 * files shared between documents.
 */
export function file(options: FileFieldOptions = {}): z.ZodType<Id<"_storage">, Id<"_storage">> {
  return (id("_storage") as unknown as z.ZodString).meta({
    [ID_TABLE_META_KEY]: "_storage",
    [FILE_META_KEY]: { private: !!options.private, maxBytes: options.maxBytes, contentTypes: options.contentTypes },
  }) as unknown as z.ZodType<Id<"_storage">, Id<"_storage">>;
}

export type SystemFields<TableName extends string> = {
  _id: Id<TableName>;
  _creationTime: number;
};

/** Args validator for paginated queries; `usePaginatedQuery` fills it in. */
export const paginationOptsValidator = z.object({
  cursor: z.string().nullable(),
  numItems: z.number().int().min(1).max(1000),
});

export type PaginationOptions = z.output<typeof paginationOptsValidator>;
