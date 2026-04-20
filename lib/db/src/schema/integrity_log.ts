import { pgTable, serial, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const integrityLog = pgTable("integrity_log", {
  id: serial("id").primaryKey(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
  overallStatus: text("overall_status").notNull().default("pass"),
  checksJson: jsonb("checks_json").notNull().default([]).$type<unknown[]>(),
  notes: text("notes"),
});

export const insertIntegrityLogSchema = createInsertSchema(integrityLog).omit({ id: true, runAt: true });
export type IntegrityLog = typeof integrityLog.$inferSelect;
export type InsertIntegrityLog = z.infer<typeof insertIntegrityLogSchema>;
