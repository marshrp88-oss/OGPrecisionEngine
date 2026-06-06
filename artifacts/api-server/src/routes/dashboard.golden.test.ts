/**
 * dashboard.golden.test.ts
 * ========================
 * GOLDEN REGRESSION NET — Pay-Cadence Generalization PRD, Commit 1 (tests only).
 *
 * Purpose: freeze the CURRENT cash-position + payday-schedule outputs under the
 * LEGACY semi-monthly (7th/22nd) configuration. The cadence generalization
 * (commits 3-4) must be behavior-preserving: with NO cadence assumption keys
 * set, every value captured here MUST reproduce EXACTLY.
 *
 * CONTRACT: if a snapshot below diverges after a logic change, HALT and report.
 * Do NOT re-run vitest with `-u` to "update" expectations — that defeats the
 * seatbelt. The inline snapshots ARE the contract.
 *
 * Two layers are covered:
 *   1. Sealed adapter (deriveNextPayday / computeCycleState) — driven directly
 *      via the deterministic `asOf` parameter. This is where the adapter-seam
 *      cadence change lands, and where rollover correctness lives.
 *   2. Dashboard routes (/dashboard/discretionary, /dashboard/cash-position) —
 *      these read the wall clock (`new Date()`), so the clock is pinned with
 *      fake timers. Covers paycheckBreakdown + discipline ratios + availableToInvest,
 *      which are computed inline in the handlers from the [7,22] / `/2` hardcodes.
 *
 * Hermetic: `@workspace/db` and `drizzle-orm` are mocked with a hoisted fixture
 * (same harness as cycleHold.test.ts). `@workspace/finance` (the real engine) is
 * NOT mocked — it is the code under test.
 *
 * TZ NOTE: the route layer builds dates from LOCAL calendar components, so these
 * golden values are timezone-relative. The system clock is pinned to noon UTC
 * (stable across UTC-12..UTC+11). Run in the same TZ used to capture.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";

// ---- Legacy semi-monthly fixture (NO pay_cadence / pay_anchor_date keys) ----
const fixture = vi.hoisted(() => {
  const bill = (
    id: number,
    name: string,
    amount: string,
    dueDay: number,
    category = "essential",
  ) => ({
    id,
    name,
    amount,
    dueDay,
    frequency: "monthly",
    category,
    autopay: true,
    notes: null,
    includeInCycle: true,
    activeFrom: null,
    activeUntil: null,
    paymentState: "scheduled",
    paidDate: null,
    paymentStateCycleKey: null,
    clearedDate: null,
  });
  return {
    bills: [
      bill(1, "Rent", "600.00", 1),
      bill(2, "Car Insurance", "182.00", 2),
      bill(3, "Renters", "65.00", 3),
      bill(4, "Phone", "50.27", 4),
      bill(5, "Mid-Month Subscription", "100.00", 15, "discretionary"),
      bill(6, "Internet", "80.00", 20),
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
      { key: "commission_tax_rate", value: "0.435" },
      { key: "mrr_target", value: "700" },
      { key: "nrr_target", value: "6000" },
    ],
    oneTimeExpenses: [] as Array<Record<string, unknown>>,
    variableSpend: [] as Array<Record<string, unknown>>,
    commissions: [] as Array<Record<string, unknown>>,
    retirementPlan: [] as Array<Record<string, unknown>>,
    playbookVersions: [] as Array<Record<string, unknown>>,
    integrityLog: [] as Array<Record<string, unknown>>,
  };
});

// Schema proxy: `bills.dueDay` -> the string "dueDay" so the mock's where()
// can resolve column refs without a real ORM. (Mirrors cycleHold.test.ts.)
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

const iso = (d: Date | null | undefined) =>
  d ? d.toISOString().split("T")[0] : null;

// ============================================================
// Layer 1 — sealed adapter, deterministic via asOf
// ============================================================
describe("Golden: payday schedule (legacy semi-monthly, adapter layer)", () => {
  const u = (s: string) => new Date(s + "T00:00:00.000Z");

  it("deriveNextPayday across the cycle", async () => {
    // deriveNextPayday is async (cadence-aware single source as of Commit 4);
    // values are unchanged under the legacy semi-monthly config.
    const { deriveNextPayday } = await import("../lib/financeEngine");
    const snap = {
      may01_before7th: iso(await deriveNextPayday(u("2026-05-01"))),
      may19_midCycle: iso(await deriveNextPayday(u("2026-05-19"))),
      may21_paydayMinus1: iso(await deriveNextPayday(u("2026-05-21"))),
      may22_onPayday: iso(await deriveNextPayday(u("2026-05-22"))),
      may23_paydayPlus1: iso(await deriveNextPayday(u("2026-05-23"))),
      may31_afterBoth: iso(await deriveNextPayday(u("2026-05-31"))),
    };
    expect(snap).toMatchInlineSnapshot(`
      {
        "may01_before7th": "2026-05-07",
        "may19_midCycle": "2026-05-22",
        "may21_paydayMinus1": "2026-05-22",
        "may22_onPayday": "2026-05-22",
        "may23_paydayPlus1": "2026-06-05",
        "may31_afterBoth": "2026-06-05",
      }
    `);
  });

  it("computeCycleState — mid-cycle (May 19)", async () => {
    const { computeCycleState } = await import("../lib/financeEngine");
    const c = await computeCycleState(u("2026-05-19"));
    expect({
      safeToSpend: c.safeToSpend,
      totalRequiredHold: c.totalRequiredHold,
      forwardReserve: c.forwardReserve,
      billsDueBeforePayday: c.billsDueBeforePayday,
      dailyRateRealTime: c.dailyRateRealTime,
      daysUntilPayday: c.daysUntilPayday,
      nextPayday: iso(c.nextPayday),
      status: c.status,
    }).toMatchInlineSnapshot(`
      {
        "billsDueBeforePayday": 977.27,
        "dailyRateRealTime": 387.57666666666665,
        "daysUntilPayday": 3,
        "forwardReserve": 897.27,
        "nextPayday": "2026-05-22",
        "safeToSpend": 1162.73,
        "status": "GREEN",
        "totalRequiredHold": 977.27,
      }
    `);
  });

  it("computeCycleState — payday-morning rollover (May 22) and neighbours", async () => {
    const { computeCycleState } = await import("../lib/financeEngine");
    const pick = (c: Awaited<ReturnType<typeof computeCycleState>>) => ({
      safeToSpend: c.safeToSpend,
      totalRequiredHold: c.totalRequiredHold,
      forwardReserve: c.forwardReserve,
      daysUntilPayday: c.daysUntilPayday,
      nextPayday: iso(c.nextPayday),
      status: c.status,
    });
    const snap = {
      may21_paydayMinus1: pick(await computeCycleState(u("2026-05-21"))),
      may22_onPayday: pick(await computeCycleState(u("2026-05-22"))),
      may23_paydayPlus1: pick(await computeCycleState(u("2026-05-23"))),
    };
    expect(snap).toMatchInlineSnapshot(`
      {
        "may21_paydayMinus1": {
          "daysUntilPayday": 1,
          "forwardReserve": 897.27,
          "nextPayday": "2026-05-22",
          "safeToSpend": 1242.73,
          "status": "GREEN",
          "totalRequiredHold": 897.27,
        },
        "may22_onPayday": {
          "daysUntilPayday": 14,
          "forwardReserve": 897.27,
          "nextPayday": "2026-06-05",
          "safeToSpend": 1242.73,
          "status": "GREEN",
          "totalRequiredHold": 897.27,
        },
        "may23_paydayPlus1": {
          "daysUntilPayday": 13,
          "forwardReserve": 897.27,
          "nextPayday": "2026-06-05",
          "safeToSpend": 1242.73,
          "status": "GREEN",
          "totalRequiredHold": 897.27,
        },
      }
    `);
  });
});

// ============================================================
// Layer 2 — dashboard routes, clock pinned to 2026-05-19
// ============================================================
describe("Golden: dashboard routes (legacy semi-monthly, clock=2026-05-19)", () => {
  let app: express.Express;

  beforeAll(async () => {
    // Fake ONLY Date so supertest's real timers keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-19T12:00:00.000Z"));
    const router = (await import("./dashboard")).default;
    app = express();
    app.use(router);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("/dashboard/discretionary — payday + discipline golden", async () => {
    const res = await request(app).get("/dashboard/discretionary");
    expect(res.status).toBe(200);
    const b = res.body;
    expect({
      nextEffectivePayday: b.nextEffectivePayday,
      paychecksReceivedThisMonth: b.paychecksReceivedThisMonth,
      paychecksReceivedCount: b.paychecksReceivedCount,
      expectedRemainingPaychecks: b.expectedRemainingPaychecks,
      paycheckBreakdown: b.paycheckBreakdown,
      fixedRatio: b.discipline.fixedRatio,
      savingsRate: b.discipline.savingsRate,
      fixedMonthlyTotal: b.discipline.fixedMonthlyTotal,
      safeToSpend: b.safeToSpend,
      forwardReserve: b.forwardReserve,
      monthlySavings: b.monthlySavings,
      discretionaryThisMonth: b.discretionaryThisMonth,
    }).toMatchInlineSnapshot(`
      {
        "discretionaryThisMonth": 1542.73,
        "expectedRemainingPaychecks": 1610,
        "fixedMonthlyTotal": 1077.27,
        "fixedRatio": 0.335,
        "forwardReserve": 897.27,
        "monthlySavings": 1442.73,
        "nextEffectivePayday": "2026-05-22",
        "paycheckBreakdown": [
          {
            "appliedAmount": 1610,
            "baseAmount": 1610,
            "overrideAmount": null,
            "paydayDate": "2026-05-07",
            "received": true,
          },
          {
            "appliedAmount": 1610,
            "baseAmount": 1610,
            "overrideAmount": null,
            "paydayDate": "2026-05-22",
            "received": false,
          },
        ],
        "paychecksReceivedCount": 1,
        "paychecksReceivedThisMonth": 1610,
        "safeToSpend": 1162.73,
        "savingsRate": 0.448,
      }
    `);
  });

  // RE-BASELINED (user decision, Option A): `availableToInvest` was re-based to
  // the remaining-obligations savable —
  //   checking − billsNotYetDebited − oneTimeStillToPay − R(prorated) − earlyNext
  // — and R's unset-default changed from full cap to the PRORATED remaining
  // variable. The next-month forward reserve now lives ONLY in the cycle hold,
  // never subtracted here. Two values move vs the prior (obsolete) baseline:
  //   availableToInvest         432.73 → 681.12   (full-hold basis → remaining basis)
  //   projectedEndOfMonthChecking 2072.73 → 2421.12 (R 600 full cap → 251.61 prorated)
  // May 19, 31-day month: prorated R = 600 × 13/31 = 251.61. commitmentBalance
  // (checking − full hold) is unchanged — kept as a diagnostic cross-reference.
  it("/dashboard/cash-position — availableToInvest golden", async () => {
    const res = await request(app).get("/dashboard/cash-position");
    expect(res.status).toBe(200);
    const b = res.body;
    expect({
      asOf: b.asOf,
      currentChecking: b.currentChecking,
      incomeStillToReceive: b.incomeStillToReceive,
      paychecksStillExpected: b.paychecksStillExpected,
      commitmentOutflowsRemaining: b.commitmentOutflowsRemaining,
      commitmentBalance: b.commitmentBalance,
      availableToInvest: b.availableToInvest,
      earlyNextMonthVariable: b.earlyNextMonthVariable,
      projectedEndOfMonthChecking: b.projectedEndOfMonthChecking,
    }).toMatchInlineSnapshot(`
      {
        "asOf": "2026-05-19",
        "availableToInvest": 681.12,
        "commitmentBalance": 1162.73,
        "commitmentOutflowsRemaining": 1077.27,
        "currentChecking": 2140,
        "earlyNextMonthVariable": 130,
        "incomeStillToReceive": 1610,
        "paychecksStillExpected": [
          {
            "amount": 1610,
            "date": "2026-05-22",
          },
        ],
        "projectedEndOfMonthChecking": 2421.12,
      }
    `);
  });
});
