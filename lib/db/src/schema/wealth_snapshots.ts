import { pgTable, serial, text, numeric, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const wealthSnapshots = pgTable("wealth_snapshots", {
  id: serial("id").primaryKey(),
  snapshotDate: date("snapshot_date").notNull(),
  hysa: numeric("hysa", { precision: 12, scale: 2 }).notNull().default("0"),
  brokerage: numeric("brokerage", { precision: 12, scale: 2 }).notNull().default("0"),
  retirement401k: numeric("retirement_401k", { precision: 12, scale: 2 }).notNull().default("0"),
  otherAssets: numeric("other_assets", { precision: 12, scale: 2 }).notNull().default("0"),
  totalAssets: numeric("total_assets", { precision: 12, scale: 2 }).notNull().default("0"),
  carLoan: numeric("car_loan", { precision: 12, scale: 2 }).notNull().default("0"),
  studentLoans: numeric("student_loans", { precision: 12, scale: 2 }).notNull().default("0"),
  otherLiabilities: numeric("other_liabilities", { precision: 12, scale: 2 }).notNull().default("0"),
  totalLiabilities: numeric("total_liabilities", { precision: 12, scale: 2 }).notNull().default("0"),
  netWorth: numeric("net_worth", { precision: 12, scale: 2 }).notNull().default("0"),
  changeVsPrior: numeric("change_vs_prior", { precision: 12, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertWealthSnapshotSchema = createInsertSchema(wealthSnapshots).omit({ id: true, createdAt: true });
export type WealthSnapshot = typeof wealthSnapshots.$inferSelect;
export type InsertWealthSnapshot = z.infer<typeof insertWealthSnapshotSchema>;
