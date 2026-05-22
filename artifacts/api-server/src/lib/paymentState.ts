import { db, bills } from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";

/** Month-anchor cycle key (e.g. "2026-05"). */
export function cycleKey(today: Date): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Pure decision function for the per-bill payment-state transition.
 * Exposed for unit testing — `syncBillPaymentStates` is its DB-bound wrapper.
 *
 * Returns the next state, paid date and cycle key for a bill given today.
 * If `includeInCycle` is false, returns the bill unchanged (caller short-circuits).
 */
export interface BillStateInput {
  includeInCycle: boolean;
  paymentState: string;
  paidDate: string | null;
  paymentStateCycleKey: string | null;
  dueDay: number;
  autopay: boolean;
}

export interface BillStateDecision {
  paymentState: string;
  paidDate: string | null;
  paymentStateCycleKey: string | null;
  changed: boolean;
}

export function decideBillStateTransition(
  b: BillStateInput,
  today: Date,
): BillStateDecision {
  const ck = cycleKey(today);
  const dayOfMonth = today.getDate();

  let nextState = b.paymentState;
  let nextPaidDate: string | null = b.paidDate;
  let nextKey: string | null = b.paymentStateCycleKey;

  // Cycle rollover — reset state set in a prior cycle back to scheduled.
  if (b.paymentStateCycleKey && b.paymentStateCycleKey !== ck && b.paymentState !== "scheduled") {
    nextState = "scheduled";
    nextPaidDate = null;
    nextKey = ck;
  }

  // Auto-progression within current cycle.
  // Autopay flips to "paid" on the due day (debit lands that day).
  // Manual flips to "late_unpaid" only when strictly past due (next day).
  if (nextState === "scheduled") {
    if (b.autopay && b.dueDay <= dayOfMonth) {
      nextState = "paid";
      const d = new Date(today.getFullYear(), today.getMonth(), b.dueDay);
      nextPaidDate = d.toISOString().split("T")[0] ?? null;
      nextKey = ck;
    } else if (!b.autopay && b.dueDay < dayOfMonth) {
      nextState = "late_unpaid";
      nextKey = ck;
    }
  }

  const changed =
    nextState !== b.paymentState ||
    nextPaidDate !== b.paidDate ||
    nextKey !== b.paymentStateCycleKey;

  return { paymentState: nextState, paidDate: nextPaidDate, paymentStateCycleKey: nextKey, changed };
}

/**
 * v8.0 Part 2.3 — auto-update bill payment_state on every dashboard load.
 *
 * 1. autopay=TRUE bills past their scheduled day with state='scheduled' → 'paid'
 *    (paidDate = scheduled day this month).
 * 2. autopay=FALSE bills past their scheduled day with state='scheduled' →
 *    'late_unpaid' (still counted as obligation; flagged).
 * 3. Cycle rollover: bills whose state was set in a prior cycle revert to
 *    'scheduled' (clears 'paid' / 'late_unpaid' / 'skipped_cycle' from last month).
 *
 * Idempotent: safe to call on every request.
 */
export async function syncBillPaymentStates(today: Date = new Date()): Promise<void> {
  today.setHours(0, 0, 0, 0);
  const allBills = await db.select().from(bills);

  for (const b of allBills) {
    if (!b.includeInCycle) continue;
    const decision = decideBillStateTransition(b, today);
    if (decision.changed) {
      await db
        .update(bills)
        .set({
          paymentState: decision.paymentState,
          paidDate: decision.paidDate,
          paymentStateCycleKey: decision.paymentStateCycleKey,
          updatedAt: new Date(),
        })
        .where(eq(bills.id, b.id));
    }
  }
  void and; void ne; // keep imports for future expansion
}
