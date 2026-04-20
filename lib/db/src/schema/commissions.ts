import { pgTable, serial, text, numeric, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const commissions = pgTable("commissions", {
  id: serial("id").primaryKey(),
  salesMonth: date("sales_month").notNull(),
  mrrAchieved: numeric("mrr_achieved", { precision: 10, scale: 2 }).notNull().default("0"),
  nrrAchieved: numeric("nrr_achieved", { precision: 10, scale: 2 }).notNull().default("0"),
  mrrPayout: numeric("mrr_payout", { precision: 10, scale: 2 }).notNull().default("0"),
  nrrPayout: numeric("nrr_payout", { precision: 10, scale: 2 }).notNull().default("0"),
  grossTotal: numeric("gross_total", { precision: 10, scale: 2 }).notNull().default("0"),
  takeHome: numeric("take_home", { precision: 10, scale: 2 }).notNull().default("0"),
  payoutDate: date("payout_date"),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCommissionSchema = createInsertSchema(commissions).omit({ id: true, createdAt: true, updatedAt: true });
export type Commission = typeof commissions.$inferSelect;
export type InsertCommission = z.infer<typeof insertCommissionSchema>;
