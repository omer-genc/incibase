import { id, IncibaseError, z } from "incibase/server";
import { action, internalQuery, mutation, query } from "./_generated/server";

const visibility = z.enum(["public", "private"]).default("public");

/** Upload URL for the signed-in user. Private files only open through signed, expiring URLs. */
export const generateUploadUrl = mutation({
  args: { visibility },
  handler: async (ctx, args) => {
    await ctx.auth.requireUser();
    return ctx.storage.generateUploadUrl({ visibility: args.visibility });
  },
});

/** Private files only yield a URL for their owner; anyone else gets null. */
export const url = query({
  args: { id: id("_storage"), expiresIn: z.number().positive().optional() },
  handler: (ctx, { id, expiresIn }) => ctx.storage.getUrl(id, { expiresIn }),
});

export const setVisibility = mutation({
  args: { id: id("_storage"), visibility: z.enum(["public", "private"]) },
  handler: async (ctx, args) => {
    await ctx.auth.requireUser();
    await ctx.storage.setVisibility(args.id, args.visibility);
  },
});

export const storeText = action({
  args: { text: z.string(), visibility },
  handler: (ctx, args) => ctx.storage.store(new Blob([args.text], { type: "text/plain" }), { visibility: args.visibility }),
});

/**
 * Sharing a private file with someone other than its owner: check access
 * yourself, then bypass the owner check. Here only the admin key may call it.
 */
export const urlForReviewer = internalQuery({
  args: { id: id("_storage") },
  handler: async (ctx, { id }) => {
    if (!ctx.auth.isAdmin) throw new IncibaseError({ code: "FORBIDDEN", message: "Reviewers only" });
    return ctx.storage.getUrl(id, { bypassOwnerCheck: true, expiresIn: 300 });
  },
});
