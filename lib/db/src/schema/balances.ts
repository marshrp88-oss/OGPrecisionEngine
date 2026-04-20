import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const balances = pgTable("balances", {
  id: serial("id").primaryKey(),
  accountType: text("account_type").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  asOfDate: timestamp("as_of_date", { withTimezone: true }).notNull(),
  source: text("source").notNull().default("manual"),
  notes: text("notes"),
});

export const insertBalanceSchema = createInsertSchema(balances).omit({ id: true });
export type Balance = typeof balances.$inferSelect;
export type InsertBalance = z.infer<typeof insertBalanceSchema>;
