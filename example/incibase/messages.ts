import { id, IncibaseError, paginationOptsValidator, z } from "incibase/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";

export const list = query({
  description: "Messages in a channel, newest first.",
  args: {
    channel: id("channels"),
    limit: z.number().int().min(1).max(200).default(50),
  },
  mcp: true,
  handler: async (ctx, { channel, limit }) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .take(limit);
    return Promise.all(
      messages.map(async (m) => ({
        ...m,
        attachmentUrl: m.attachment ? await ctx.storage.getUrl(m.attachment) : null,
      })),
    );
  },
});

export const page = query({
  args: { channel: id("channels"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { channel, paginationOpts }) =>
    ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .paginate(paginationOpts),
});

export const send = mutation({
  args: {
    channel: id("channels"),
    body: z.string().trim().min(1).max(2000),
    attachment: id("_storage").optional(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.auth.requireUser();
    if (!(await ctx.db.get(args.channel))) throw new IncibaseError({ code: "NOT_FOUND", message: "No such channel" });
    // Only attach your own uploads; otherwise anyone could reference someone else's file by id.
    if (args.attachment) {
      const file = await ctx.storage.getMetadata(args.attachment);
      if (!file || file.ownerId !== user._id) throw new IncibaseError({ code: "FORBIDDEN", message: "You can only attach your own files" });
    }
    const messageId = await ctx.db.insert("messages", { ...args, author: user._id });
    await ctx.scheduler.runAfter(0, internal.messages.bumpCount, { key: "messages" });
    return messageId;
  },
});

export const pin = mutation({
  args: { id: id("messages"), pinned: z.boolean() },
  handler: async (ctx, { id, pinned }) => {
    const user = await ctx.auth.requireUser();
    const message = await ctx.db.get(id);
    if (!message) throw new IncibaseError({ code: "NOT_FOUND", message: "No such message" });
    if (message.author !== user._id) throw new IncibaseError({ code: "FORBIDDEN", message: "Not your message" });
    await ctx.db.patch(id, { pinned });
  },
});

export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    await ctx.auth.requireUser();
    return ctx.storage.generateUploadUrl();
  },
});

export const bumpCount = internalMutation({
  args: { key: z.string() },
  handler: async (ctx, { key }) => {
    const existing = await ctx.db.query("stats").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (existing) await ctx.db.patch(existing._id, { value: existing.value + 1 });
    else await ctx.db.insert("stats", { key, value: 1 });
  },
});
