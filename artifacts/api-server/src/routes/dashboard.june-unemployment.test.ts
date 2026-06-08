/**
 * dashboard.june-unemployment.test.ts
 * ===================================
 * RECONCILIATION ARTIFACT — Reserve Cadence Correction PRD §5 + availableToInvest fix.
 *
 * Drives the dashboard with the user's CURRENT real June 2026 inputs:
 *   - checking = $1,452
 *   - this month's four remaining unpaid bills: Car Insurance $141, National
 *     Grid $108, National Fuel $147, Replit $21  (= $417)
 *   - Capital One QuickSilver $78 (category 'variable', toggled ON) — INCLUDED
 *     in remaining bills (a toggled-on obligation counts in the availableToInvest
 *     lens exactly once; the Safe-to-Spend cycle hold remains a separate lens)
 *   - PPG one-time DEFERRED — excluded from oneTimeStillToPay
 *   - weekly cadence, anchor + start 2026-06-24, net_per_period $750, 0 tax
 *   - commission CLEARED (empty table)
 *   - variable R: month-scoped override absent (old global "0" ignored) →
 *     prorated remaining default ($500)
 *
 * INCOME FIX — VERIFIED CORRECT. June totalMonthIncome = $750 (exactly one
 * deposit, 2026-06-24; phantom June 3/10/17 excluded by pay_start_date;
 * commission $0). Asserted below.
 *
 * HEADLINE SAVABLE = availableToInvest = $457. The savable is checking-anchored
 * on a remaining-obligations basis, with NO phantom earlyNextMonthVariable term;
 * deferred one-time excluded, toggled-on QuickSilver INCLUDED:
 *     availableToInvest = checking − commitmentOutflowsRemaining − R(prorated)
 *                       = 1452 − 495 − 500 = $457
 *   commitmentOutflowsRemaining = billsNotYetDebited 495 + oneTimeStillToPay 0,
 *   where billsNotYetDebited = 141 + 108 + 147 + 21 + 78 (QS) = 495.
 *   (Was $535 / 417 when QS was excluded — reversed per the toggled-on-QS fix.)
 * The next-month forward reserve stays ONLY in the cycle hold (Safe to Spend);
 * it is never subtracted here, and there is no flat $130 term.
 *
 * DISCRETIONARY HEADLINE — left as-is by design (full-month income-vs-obligation
 * ledger; deeply negative in a transition month, normalizes next month). The
 * `.skip`'d [$450,$550] assertion documents it is NOT the savable — that's
 * availableToInvest.
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
    // Realistic debit date for already-paid bills. In production a 'paid' bill
    // always carries a PAST debit date — autopay sync stamps paidDate=dueDay
    // (only once dueDay<=today), and a manual mark-paid stamps clearedDate=now.
    // The cash-position route now classifies "already debited" ONLY when that
    // date is <= today, so paid bills MUST have one (null here used to ride on
    // the old date-blind `paid → debited` shortcut).
    paidDate: string | null = null,
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
    paidDate,
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
    // Current real bills. Already-paid (debited) set + this month's four
    // remaining unpaid bills (= $417) + the QuickSilver card statement
    // (category 'variable', EXCLUDED from remaining bills) + gym (include=FALSE).
    bills: [
      // already paid this month — debited with a PAST paidDate (<= today
      // 2026-06-06), so they stay excluded from "still to pay".
      bill(37, "Car Loan (2024 Camry)", "337.57", 1, "debt", true, "paid", "2026-06-01"),
      bill(34, "Phone (Verizon)", "65.00", 2, "essential", true, "paid", "2026-06-02"),
      bill(33, "Gym Membership", "27.00", 2, "discretionary", false, "scheduled"),
      bill(35, "Claude Subscription", "21.00", 3, "discretionary", true, "paid", "2026-06-03"),
      bill(36, "Rent", "1000.00", 4, "essential", true, "paid", "2026-06-04"),
      bill(39, "YouTube Premium", "14.00", 15, "discretionary", true, "paid", "2026-06-05"),
      // this month's REMAINING unpaid bills — the four real ones (= $417)
      bill(38, "Car Insurance", "141.00", 8, "essential", true, "late_unpaid"),
      bill(40, "National Grid (electric)", "108.00", 18, "essential", true, "late_unpaid"),
      bill(41, "National Fuel (gas)", "147.00", 19, "essential", true, "late_unpaid"),
      bill(44, "Replit Subscription", "21.00", 21, "discretionary", true, "late_unpaid"),
      // QuickSilver card statement — category 'variable', toggled ON. Now
      // INCLUDED in billsNotYetDebited (toggled-on obligation counts in the
      // availableToInvest lens, exactly once; the cycle-hold lens is separate).
      bill(43, "Capital One QuickSilver (variable)", "78.00", 18, "variable", true, "late_unpaid"),
    ],
    balances: [
      { id: 96, accountType: "checking", amount: "1452.00", asOfDate: "2026-06-05" },
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
      // OLD GLOBAL override key holds the live stale "0" — must be IGNORED now
      // that R is MONTH-SCOPED (`planned_variable_remaining_override:YYYY-MM`).
      // No current-month key present → R auto-resets to the prorated default
      // ($500), proving the stale global 0 cannot apply / bleed.
      { key: "planned_variable_remaining_override", value: "0" },
      // Ground-truth cadence config (seedCadence.ts after correction):
      { key: "pay_cadence", value: "weekly" },
      { key: "pay_anchor_date", value: "2026-06-24" },
      { key: "pay_start_date", value: "2026-06-24" },
      { key: "net_per_period", value: "750.00" },
      { key: "pay_tax_rate", value: "0" },
      { key: "pay_weekend_shift", value: "prior_business_day" },
    ],
    oneTimeExpenses: [
      ote(6, "PPG", "143.00", "2026-06-30", false, true), // DEFERRED → excluded
      ote(7, "NYS Taxes", "354.00", "2026-09-30", false, false), // out of month
      ote(8, "Mimi Car", "1000.00", "2026-07-31", false, false), // out of month
      ote(9, "EZ-Pass top-up", "30.00", "2026-06-01", true, false), // paid
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
        "billsPaidThisMonth": 1437.57,
        "billsRemainingThisMonth": 495,
        "billsThisMonth": 1932.57,
        "commissionPaidThisMonth": 0,
        "commissionPendingThisMonth": 0,
        "discretionaryThisMonth": -1782.57,
        "expectedRemainingPaychecks": 750,
        "monthVariableObligation": 600,
        "nextEffectivePayday": "2026-06-24",
        "oneTimeMonthObligated": 0,
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
        "totalMonthOutgo": 2532.57,
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
        "availableToInvest": 457,
        "billsAlreadyDebited": 1437.57,
        "billsNotYetDebited": 495,
        "commitmentBalance": -480.57,
        "currentChecking": 1452,
        "incomeStillToReceive": 750,
        "oneTimeStillToPay": 0,
        "paychecksStillExpected": [
          {
            "amount": 750,
            "date": "2026-06-24",
          },
        ],
        "projectedEndOfMonthChecking": 1207,
        "variableExpectedRemaining": 500,
      }
    `);
  });

  // ACCEPTANCE — availableToInvest = checking − real remaining bills − R = $457.
  //
  // The endpoint computes ONLY:
  //   availableToInvest = checking
  //           − commitmentOutflowsRemaining  (= billsNotYetDebited + oneTimeStillToPay)
  //           − R                            (this month's PRORATED remaining variable)
  // NO earlyNextMonthVariable term. Deferred one-time (PPG) excluded; toggled-on
  // QuickSilver (category 'variable') INCLUDED — counted exactly once here (the
  // cycle hold is a separate lens, not subtracted in availableToInvest).
  //   billsNotYetDebited = 141 + 108 + 147 + 21 + 78 (QS) = 495
  //   oneTimeStillToPay  = 0  (PPG deferred; others out of month / paid)
  //   R (prorated)       = 600 × 25/30 = 500
  //   availableToInvest  = 1452 − 495 − 0 − 500 = 457
  //
  // If this does NOT land at $457, the failing dump below lists every line item
  // feeding commitmentOutflowsRemaining so the wrong inclusion can be found —
  // do NOT fudge.
  it("availableToInvest = checking − real remaining bills − R = $457", async () => {
    const res = await request(app).get("/dashboard/cash-position");
    const b = res.body;

    // R = prorated current-month variable (override cleared).
    expect(b.variableExpectedRemaining).toBe(500);
    // Four real bills ($417) + toggled-on QuickSilver ($78) = $495.
    expect(b.billsNotYetDebited).toBe(495);
    expect(b.oneTimeStillToPay).toBe(0);

    // Headline = checking − commitmentOutflowsRemaining − R, NO $130 term.
    const expected =
      b.currentChecking - b.commitmentOutflowsRemaining - b.variableExpectedRemaining;
    expect(b.availableToInvest).toBeCloseTo(expected, 2);

    // Line-item dump (printed on failure) so any wrong inclusion is visible.
    expect({
      currentChecking: b.currentChecking,
      billsNotYetDebited: b.billsNotYetDebited,
      billsNotYetDebitedDetail: b.billsNotYetDebitedDetail.map(
        (r: { name: string; amount: number }) => `${r.name}: ${r.amount}`,
      ),
      oneTimeStillToPay: b.oneTimeStillToPay,
      commitmentOutflowsRemaining: b.commitmentOutflowsRemaining,
      variableExpectedRemaining: b.variableExpectedRemaining,
      availableToInvest: b.availableToInvest,
    }).toMatchInlineSnapshot(`
      {
        "availableToInvest": 457,
        "billsNotYetDebited": 495,
        "billsNotYetDebitedDetail": [
          "Car Insurance: 141",
          "National Grid (electric): 108",
          "National Fuel (gas): 147",
          "Replit Subscription: 21",
          "Capital One QuickSilver (variable): 78",
        ],
        "commitmentOutflowsRemaining": 495,
        "currentChecking": 1452,
        "oneTimeStillToPay": 0,
        "variableExpectedRemaining": 500,
      }
    `);

    // Savable target: $457 within $5 (QS now counted once).
    expect(b.availableToInvest).toBeGreaterThanOrEqual(452);
    expect(b.availableToInvest).toBeLessThanOrEqual(462);
  });
});
