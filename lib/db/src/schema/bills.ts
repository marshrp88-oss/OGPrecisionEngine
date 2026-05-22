import { pgTable, serial, text, numeric, integer, boolean, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const bills = pgTable("bills", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  dueDay: integer("due_day").notNull(),
  frequency: text("frequency").notNull().default("monthly"),
  includeInCycle: boolean("include_in_cycle").notNull().default(true),
  category: text("category").notNull().default("essential"),
  autopay: boolean("autopay").notNull().default(false),
  notes: text("notes"),
  activeFrom: date("active_from"),
  activeUntil: date("active_until"),
  // v8.0 payment-state engine (Part 2).
  // 'scheduled' = not yet paid, money still expected to leave.
  // 'paid'      = money already left the account this cycle.
  // 'late_unpaid' = past scheduled day, manual bill, still owed.
  // 'skipped_cycle' = excluded from THIS cycle only; auto-reverts next cycle.
  paymentState: text("payment_state").notNull().default("scheduled"),
  paidDate: date("paid_date"),
  // Cycle key for skipped_cycle auto-revert. YYYY-MM string of cycle when
  // state was last set. When current cycle key != stored key, skip auto-reverts.
  paymentStateCycleKey: text("payment_state_cycle_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBillSchema = createInsertSchema(bills).omit({ id: true, createdAt: true, updatedAt: true });
export type Bill = typeof bills.$inferSelect;
export type InsertBill = z.infer<typeof insertBillSchema>;
