/**
 * dashboard.june-unemployment.test.ts
 * ===================================
 * RECONCILIATION ARTIFACT — Reserve Cadence Correction PRD §5 (+ follow-up).
 *
 * Drives the dashboard with the user's REAL June 2026 inputs after the
 * cadence-correction fix:
 *   - checking = real latest balance ($1,811)
 *   - the 11 real bills with their real paid/unpaid states
 *   - weekly cadence, anchor + start 2026-06-24, net_per_period $750, 0 tax
 *   - commission CLEARED (empty table)
 *   - variable R: override CLEARED → prorated remaining default ($500)
 *
 * INCOME FIX — VERIFIED CORRECT. June totalMonthIncome = $750 (exactly one
 * deposit, 2026-06-24; the phantom June 3/10/17 are excluded by pay_start_date;
 * commission is $0). PRD §0 ground-truth income figure. Asserted below.
 *
 * HEADLINE SAVABLE = availableToInvest ≈ $500 — ACCEPTANCE PASSES. Per the
 * user's Option A, the savable is checking-anchored and re-based to a
 * remaining-obligations basis:
 *     availableToInvest = checking − billsNotYetDebited − oneTimeStillToPay
 *                       − R(prorated) − earlyNextMonthVariable
 *                       = 1811 − 493 − 143 − 500 − 130 = $545  (∈ [450,550])
 * The next-month forward reserve stays ONLY in the cycle hold (Safe to Spend),
 * never subtracted here — counted once. Variable counted once (prorated R).
 *
 * DISCRETIONARY HEADLINE — left as-is by design (-$2,086.52 with R cleared to
 * the full-cap fallback). It is the full-month income-vs-obligation ledger and
 * June is a transition month (last month's paycheck paid this month's early
 * bills, so the full month's bills are charged against the single $750
 * deposit); it normalizes next month. The `.skip`'d [$450,$550] assertion
 * documents that this ledger is NOT the ~$500 savable — that's availableToInvest.
 *
 * Hermetic — same db/drizzle mock harness as dashboard.golden.test.ts. Clock
 * pinned to 2026-06-06 noon UTC (the real "today").
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";

const fixture = vi.hoisted(() => {
  const bill = (
    id: number,
    name: string,
    amount: string,
    dueDay: number,
    category: string,
    includeInCycle: boolean,
    paymentState: string,
  ) => ({
    id,
    name,
    amount,
    dueDay,
    frequency: "monthly",
    category,
    autopay: true,
    notes: null,
    includeInCycle,
    activeFrom: null,
    activeUntil: null,
    paymentState,
    paidDate: null,
    paymentStateCycleKey: paymentState === "scheduled" ? null : "2026-06",
    clearedDate: null,
  });
  const ote = (
    id: number,
    description: string,
    amount: string,
    dueDate: string | null,
    paid: boolean,
    deferred: boolean,
  ) => ({ id, description, amount, dueDate, paid, deferred, notes: null });
  return {
    // 11 real bills (export og_data_export.sql). 10 include=TRUE + gym (FALSE).
    bills: [
      bill(37, "Car Loan (2024 Camry)", "337.57", 1, "debt", true, "paid"),
      bill(34, "Phone (Verizon)", "65.00", 2, "essential", true, "paid"),
      bill(33, "Gym Membership", "27.00", 2, "discretionary", false, "scheduled"),
      bill(35, "Claude Subscription", "21.00", 3, "discretionary", true, "paid"),
      bill(36, "Rent", "1000.00", 4, "essential", true, "paid"),
      bill(38, "Car Insurance", "141.95", 8, "essential", true, "paid"),
      bill(39, "YouTube Premium", "14.00", 15, "discretionary", true, "paid"),
      bill(40, "Electric", "142.00", 18, "essential", true, "late_unpaid"),
      bill(43, "Capital One QuickSilver (variable)", "278.00", 18, "variable", true, "late_unpaid"),
      bill(41, "Gas", "73.00", 19, "essential", true, "late_unpaid"),
      bill(44, "Replit Subscription", "21.00", 21, "discretionary", true, "paid"),
    ],
    balances: [
      { id: 95, accountType: "checking", amount: "1811.00", asOfDate: "2026-05-25" },
    ],
    assumptions: [
      { key: "variable_spend_cap", value: "600" },
      { key: "alert_threshold", value: "400" },
      { key: "minimum_cushion", value: "0" },
      { key: "pending_holds_reserve", value: "0" },
      { key: "month_length_days", value: "30.4" },
      { key: "mrr_target", value: "700" },
      { key: "nrr_target", value: "6000" },
      { key: "commission_tax_rate", value: "0.435" },
      { key: "hysa_target", value: "15000" },
      { key: "variable_spend_until_payday", value: "250" },
      { key: "quicksilver_balance_owed", value: "" },
      { key: "base_net_income", value: "3520" },
      // Override CLEARED → prorated remaining-variable default applies (R-as-truth).
      // (Live app: clear the stale 0 or tap the Overview "Prorate" helper.)
      { key: "planned_variable_remaining_override", value: "" },
      // Ground-truth cadence config (seedCadence.ts after correction):
      { key: "pay_cadence", value: "weekly" },
      { key: "pay_anchor_date", value: "2026-06-24" },
      { key: "pay_start_date", value: "2026-06-24" },
      { key: "net_per_period", value: "750.00" },
      { key: "pay_tax_rate", value: "0" },
      { key: "pay_weekend_shift", value: "prior_business_day" },
    ],
    oneTimeExpenses: [
      ote(6, "PPG", "143.00", "2026-06-30", false, false),
      ote(7, "NYS Taxes", "354.00", "2026-09-30", false, false),
      ote(8, "Mimi Car", "1000.00", "2026-07-31", false, false),
      ote(1, "Parking Ticket Franklin", "50.00", "2026-05-28", true, false),
      ote(9, "EZ-Pass top-up", "30.00", "2026-06-01", true, false),
    ],
    variableSpend: [] as Array<Record<string, unknown>>,
    commissions: [] as Array<Record<string, unknown>>, // CLEARED
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
    ne: (col: unknown, val: unknown) => ({ _ne: { col: String(col), val } }),
    and: (...conds: unknown[]) => ({ _and: conds }),
    desc: (col: unknown) => ({ _desc: String(col) }),
  };
});

vi.mock("@workspace/db", () => {
  const schemas = {
    bills: makeSchemaProxy("bills"),
    balances: makeSchemaProxy("balances"),
    assumptions: makeSchemaProxy("assumptions"),
    oneTimeExpenses: makeSchemaProxy("oneTimeExpenses"),
    variableSpend: makeSchemaProxy("variableSpend"),
    commissions: makeSchemaProxy("commissions"),
    retirementPlan: makeSchemaProxy("retirementPlan"),
    playbookVersions: makeSchemaProxy("playbookVersions"),
    integrityLog: makeSchemaProxy("integrityLog"),
  };
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
        return fixture.oneTimeExpenses as unknown as Array<Record<string, unknown>>;
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
  return {
    db: {
      select: () => ({
        from(table: unknown) {
          return makeQuery(dataFor(table));
        },
      }),
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      delete: () => ({ where: () => ({ returning: async () => [] }) }),
    },
    ...schemas,
  };
});

describe("June unemployment — discretionary reconciliation (clock=2026-06-06)", () => {
  let app: express.Express;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-06T12:00:00.000Z"));
    const router = (await import("./dashboard")).default;
    app = express();
    app.use(router);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("DIAGNOSTIC — full income + outgo line items", async () => {
    const res = await request(app).get("/dashboard/discretionary");
    expect(res.status).toBe(200);
    const b = res.body;
    expect({
      // income
      paychecksReceivedThisMonth: b.paychecksReceivedThisMonth,
      expectedRemainingPaychecks: b.expectedRemainingPaychecks,
      paycheckBreakdown: b.paycheckBreakdown,
      commissionPaidThisMonth: b.commissionPaidThisMonth,
      commissionPendingThisMonth: b.commissionPendingThisMonth,
      totalMonthIncome: b.totalMonthIncome,
      // outgo
      billsThisMonth: b.billsThisMonth,
      billsRemainingThisMonth: b.billsRemainingThisMonth,
      billsPaidThisMonth: b.billsPaidThisMonth,
      variableLoggedThisMonth: b.variableLoggedThisMonth,
      variableExpectedRemaining: b.variableExpectedRemaining,
      monthVariableObligation: b.monthVariableObligation,
      oneTimeMonthObligated: b.oneTimeMonthObligated,
      totalMonthOutgo: b.totalMonthOutgo,
      // headline
      discretionaryThisMonth: b.discretionaryThisMonth,
      nextEffectivePayday: b.nextEffectivePayday,
    }).toMatchInlineSnapshot(`
      {
        "billsPaidThisMonth": 1600.52,
        "billsRemainingThisMonth": 493,
        "billsThisMonth": 2093.52,
        "commissionPaidThisMonth": 0,
        "commissionPendingThisMonth": 0,
        "discretionaryThisMonth": -2086.52,
        "expectedRemainingPaychecks": 750,
        "monthVariableObligation": 600,
        "nextEffectivePayday": "2026-06-24",
        "oneTimeMonthObligated": 143,
        "paycheckBreakdown": [
          {
            "appliedAmount": 750,
            "baseAmount": 750,
            "overrideAmount": null,
            "paydayDate": "2026-06-24",
            "received": false,
          },
        ],
        "paychecksReceivedThisMonth": 0,
        "totalMonthIncome": 750,
        "totalMonthOutgo": 2836.52,
        "variableExpectedRemaining": 600,
        "variableLoggedThisMonth": 0,
      }
    `);

    // INCOME FIX — these ARE the PRD ground truth and they pass.
    expect(b.totalMonthIncome).toBe(750); // 1 × $750, June 24 only
    expect(b.commissionPaidThisMonth).toBe(0);
    expect(b.commissionPendingThisMonth).toBe(0);
    expect(b.paychecksReceivedThisMonth).toBe(0);
    expect(b.expectedRemainingPaychecks).toBe(750);
    expect(b.paycheckBreakdown).toHaveLength(1); // phantom 06-03/10/17 excluded
    expect(b.paycheckBreakdown[0].paydayDate).toBe("2026-06-24");
    expect(b.nextEffectivePayday).toBe("2026-06-24");
  });

  // Intentionally SKIPPED — the discretionary full-month ledger is NOT the
  // ~$500 savable (that's availableToInvest; see the acceptance test below).
  // Discretionary is left as-is by design (transition month, normalizes next
  // month); it is -$2,086.52 here. Do NOT enable by reshaping discretionary.
  it.skip("June discretionaryThisMonth ∈ [$450, $550] (PRD target ≈ $500)", async () => {
    const res = await request(app).get("/dashboard/discretionary");
    expect(res.body.discretionaryThisMonth).toBeGreaterThanOrEqual(450);
    expect(res.body.discretionaryThisMonth).toBeLessThanOrEqual(550);
  });

  it("DIAGNOSTIC — checking-anchored cash position (user's 'savable' lens)", async () => {
    const res = await request(app).get("/dashboard/cash-position");
    expect(res.status).toBe(200);
    const b = res.body;
    expect({
      currentChecking: b.currentChecking,
      incomeStillToReceive: b.incomeStillToReceive,
      paychecksStillExpected: b.paychecksStillExpected,
      billsAlreadyDebited: b.billsAlreadyDebited,
      billsNotYetDebited: b.billsNotYetDebited,
      oneTimeStillToPay: b.oneTimeStillToPay,
      variableExpectedRemaining: b.variableExpectedRemaining,
      commitmentBalance: b.commitmentBalance,
      availableToInvest: b.availableToInvest,
      projectedEndOfMonthChecking: b.projectedEndOfMonthChecking,
    }).toMatchInlineSnapshot(`
      {
        "availableToInvest": 545,
        "billsAlreadyDebited": 1600.52,
        "billsNotYetDebited": 493,
        "commitmentBalance": -282.52,
        "currentChecking": 1811,
        "incomeStillToReceive": 750,
        "oneTimeStillToPay": 143,
        "paychecksStillExpected": [
          {
            "amount": 750,
            "date": "2026-06-24",
          },
        ],
        "projectedEndOfMonthChecking": 1425,
        "variableExpectedRemaining": 500,
      }
    `);
  });

  // ACCEPTANCE — the re-based `availableToInvest` IS the user's "~$500 savable".
  //
  // Decision (user, Option A): the headline savable is checking-anchored, NOT
  // the full-month discretionary ledger. The endpoint now computes:
  //   availableToInvest = checking
  //           − billsNotYetDebited      (this month's remaining bills)
  //           − oneTimeStillToPay       (this month's remaining one-time)
  //           − R                       (this month's PRORATED remaining variable)
  //           − earlyNextMonthVariable  (next month's first-week variable)
  // The next-month forward reserve is NOT subtracted here — it lives in the
  // cycle hold (Safe to Spend) as a separate bucket, so next month's early
  // bills are counted exactly once. Variable is counted once (prorated R only).
  //
  // PRORATED R: variable cap $600 resets monthly; on 2026-06-06 we are 5 days
  // in with 25 days left → R = cap × daysRemaining / daysInMonth = 600×25/30
  // = $500 (override cleared → prorated default; matches the "Prorate" helper).
  it("availableToInvest IS the re-based savable ≈ $500 (prorated R)", async () => {
    const res = await request(app).get("/dashboard/cash-position");
    const b = res.body;

    // R = prorated current-month variable now that the override is cleared.
    expect(b.variableExpectedRemaining).toBe(500);

    // The endpoint headline equals the user's reconciliation, line for line.
    const expected =
      b.currentChecking -
      b.billsNotYetDebited -
      b.oneTimeStillToPay -
      b.variableExpectedRemaining -
      b.earlyNextMonthVariable;
    expect(b.availableToInvest).toBeCloseTo(expected, 2);

    expect({
      currentChecking: b.currentChecking,
      billsNotYetDebited: b.billsNotYetDebited,
      oneTimeStillToPay: b.oneTimeStillToPay,
      variableExpectedRemaining: b.variableExpectedRemaining,
      earlyNextMonthVariable: b.earlyNextMonthVariable,
      availableToInvest: b.availableToInvest,
    }).toMatchInlineSnapshot(`
      {
        "availableToInvest": 545,
        "billsNotYetDebited": 493,
        "currentChecking": 1811,
        "earlyNextMonthVariable": 130,
        "oneTimeStillToPay": 143,
        "variableExpectedRemaining": 500,
      }
    `);

    // PRD target: within 10% of $500.
    expect(b.availableToInvest).toBeGreaterThanOrEqual(450);
    expect(b.availableToInvest).toBeLessThanOrEqual(550);
  });
});
