import { pgTable, serial, text, numeric, boolean, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const oneTimeExpenses = pgTable("one_time_expenses", {
  id: serial("id").primaryKey(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  dueDate: date("due_date"),
  paid: boolean("paid").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOneTimeExpenseSchema = createInsertSchema(oneTimeExpenses).omit({ id: true, createdAt: true });
export type OneTimeExpense = typeof oneTimeExpenses.$inferSelect;
export type InsertOneTimeExpense = z.infer<typeof insertOneTimeExpenseSchema>;
