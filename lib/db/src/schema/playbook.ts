import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const playbookVersions = pgTable("playbook_versions", {
  id: serial("id").primaryKey(),
  version: text("version").notNull(),
  content: text("content").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
});

export const insertPlaybookVersionSchema = createInsertSchema(playbookVersions).omit({ id: true });
export type PlaybookVersion = typeof playbookVersions.$inferSelect;
export type InsertPlaybookVersion = z.infer<typeof insertPlaybookVersionSchema>;
