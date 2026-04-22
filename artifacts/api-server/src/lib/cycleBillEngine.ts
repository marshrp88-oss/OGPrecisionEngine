import { db, bills } from "@workspace/db";
import { deriveNextPayday } from "./financeEngine";

export interface EnrichedBill {
  id: number;
  name: string;
  amount: number;
  dueDay: number;
  frequency: string;
  category: string;
  autopay: boolean;
  notes: string | null;
  includeInCycle: boolean;
  activeFrom: Date | null;
  activeUntil: Date | null;
  /** Next due date in calendar terms (this month if dueDay >= today, else next month). */
  nextDueDate: Date;
  /** Whether the bill's billing window is currently active (activeFrom/Until honored). */
  isActivePeriod: boolean;
  /** Days from today until nextDueDate (0 = due today, negative = overdue but rolled). */
  daysUntilDue: number;
  /** True if this bill counts toward Required Hold this cycle (Include=TRUE, $>0, active, today<=due<nextPayday). */
  countsThisCycle: boolean;
  /** True if this bill counts toward full-month fixed (Include=TRUE, $>0, active period). */
  countsThisMonth: boolean;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isActive(today: Date, activeFrom: Date | null, activeUntil: Date | null): boolean {
  if (activeFrom && today < activeFrom) return false;
  if (activeUntil && today > activeUntil) return false;
  return true;
}

function nextDueDateFor(today: Date, dueDay: number): Date {
  let d = new Date(today.getFullYear(), today.getMonth(), dueDay);
  if (d.getTime() < today.getTime()) {
    d = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
  }
  return d;
}

/**
 * Single source of truth for bill enumeration.
 * Returns ALL bills with derived fields so callers can filter consistently.
 */
export async function enumerateBills(today?: Date): Promise<EnrichedBill[]> {
  const t = startOfDay(today ?? new Date());
  const nextPayday = deriveNextPayday(t);
  const rows = await db.select().from(bills).orderBy(bills.dueDay);

  return rows.map((b) => {
    const amount = parseFloat(b.amount);
    const activeFrom = b.activeFrom ? startOfDay(new Date(b.activeFrom)) : null;
    const activeUntil = b.activeUntil ? startOfDay(new Date(b.activeUntil)) : null;
    const isActivePeriod = isActive(t, activeFrom, activeUntil);
    const dueDate = nextDueDateFor(t, b.dueDay);
    const daysUntilDue = Math.round((dueDate.getTime() - t.getTime()) / 86400000);

    const countsThisCycle =
      b.includeInCycle &&
      amount > 0 &&
      isActivePeriod &&
      dueDate.getTime() >= t.getTime() &&
      dueDate.getTime() < nextPayday.getTime();

    const countsThisMonth = b.includeInCycle && amount > 0 && isActivePeriod;

    return {
      id: b.id,
      name: b.name,
      amount,
      dueDay: b.dueDay,
      frequency: b.frequency,
      category: b.category,
      autopay: b.autopay,
      notes: b.notes,
      includeInCycle: b.includeInCycle,
      activeFrom,
      activeUntil,
      nextDueDate: dueDate,
      isActivePeriod,
      daysUntilDue,
      countsThisCycle,
      countsThisMonth,
    };
  });
}

/**
 * Bills due in the current pay cycle (today through next payday, exclusive).
 */
export async function billsInCycle(today?: Date): Promise<EnrichedBill[]> {
  return (await enumerateBills(today)).filter((b) => b.countsThisCycle);
}

/**
 * Bills counting toward full-month fixed (used by Monthly Savings + Discretionary).
 */
export async function billsThisMonth(today?: Date): Promise<EnrichedBill[]> {
  return (await enumerateBills(today)).filter((b) => b.countsThisMonth);
}

/**
 * Bills due between today (inclusive) and end-of-month (inclusive),
 * filtered to Include=TRUE and active.
 */
export async function billsRemainingThisMonth(today?: Date): Promise<EnrichedBill[]> {
  const t = startOfDay(today ?? new Date());
  const monthEnd = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  return (await enumerateBills(t)).filter(
    (b) =>
      b.countsThisMonth &&
      b.dueDay >= t.getDate() &&
      b.dueDay <= monthEnd.getDate(),
  );
}

/**
 * Forward Reserve fixed component: bills due 1st–7th of next month.
 */
export async function forwardReserveFixed(today?: Date): Promise<number> {
  const all = await enumerateBills(today);
  return all
    .filter((b) => b.includeInCycle && b.amount > 0 && b.isActivePeriod && b.dueDay >= 1 && b.dueDay <= 7)
    .reduce((s, b) => s + b.amount, 0);
}
