/**
 * recurringBillPaid.test.ts
 * =========================
 * Regression test for the bug where marking a recurring bill paid_pending_clear
 * after its current-period dueDay had passed caused the Forward Reserve to
 * silently lose the next-period occurrence and the same dollars to surface in
 * "Pending Bill Payments" — mis-attribution, no change in total.
 *
 * Scenario reproduces the user-reported case:
 *   - today: 2026-05-23 (past the May 22 payday → cycle rolled to June 7)
 *   - Phase 1 bills: Car Loan day 1 $337.57, Verizon day 2 $65,
 *     Claude day 3 $21, Rent day 4 $1000, Replit day 21 $21
 *   - Checking: $1,439.00
 *   - Rent is paid_pending_clear (user paid May's rent on May 4; clicked
 *     "Paid (pending)" on May 23 to record it). The May 4 occurrence is in the
 *     past — the June 4 occurrence is the one held in the forward reserve.
 *
 * Expected after the fix:
 *   - forwardReserveLabel = $1,423.57 (Car Loan + Verizon + Claude + Rent)
 *   - pendingBillsOwed    = $0.00 (Rent already counted via forward window;
 *                                   nothing else paid_pending_clear)
 *   - safeToSpend         = $15.43
 *   - engine / canonical hold delta = $0.00 (integrity Check 11 passes)
 */
import { describe, it, expect, vi } from "vitest";

const fixture = vi.hoisted(() => {
  return {
    bills: [
      // Phase 1 day 1-7 bills — these are the Forward Reserve set.
      { id: 1, name: "Car Loan (2024 Camry)", amount: "337.57", dueDay: 1, frequency: "monthly", category: "debt", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "scheduled", paidDate: null, paymentStateCycleKey: null, clearedDate: null },
      { id: 2, name: "Phone (Verizon)", amount: "65.00", dueDay: 2, frequency: "monthly", category: "essential", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "scheduled", paidDate: null, paymentStateCycleKey: null, clearedDate: null },
      { id: 3, name: "Claude Subscription", amount: "21.00", dueDay: 3, frequency: "monthly", category: "discretionary", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "scheduled", paidDate: null, paymentStateCycleKey: null, clearedDate: null },
      // Rent: the recurring bill that's been marked paid_pending_clear AFTER
      // its current-period dueDay (May 4) has passed. paidDate=May 4 is the
      // current-period instance the user paid; the June 4 instance is the
      // one the forward reserve must still hold.
      { id: 4, name: "Rent", amount: "1000.00", dueDay: 4, frequency: "monthly", category: "essential", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "paid_pending_clear", paidDate: "2026-05-04", paymentStateCycleKey: "2026-05", clearedDate: null },
      // Replit: in the cycle window (May 23 → June 7 captures May 21 via the
      // current month's instance? No — May 21 < May 23 so it rolls to June 21,
      // which is > June 7. Not in cycle. NOT in dueDay 1-7. Stays out of the
      // hold). Included for realism, not relevant to the assertions.
      { id: 5, name: "Replit Subscription", amount: "21.00", dueDay: 21, frequency: "monthly", category: "discretionary", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "scheduled", paidDate: null, paymentStateCycleKey: null, clearedDate: null },
    ],
    balances: [
      { id: 1, accountType: "checking", amount: "1439.00", asOfDate: "2026-05-22" },
    ],
    assumptions: [
      { key: "alert_threshold", value: "400" },
      { key: "month_length_days", value: "30.4" },
      { key: "variable_spend_cap", value: "600" },
      { key: "pending_holds_reserve", value: "0" },
      { key: "minimum_cushion", value: "0" },
      { key: "variable_spend_until_payday", value: "0" },
      { key: "base_net_income", value: "3220" },
      { key: "hysa_target", value: "15000" },
      { key: "quicksilver_balance_owed", value: "0" },
    ],
    oneTimeExpenses: [] as Array<Record<string, unknown>>,
    variableSpend: [] as Array<Record<string, unknown>>,
    commissions: [] as Array<Record<string, unknown>>,
    retirementPlan: [] as Array<Record<string, unknown>>,
    playbookVersions: [] as Array<Record<string, unknown>>,
    integrityLog: [] as Array<Record<string, unknown>>,
  };
});

function makeSchemaProxy(name: string): Record<string, string> & { __table: string } {
  return new Proxy({ __table: name } as Record<string, string> & { __table: string }, {
    get(target, prop) {
      if (prop === "__table") return target.__table;
      if (typeof prop === "string") return prop;
      return undefined;
    },
  });
}

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ _eq: { col: String(col), val } }),
    desc: (col: unknown) => ({ _desc: String(col) }),
  };
});

vi.mock("@workspace/db", () => {
  const billsSchema = makeSchemaProxy("bills");
  const balancesSchema = makeSchemaProxy("balances");
  const assumptionsSchema = makeSchemaProxy("assumptions");
  const oneTimeExpensesSchema = makeSchemaProxy("oneTimeExpenses");
  const variableSpendSchema = makeSchemaProxy("variableSpend");
  const commissionsSchema = makeSchemaProxy("commissions");
  const retirementPlanSchema = makeSchemaProxy("retirementPlan");
  const playbookVersionsSchema = makeSchemaProxy("playbookVersions");
  const integrityLogSchema = makeSchemaProxy("integrityLog");

  function dataFor(table: unknown): Array<Record<string, unknown>> {
    const t = (table as { __table?: string })?.__table;
    switch (t) {
      case "bills":
        return fixture.bills as unknown as Array<Record<string, unknown>>;
      case "balances":
        return fixture.balances as unknown as Array<Record<string, unknown>>;
      case "assumptions":
        return fixture.assumptions as unknown as Array<Record<string, unknown>>;
      case "oneTimeExpenses":
        return fixture.oneTimeExpenses;
      case "variableSpend":
        return fixture.variableSpend;
      case "commissions":
        return fixture.commissions;
      case "retirementPlan":
        return fixture.retirementPlan;
      case "playbookVersions":
        return fixture.playbookVersions;
      case "integrityLog":
        return fixture.integrityLog;
      default:
        return [];
    }
  }

  function makeQuery(rows: Array<Record<string, unknown>>) {
    let result = [...rows];
    const chain = {
      where(cond: { _eq?: { col: string; val: unknown } }) {
        if (cond?._eq) {
          const { col, val } = cond._eq;
          result = result.filter((r) => r[col] === val);
        }
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit(n: number) {
        result = result.slice(0, n);
        return chain;
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  const insertChain = {
    values() {
      return { returning: async () => [] };
    },
  };

  return {
    db: {
      select: () => ({
        from(table: unknown) {
          return makeQuery(dataFor(table));
        },
      }),
      insert: () => insertChain,
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      delete: () => ({ where: () => ({ returning: async () => [] }) }),
    },
    bills: billsSchema,
    balances: balancesSchema,
    assumptions: assumptionsSchema,
    oneTimeExpenses: oneTimeExpensesSchema,
    variableSpend: variableSpendSchema,
    commissions: commissionsSchema,
    retirementPlan: retirementPlanSchema,
    playbookVersions: playbookVersionsSchema,
    integrityLog: integrityLogSchema,
  };
});

describe("Recurring bill paid after current-period dueDay — May 23, 2026", () => {
  const asOf = new Date("2026-05-23T00:00:00Z");

  it("Forward Reserve still holds the next-period occurrence", async () => {
    const { computeRequiredHold } = await import("./financeEngine");
    const hold = await computeRequiredHold(asOf);

    // dueDay 1-7 bills: 337.57 + 65 + 21 + 1000 = $1,423.57.
    // Before the fix Rent was excluded from forwardBills because its
    // paymentState=paid_pending_clear; FR collapsed to $423.57.
    expect(hold.forwardReserveLabel).toBeCloseTo(1423.57, 2);
  });

  it("pendingBillsOwed does NOT double-count the bill already in the forward window", async () => {
    const { computeRequiredHold } = await import("./financeEngine");
    const hold = await computeRequiredHold(asOf);

    // Rent's $1,000 is held exactly once — via the forward window. Before the
    // fix the same dollars also showed up in pendingBillsOwed ($1,000),
    // because the filter didn't dedupe against billsInHold.
    expect(hold.pendingBillsOwed).toBeCloseTo(0, 2);
  });

  it("Safe to Spend matches the live-app value ($15.43) and total hold is unchanged by attribution", async () => {
    const { computeCycleState, computeRequiredHold } = await import("./financeEngine");
    const cycle = await computeCycleState(asOf);
    const hold = await computeRequiredHold(asOf);

    // Checking $1,439 − totalRequiredHold $1,423.57 = $15.43.
    expect(hold.totalRequiredHold).toBeCloseTo(1423.57, 2);
    expect(cycle.safeToSpend).toBeCloseTo(15.43, 2);
  });

  it("engine ↔ canonical hold delta stays at $0.00 (integrity Check 11)", async () => {
    const { computeCycleState, computeRequiredHold } = await import("./financeEngine");
    const cycle = await computeCycleState(asOf);
    const hold = await computeRequiredHold(asOf);

    const CENT = 0.005;
    expect(Math.abs(cycle.totalRequiredHold - hold.totalRequiredHold)).toBeLessThan(CENT);
    expect(Math.abs(cycle.safeToSpend - hold.safeToSpend)).toBeLessThan(CENT);
  });

  it("prints the live numbers for the regression scenario", async () => {
    const { computeCycleState, computeRequiredHold } = await import("./financeEngine");
    const cycle = await computeCycleState(asOf);
    const hold = await computeRequiredHold(asOf);

    const lines = [
      `asOf:                  ${asOf.toISOString().slice(0, 10)}`,
      `checkingBalance:       $${cycle.checkingBalance.toFixed(2)}`,
      `billsDueBeforePayday:  $${hold.billsDueBeforePayday.toFixed(2)}`,
      `forwardReserve LABEL:  $${hold.forwardReserveLabel.toFixed(2)}`,
      `pendingBillsOwed:      $${hold.pendingBillsOwed.toFixed(2)}`,
      `totalRequiredHold:     $${hold.totalRequiredHold.toFixed(2)}`,
      `safeToSpend:           $${cycle.safeToSpend.toFixed(2)}`,
      `engine-vs-canonical hold delta:        $${Math.abs(cycle.totalRequiredHold - hold.totalRequiredHold).toFixed(2)}`,
    ];
    // eslint-disable-next-line no-console
    console.log("\n--- RECURRING BILL PAID (May 23, Rent paid_pending_clear) ---\n" + lines.join("\n") + "\n");
  });
});
