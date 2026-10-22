import { defineSchema, defineTable, file, id, z } from "incibase/server";

export default defineSchema({
  channels: defineTable({
    name: z.string().min(1).max(50),
    createdBy: id("_users"),
  }).index("by_name", ["name"], { unique: true }),

  messages: defineTable({
    channel: id("channels"),
    author: id("_users"),
    body: z.string().min(1).max(2000),
    // Belongs to the message: only the sender's own upload fits, and it is deleted with the message.
    attachment: file({ maxBytes: 10 * 1024 * 1024, contentTypes: ["image/*", "application/pdf"] }).optional(),
    pinned: z.boolean().default(false),
  }).index("by_channel", ["channel"]),

  /** Users allowed to upload and read everyone's payslips. Add rows from the dashboard. */
  hr: defineTable({ userId: id("_users") }).index("by_user", ["userId"], { unique: true }),

  payslips: defineTable({
    employee: id("_users"),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    // Private: readable by code that can read the payslip row, nobody else.
    file: file({ private: true, contentTypes: ["application/pdf"] }),
    uploadedBy: id("_users"),
  }).index("by_employee", ["employee", "month"]),

  stats: defineTable({
    key: z.string(),
    value: z.number(),
  }).index("by_key", ["key"], { unique: true }),
});
