import { z } from "incibase/server";
import { api } from "./_generated/api";
import { action, query } from "./_generated/server";

export const get = query({
  args: { key: z.string() },
  returns: z.number(),
  mcp: { name: "get_stat", description: "Read a counter, e.g. key \"messages\"." },
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("stats").withIndex("by_key", (q) => q.eq("key", key)).unique();
    return row?.value ?? 0;
  },
});

/** Actions can call other functions and the outside world. */
export const summary = action({
  handler: async (ctx): Promise<{ channels: number; messages: number }> => {
    const channels = await ctx.runQuery(api.channels.list);
    const messages = await ctx.runQuery(api.stats.get, { key: "messages" });
    return { channels: channels.length, messages };
  },
});
