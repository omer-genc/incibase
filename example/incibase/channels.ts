import { z } from "incibase/server";
import { mutation, query } from "./_generated/server";

export const list = query({
  description: "All channels, alphabetically.",
  mcp: true,
  handler: async (ctx) => ctx.db.query("channels").withIndex("by_name").collect(),
});

export const create = mutation({
  args: { name: z.string().trim().min(1).max(50) },
  handler: async (ctx, { name }) => {
    const user = await ctx.auth.requireUser();
    return ctx.db.insert("channels", { name, createdBy: user._id });
  },
});
