import { defineSchema, defineTable, id, z } from "incibase/server";

export default defineSchema({
  channels: defineTable({
    name: z.string().min(1).max(50),
    createdBy: id("_users"),
  }).index("by_name", ["name"], { unique: true }),

  messages: defineTable({
    channel: id("channels"),
    author: id("_users"),
    body: z.string().min(1).max(2000),
    attachment: id("_storage").optional(),
    pinned: z.boolean().default(false),
  }).index("by_channel", ["channel"]),

  stats: defineTable({
    key: z.string(),
    value: z.number(),
  }).index("by_key", ["key"], { unique: true }),
});
