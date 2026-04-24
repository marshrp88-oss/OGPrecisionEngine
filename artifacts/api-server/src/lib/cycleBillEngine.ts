import { db, bills } from "@workspace/db";
import {
  Bill as EngineBill,
  d as utcDay,
  effectivePayday,
  nextNominalPayday,
  billNextDueDate,
  billsInCurrentCycle,
  forwardReserve as engineForwardReserve,
} from "@workspace/finance";

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

/** UTC midnight start-of-day for a Date (matches engine convention). */
function utcStartOfDay(date: Date): Date {
  return utcDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function isActive(today: Date, activeFrom: Date | null, activeUntil: Date | null): boolean {
  if (activeFrom && today < activeFrom) return false;
  if (activeUntil && today > activeUntil) return false;
  return true;
}

/**
 * Re-export of the engine's payday helpers so other modules don't reach into
 * @workspace/finance directly.
 */
export function deriveNextPayday(today: Date): Date {
  const t = utcStartOfDay(today);
  return effectivePayday(nextNominalPayday(t));
}

export function deriveNextNominalPayday(today: Date): Date {
  return nextNominalPayday(utcStartOfDay(today));
}

/**
 * Single source of truth for bill enumeration.
 * Returns ALL bills with derived fields so callers can filter consistently.
 *
 * Cycle-membership decision delegates to @workspace/finance billsInCurrentCycle
 * (which enforces strict `< effectivePayday` per FIX_PLAN §B2).
 */
export async function enumerateBills(today?: Date): Promise<EnrichedBill[]> {
  const t = utcStartOfDay(today ?? new Date());
  const nominal = nextNominalPayday(t);
  const rows = await db.select().from(bills).orderBy(bills.dueDay);

  // Build EngineBill list aligned to rows by index, so cycle-membership can
  // be looked up by reference (avoids ambiguity when two bills share a name).
  const engineBills = rows.map(
    (b) =>
      new EngineBill(
        b.name,
        parseFloat(b.amount),
        b.dueDay,
        b.includeInCycle,
        b.category,
        b.autopay,
        b.notes ?? "",
      ),
  );
  const cycleSet = new Set<EngineBill>(
    billsInCurrentCycle(engineBills, t, nominal).map(
      ([eb]: [EngineBill, Date]) => eb,
    ),
  );

  return rows.map((b, i) => {
    const amount = parseFloat(b.amount);
    const activeFrom = b.activeFrom ? utcStartOfDay(new Date(b.activeFrom)) : null;
    const activeUntil = b.activeUntil ? utcStartOfDay(new Date(b.activeUntil)) : null;
    const isActivePeriod = isActive(t, activeFrom, activeUntil);
    const dueDate =
      billNextDueDate(t, b.dueDay, b.includeInCycle) ??
      utcDay(t.getUTCFullYear(), t.getUTCMonth() + 1, b.dueDay);
    const daysUntilDue = Math.round((dueDate.getTime() - t.getTime()) / 86400000);

    // Engine-decided cycle membership keyed by reference (engineBills[i] ===
    // the same object the engine returned), AND with isActivePeriod (engine
    // doesn't know about activeFrom/activeUntil windows — DB-only concept).
    const eb = engineBills[i]!;
    const countsThisCycle = isActivePeriod && cycleSet.has(eb);
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

/** Bills due in the current pay cycle (today through next payday, exclusive). */
export async function billsInCycle(today?: Date): Promise<EnrichedBill[]> {
  return (await enumerateBills(today)).filter((b) => b.countsThisCycle);
}

/** Bills counting toward full-month fixed (used by Monthly Savings + Discretionary). */
export async function billsThisMonth(today?: Date): Promise<EnrichedBill[]> {
  return (await enumerateBills(today)).filter((b) => b.countsThisMonth);
}

/** Bills due between today (inclusive) and end-of-month (inclusive), Include=TRUE and active. */
export async function billsRemainingThisMonth(today?: Date): Promise<EnrichedBill[]> {
  const t = utcStartOfDay(today ?? new Date());
  const monthEnd = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));
  return (await enumerateBills(t)).filter(
    (b) =>
      b.countsThisMonth &&
      b.dueDay >= t.getUTCDate() &&
      b.dueDay <= monthEnd.getUTCDate(),
  );
}

/**
 * Forward Reserve fixed component: bills due 1st-7th of next month.
 * Delegates to @workspace/finance forwardReserve (without the variable component).
 */
export async function forwardReserveFixed(today?: Date): Promise<number> {
  const all = await enumerateBills(today);
  const engineBills = all
    .filter((b) => b.isActivePeriod)
    .map(
      (b) =>
        new EngineBill(b.name, b.amount, b.dueDay, b.includeInCycle, b.category, b.autopay),
    );
  // engineForwardReserve = bills 1-7 + 7 days variable. We want fixed only —
  // pass variableCap=0 so the variable contribution is zero.
  return engineForwardReserve(engineBills, 0, 30.4);
}
