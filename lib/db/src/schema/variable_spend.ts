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
  // v8.0 Final Fix — QuickSilver settlement lifecycle. When NULL, this QS row
  // is "owed" (the dollar has been spent on the card but not yet paid off from
  // checking). When set, the row has been settled and drops out of the
  // Required Hold's quicksilverOwed term. Bulk-stamped by
  // POST /variable-spend/quicksilver/mark-paid.
  paidOffAt: timestamp("paid_off_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVariableSpendSchema = createInsertSchema(variableSpend).omit({ id: true, createdAt: true, paidOffAt: true });
export type VariableSpend = typeof variableSpend.$inferSelect;
export type InsertVariableSpend = z.infer<typeof insertVariableSpendSchema>;
