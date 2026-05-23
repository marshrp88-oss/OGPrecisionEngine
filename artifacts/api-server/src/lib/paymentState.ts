import { db, bills } from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";

/** Month-anchor cycle key (e.g. "2026-05"). */
export function cycleKey(today: Date): string {
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Single source of truth for how a bill's payment state should be DISPLAYED.
 *
 * The stored `paymentState` column carries five values (scheduled,
 * paid_pending_clear, paid, late_unpaid, skipped_cycle). Two of those map to
 * the same user-visible idea ("the money hasn't actually left checking yet"):
 *   - paymentState='paid_pending_clear' → user paid, awaiting clear.
 *   - paymentState='paid' WITHOUT clearedDate → same thing; only the marker
 *     differs (e.g. user flipped from the Bills page rather than the Overview
 *     toggle).
 *
 * Both the Bills page pill and the Overview's cash-position card derive their
 * label from THIS function. The previous mismatch (Bills showed "Cleared" for
 * the same row Overview called "pending") came from the two views diverging
 * on this rule.
 */
export type DisplayPaymentState =
  | "scheduled"
  | "pending"
  | "cleared"
  | "late_unpaid"
  | "skipped_cycle";

export function displayPaymentState(b: {
  paymentState: string;
  clearedDate: Date | string | null;
}): DisplayPaymentState {
  if (b.paymentState === "scheduled") return "scheduled";
  if (b.paymentState === "skipped_cycle") return "skipped_cycle";
  if (b.paymentState === "late_unpaid") return "late_unpaid";
  if (b.paymentState === "paid_pending_clear") return "pending";
  if (b.paymentState === "paid") {
    return b.clearedDate ? "cleared" : "pending";
  }
  return "scheduled";
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
  // v8.1 — `paid_pending_clear` is preserved across rollover. The money is
  // still floating out of checking (user hasn't called mark-cleared yet), so
  // the pending hold must persist regardless of cycle boundary. Only an
  // explicit POST /bills/:id/mark-cleared (or manual state change) releases it.
  if (
    b.paymentStateCycleKey &&
    b.paymentStateCycleKey !== ck &&
    b.paymentState !== "scheduled" &&
    b.paymentState !== "paid_pending_clear"
  ) {
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
