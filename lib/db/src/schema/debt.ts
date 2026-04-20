import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const debt = pgTable("debt", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  balance: numeric("balance", { precision: 12, scale: 2 }).notNull(),
  interestRate: numeric("interest_rate", { precision: 6, scale: 4 }).notNull(),
  loanType: text("loan_type").notNull(),
  minimumPayment: numeric("minimum_payment", { precision: 10, scale: 2 }),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertDebtSchema = createInsertSchema(debt).omit({ id: true, createdAt: true, updatedAt: true });
export type Debt = typeof debt.$inferSelect;
export type InsertDebt = z.infer<typeof insertDebtSchema>;
