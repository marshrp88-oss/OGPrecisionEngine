import { pgTable, serial, text, integer, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const creditScores = pgTable("credit_scores", {
  id: serial("id").primaryKey(),
  asOfDate: date("as_of_date").notNull(),
  experian: integer("experian"),
  equifax: integer("equifax"),
  transunion: integer("transunion"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCreditScoreSchema = createInsertSchema(creditScores).omit({ id: true, createdAt: true });
export type CreditScore = typeof creditScores.$inferSelect;
export type InsertCreditScore = z.infer<typeof insertCreditScoreSchema>;
