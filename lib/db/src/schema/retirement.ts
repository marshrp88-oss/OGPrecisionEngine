import { pgTable, serial, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const retirementPlan = pgTable("retirement_plan", {
  id: serial("id").primaryKey(),
  grossSalary: numeric("gross_salary", { precision: 12, scale: 2 }).notNull().default("54000"),
  contributionRate: numeric("contribution_rate", { precision: 6, scale: 4 }).notNull().default("0.03"),
  employerMatchRate: numeric("employer_match_rate", { precision: 6, scale: 4 }).notNull().default("0.04"),
  employerMatchCap: numeric("employer_match_cap", { precision: 6, scale: 4 }).notNull().default("0.04"),
  currentBalance: numeric("current_balance", { precision: 12, scale: 2 }).notNull().default("1550"),
  currentAge: integer("current_age").notNull().default(30),
  targetAge: integer("target_age").notNull().default(65),
  returnAssumption: numeric("return_assumption", { precision: 6, scale: 4 }).notNull().default("0.07"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRetirementPlanSchema = createInsertSchema(retirementPlan).omit({ id: true, updatedAt: true });
export type RetirementPlan = typeof retirementPlan.$inferSelect;
export type InsertRetirementPlan = z.infer<typeof insertRetirementPlanSchema>;
