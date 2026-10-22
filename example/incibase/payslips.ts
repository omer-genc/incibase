// Who may see a file is decided by your own data: the payslip row holds a
// private file() field, so any query allowed to read the row can hand out a
// short-lived signed URL for its file, and nobody else can.
import { id, IncibaseError, z } from "incibase/server";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";

async function isHr(ctx: QueryCtx, userId: Id<"_users">) {
  return !!(await ctx.db.query("hr").withIndex("by_user", (q) => q.eq("userId", userId)).unique());
}

async function requireHr(ctx: QueryCtx) {
  const user = await ctx.auth.requireUser();
  if (!(await isHr(ctx, user._id))) throw new IncibaseError({ code: "FORBIDDEN", message: "HR only" });
  return user;
}

/** HR: an upload URL for a payslip PDF. */
export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    await requireHr(ctx);
    return ctx.storage.generateUploadUrl({ visibility: "private", maxBytes: 5 * 1024 * 1024, contentTypes: ["application/pdf"] });
  },
});

/** HR: record an uploaded payslip. */
export const add = mutation({
  args: { employee: id("_users"), month: z.string(), file: id("_storage") },
  handler: async (ctx, args) => {
    const hr = await requireHr(ctx);
    // The file() field checks HR uploaded it and that no other document holds it.
    return ctx.db.insert("payslips", { ...args, uploadedBy: hr._id });
  },
});

async function withUrls(ctx: QueryCtx, rows: { file: Id<"_storage"> }[]) {
  // These rows were loaded by this query, so their file() URLs are allowed.
  return Promise.all(rows.map(async (row) => ({ ...row, url: await ctx.storage.getUrl(row.file, { expiresIn: 600 }) })));
}

/** The signed-in employee's own payslips. */
export const mine = query({
  handler: async (ctx) => {
    const user = await ctx.auth.requireUser();
    const rows = await ctx.db.query("payslips").withIndex("by_employee", (q) => q.eq("employee", user._id)).order("desc").collect();
    return withUrls(ctx, rows);
  },
});

/** HR: any employee's payslips. */
export const forEmployee = query({
  args: { employee: id("_users") },
  handler: async (ctx, { employee }) => {
    await requireHr(ctx);
    const rows = await ctx.db.query("payslips").withIndex("by_employee", (q) => q.eq("employee", employee)).order("desc").collect();
    return withUrls(ctx, rows);
  },
});
