/**
 * cycleHold.test.ts
 * =================
 * Hermetic test for the unified hold function. Mocks @workspace/db so we can
 * exercise computeRequiredHold + computeCycleState + integrity Check 11 logic
 * against a known dataset that reproduces the bug the user reported:
 *
 *   - Today: 2026-05-22 (a nominal payday, triggers the cycle rollover)
 *   - Checking: $2,140
 *   - Bills with dueDay 1-7 summing to $897.27
 *
 * Before the fix: engine.totalRequiredHold double-counted the dueDay 1-7
 * bills (once via the rolled cycle window, once via forwardReserve). Check 11
 * reported "RequiredHold delta $897.27, SafeToSpend delta $129.00."
 *
 * After the fix: computeCycleState and computeRequiredHold share the SAME
 * code path. Forward Reserve is a label only (subset of bills already in the
 * hold). Delta must be $0.
 */
import { describe, it, expect, vi } from "vitest";

const fixture = vi.hoisted(() => {
  return {
    bills: [
      // Bills due 1-4 of next month — all fall inside the rolled cycle window
      // [May 22, June 5) and sum to exactly $897.27 (matches user's reported value).
      { id: 1, name: "Rent", amount: "600.00", dueDay: 1, frequency: "monthly", category: "essential", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "scheduled", paidDate: null, paymentStateCycleKey: null, clearedDate: null },
      { id: 2, name: "Car Insurance", amount: "182.00", dueDay: 2, frequency: "monthly", category: "essential", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "scheduled", paidDate: null, paymentStateCycleKey: null, clearedDate: null },
      { id: 3, name: "Renters", amount: "65.00", dueDay: 3, frequency: "monthly", category: "essential", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "scheduled", paidDate: null, paymentStateCycleKey: null, clearedDate: null },
      { id: 4, name: "Phone", amount: "50.27", dueDay: 4, frequency: "monthly", category: "essential", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "scheduled", paidDate: null, paymentStateCycleKey: null, clearedDate: null },
      // Mid-month bill — NOT in the rolled cycle [May 22, June 5) since June 15 > June 5
      { id: 5, name: "Mid-Month Subscription", amount: "100.00", dueDay: 15, frequency: "monthly", category: "discretionary", autopay: true, notes: null, includeInCycle: true, activeFrom: null, activeUntil: null, paymentState: "scheduled", paidDate: null, paymentStateCycleKey: null, clearedDate: null },
    ],
    balances: [
      { id: 1, accountType: "checking", amount: "2140.00", asOfDate: "2026-05-19" },
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

// Use a Proxy so `bills.dueDay` returns the string "dueDay" — lets the mock's
// where() filter resolve column references at runtime without a real ORM.
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

describe("Unified Required Hold — May 22, 2026 payday-morning scenario", () => {
  const asOf = new Date("2026-05-22T00:00:00Z");

  it("computeRequiredHold counts dueDay 1-7 bills exactly once", async () => {
    const { computeRequiredHold } = await import("./financeEngine");
    const hold = await computeRequiredHold(asOf);

    // The four dueDay 1-7 bills total $897.27 — should appear in
    // billsDueBeforePayday (because the rolled cycle [May 22, June 5)
    // captures their June 1/3/5/7 next-due-dates) but NOT a second time
    // via forwardReserve.
    expect(hold.billsDueBeforePayday).toBeCloseTo(897.27, 2);
    expect(hold.forwardReserveLabel).toBeCloseTo(897.27, 2);
    // totalRequiredHold = bills + oneTime + pending + cushion + qs + pendingBills.
    // No separate forwardReserve addend.
    expect(hold.totalRequiredHold).toBeCloseTo(897.27, 2);
    // Forward reserve is a SUBSET of bills already in the hold, not added on top.
    expect(hold.forwardReserveLabel).toBeLessThanOrEqual(hold.billsDueBeforePayday);
  });

  it("computeCycleState and computeRequiredHold produce identical totals (delta $0)", async () => {
    const { computeCycleState, computeRequiredHold } = await import("./financeEngine");
    const cycle = await computeCycleState(asOf);
    const hold = await computeRequiredHold(asOf);

    expect(Math.abs(cycle.totalRequiredHold - hold.totalRequiredHold)).toBeLessThan(0.005);
    expect(Math.abs(cycle.safeToSpend - hold.safeToSpend)).toBeLessThan(0.005);

    // SafeToSpend = max(0, checking - hold)
    const expectedSafe = Math.max(0, hold.checkingBalance - hold.totalRequiredHold);
    expect(Math.abs(cycle.safeToSpend - expectedSafe)).toBeLessThan(0.005);
  });

  it("dashboard-facing forwardReserve == forward-reserve label (no double-count)", async () => {
    const { computeCycleState } = await import("./financeEngine");
    const cycle = await computeCycleState(asOf);

    // cycle.forwardReserve is the API-surface "label" value the dashboard shows.
    // It equals the subset of bills already in the hold with dueDay 1-7.
    expect(cycle.forwardReserve).toBeCloseTo(897.27, 2);
    expect(cycle.forwardReserveBillsTotal).toBeCloseTo(897.27, 2);
    // And it must not exceed billsDueBeforePayday (subset relationship).
    expect(cycle.forwardReserve).toBeLessThanOrEqual(cycle.billsDueBeforePayday + 0.005);
  });

  it("integrity Check 11 logic returns PASS with $0 delta", async () => {
    const { computeCycleState, computeRequiredHold } = await import("./financeEngine");
    const cycle = await computeCycleState(asOf);
    const hold = await computeRequiredHold(asOf);

    const CENT = 0.005;
    const holdDelta = Math.abs(cycle.totalRequiredHold - hold.totalRequiredHold);
    const safeDelta = Math.abs(cycle.safeToSpend - hold.safeToSpend);

    expect(holdDelta).toBeLessThan(CENT);
    expect(safeDelta).toBeLessThan(CENT);
    expect(cycle.checkingBalance).toBeGreaterThanOrEqual(hold.totalRequiredHold - CENT);
  });

  it("prints the live numbers for this scenario", async () => {
    const { computeCycleState, computeRequiredHold } = await import("./financeEngine");
    const cycle = await computeCycleState(asOf);
    const hold = await computeRequiredHold(asOf);

    const lines = [
      `asOf:                  ${asOf.toISOString().slice(0, 10)}`,
      `checkingBalance:       $${cycle.checkingBalance.toFixed(2)}`,
      `billsDueBeforePayday:  $${hold.billsDueBeforePayday.toFixed(2)}`,
      `oneTimeDueBeforePay:   $${hold.oneTimeDueBeforePayday.toFixed(2)}`,
      `pendingHoldsReserve:   $${hold.pendingHoldsReserve.toFixed(2)}`,
      `minimumCushion:        $${hold.minimumCushion.toFixed(2)}`,
      `quicksilverOwed:       $${hold.quicksilverOwed.toFixed(2)}`,
      `pendingBillsOwed:      $${hold.pendingBillsOwed.toFixed(2)}`,
      `totalRequiredHold:     $${hold.totalRequiredHold.toFixed(2)}`,
      `forwardReserve LABEL:  $${hold.forwardReserveLabel.toFixed(2)}  (subset of bills above, not a separate addend)`,
      `safeToSpend:           $${cycle.safeToSpend.toFixed(2)}`,
      `engine-vs-canonical hold delta:        $${Math.abs(cycle.totalRequiredHold - hold.totalRequiredHold).toFixed(2)}`,
      `engine-vs-canonical safeToSpend delta: $${Math.abs(cycle.safeToSpend - hold.safeToSpend).toFixed(2)}`,
    ];
    // eslint-disable-next-line no-console
    console.log("\n--- CYCLE STATE (May 22 payday-morning scenario) ---\n" + lines.join("\n") + "\n");
  });

  it("collision zone: dueDay 1-7 bills in BOTH the rolled cycle AND always-hold are counted once", async () => {
    const { computeRequiredHold } = await import("./financeEngine");
    const hold = await computeRequiredHold(asOf);

    // On May 22, the rolled cycle window [May 22, June 5) captures ALL four
    // forward-reserve bills (dueDay 1, 2, 3, 4 → June 1, 2, 3, 4). They are
    // also in the always-hold set. A naive sum (no dedup) would be $1,794.54.
    // The union-by-id collapses them to one entry each: $897.27.
    const naiveDoubleCount = 897.27 + 897.27;
    expect(hold.billsDueBeforePayday).toBeCloseTo(897.27, 2);
    expect(hold.totalRequiredHold).toBeLessThan(naiveDoubleCount);
    // And the label still equals the subset, not 2x the subset.
    expect(hold.forwardReserveLabel).toBeCloseTo(897.27, 2);
  });
});

describe("Unified Required Hold — May 10, 2026 NON-payday-morning scenario", () => {
  // Mid-cycle day: cycle window is [May 10, May 22). It does NOT span the month
  // boundary, so the rolled-window mechanism does not pick up next-month day 1-7
  // bills. The always-hold forward-reserve set must therefore add them on top —
  // counted once each, no double-count (no collision on this day).
  const asOf = new Date("2026-05-10T00:00:00Z");

  it("forward-reserve bills are held even outside the cycle window", async () => {
    const { computeRequiredHold } = await import("./financeEngine");
    const hold = await computeRequiredHold(asOf);

    // Cycle bills on May 10: only the mid-month $100 bill (dueDay 15 → May 15).
    // Always-hold bills: the four dueDay 1-7 bills totalling $897.27.
    // Union (disjoint here): $100 + $897.27 = $997.27.
    expect(hold.billsDueBeforePayday).toBeCloseTo(997.27, 2);
    expect(hold.forwardReserveLabel).toBeCloseTo(897.27, 2);
    expect(hold.totalRequiredHold).toBeCloseTo(997.27, 2);
  });

  it("engine and canonical hold agree (delta $0) on a non-payday day", async () => {
    const { computeCycleState, computeRequiredHold } = await import("./financeEngine");
    const cycle = await computeCycleState(asOf);
    const hold = await computeRequiredHold(asOf);

    expect(Math.abs(cycle.totalRequiredHold - hold.totalRequiredHold)).toBeLessThan(0.005);
    expect(Math.abs(cycle.safeToSpend - hold.safeToSpend)).toBeLessThan(0.005);
    expect(cycle.safeToSpend).toBeCloseTo(
      Math.max(0, cycle.checkingBalance - hold.totalRequiredHold),
      2,
    );
  });

  it("prints the live numbers for the non-payday-day scenario", async () => {
    const { computeCycleState, computeRequiredHold } = await import("./financeEngine");
    const cycle = await computeCycleState(asOf);
    const hold = await computeRequiredHold(asOf);

    const lines = [
      `asOf:                  ${asOf.toISOString().slice(0, 10)}`,
      `checkingBalance:       $${cycle.checkingBalance.toFixed(2)}`,
      `billsDueBeforePayday:  $${hold.billsDueBeforePayday.toFixed(2)}`,
      `forwardReserve LABEL:  $${hold.forwardReserveLabel.toFixed(2)}`,
      `totalRequiredHold:     $${hold.totalRequiredHold.toFixed(2)}`,
      `safeToSpend:           $${cycle.safeToSpend.toFixed(2)}`,
      `engine-vs-canonical hold delta:        $${Math.abs(cycle.totalRequiredHold - hold.totalRequiredHold).toFixed(2)}`,
      `engine-vs-canonical safeToSpend delta: $${Math.abs(cycle.safeToSpend - hold.safeToSpend).toFixed(2)}`,
    ];
    // eslint-disable-next-line no-console
    console.log("\n--- CYCLE STATE (May 10 non-payday-day scenario) ---\n" + lines.join("\n") + "\n");
  });
});
