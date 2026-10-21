// Who may see a file is decided by your own data: a payslip row links an
// employee to a private file. HR uploads on the employee's behalf (so the
// employee owns the file), and reads go through these functions, which check
// access and then hand out short-lived signed URLs.
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

/** HR: an upload URL for an employee's payslip. The employee becomes the file's owner. */
export const generateUploadUrl = mutation({
  args: { employee: id("_users") },
  handler: async (ctx, { employee }) => {
    await requireHr(ctx);
    return ctx.storage.generateUploadUrl({ visibility: "private", ownerId: employee });
  },
});

/** HR: record an uploaded payslip. */
export const add = mutation({
  args: { employee: id("_users"), month: z.string(), file: id("_storage") },
  handler: async (ctx, args) => {
    const hr = await requireHr(ctx);
    const file = await ctx.storage.getMetadata(args.file);
    if (!file || file.ownerId !== args.employee || file.visibility !== "private") {
      throw new IncibaseError({ code: "BAD_REQUEST", message: "Upload the file with payslips.generateUploadUrl first" });
    }
    return ctx.db.insert("payslips", { ...args, uploadedBy: hr._id });
  },
});

async function withUrls(ctx: QueryCtx, rows: { file: Id<"_storage"> }[]) {
  // Access was checked by the caller, so the owner check can be skipped for HR.
  return Promise.all(
    rows.map(async (row) => ({ ...row, url: await ctx.storage.getUrl(row.file, { expiresIn: 600, bypassOwnerCheck: true }) })),
  );
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
