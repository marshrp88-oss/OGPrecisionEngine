import { pgTable, serial, text, numeric, boolean, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const variableSpend = pgTable("variable_spend", {
  id: serial("id").primaryKey(),
  weekOf: date("week_of").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  category: text("category"),
  quicksilver: boolean("quicksilver").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVariableSpendSchema = createInsertSchema(variableSpend).omit({ id: true, createdAt: true });
export type VariableSpend = typeof variableSpend.$inferSelect;
export type InsertVariableSpend = z.infer<typeof insertVariableSpendSchema>;
