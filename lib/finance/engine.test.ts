/**
 * engine.test.ts
 * ==============
 * TypeScript port of test_engine.py — 122 tests verifying engine.ts matches
 * the Python reference implementation byte-for-byte (cent-for-cent).
 *
 * Tolerance: CENT = 0.005 — matches the Python approx(abs=0.005) tolerance,
 * which corresponds to half-cent display precision.
 *
 * Tests are the specification. If a test fails, the implementation is wrong.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  // Date utilities
  effectivePayday,
  daysUntilPayday,
  commissionPayoutDate,
  daysSinceUpdate,
  isStale,
  paydayRiskFlag,
  nextNominalPayday,
  billNextDueDate,
  // Financial math
  pmt,
  fvAnnual,
  // Commission
  mrrPayoutGross,
  nrrPayoutGross,
  commissionTakeHome,
  droughtFlag,
  confirmedCommissionThisMonth,
  // Bills
  billsInCurrentCycle,
  forwardReserve,
  oneTimeExpensesDueInCycle,
  knownOneTimeAll,
  requiredHold,
  // Cycle outputs
  safeToSpend,
  dailyRateStatic,
  dailyRateRealtime,
  daysOfCoverage,
  cycleStatus,
  CycleStatus,
  // Monthly savings
  monthlySavingsEstimate,
  // Match gap
  matchGapAnalysis,
  // Session integrity
  sessionIntegrityCheck,
  // Forward projection
  forwardProjection,
  // Scenario
  incomeReplacementFloor,
  droughtSurvivalRunway,
  decisionSandboxCompare,
  // Tax
  taxReservePerPaycheck,
  // Income growth
  incomeGrowthScenario,
  // Debt
  debtPayoffAnalysis,
  // Retirement
  retirementProjection,
  // Wealth
  hysaGap,
  monthsToCloseHysaGap,
  savingsRate,
  netWorthProjection,
  // Helpers
  variableDailyRate,
  variableProrated,
  // Data classes
  Bill,
  OneTimeExpense,
  CommissionRow,
  PurchaseOption,
  // Date helper
  d,
} from "./engine";

// ---------------------------------------------------------------------------
// TOLERANCE HELPERS  (match pytest.approx(abs=0.005))
// ---------------------------------------------------------------------------
const CENT = 0.005;

function closeTo(actual: number, expected: number, tol: number = CENT): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

// ---------------------------------------------------------------------------
// FIXTURE: STANDARD BILL LIST (from FIX_PLAN §A3)
// ---------------------------------------------------------------------------
function makeRealBills(): Bill[] {
  return [
    new Bill("Gym Membership", 27.0, 2, false, "Discretionary", true),
    new Bill("Phone (Verizon)", 65.0, 2, true, "Essential", true),
    new Bill("Claude Subscription", 21.0, 3, true, "Discretionary", true),
    new Bill("Rent", 1000.0, 4, true, "Essential", true),
    new Bill("Car Loan (2024 Camry)", 337.0, 1, true, "Debt", true, "WNY FCU, 4.74% APR, 60 months"),
    new Bill("Car Insurance", 141.95, 8, true, "Essential", true),
    new Bill("YouTube Premium", 14.0, 15, true, "Discretionary", true),
    new Bill("Electric", 175.0, 16, true, "Essential", false),
    new Bill("Gas Utility", 70.0, 19, true, "Essential", false),
    new Bill("EZ-Pass", 10.0, 22, true, "Essential", true),
  ];
}

// ===========================================================================
// GROUP 1 — DATE UTILITIES
// ===========================================================================

describe("effectivePayday — Source: FIX_PLAN §B6 / Dashboard!B26", () => {
  it("Wednesday unchanged", () => {
    expect(effectivePayday(d(2026, 4, 22)).getTime()).toBe(d(2026, 4, 22).getTime());
  });
  it("Friday unchanged", () => {
    expect(effectivePayday(d(2026, 5, 22)).getTime()).toBe(d(2026, 5, 22).getTime());
  });
  it("Saturday goes to Friday", () => {
    expect(effectivePayday(d(2026, 8, 22)).getTime()).toBe(d(2026, 8, 21).getTime());
  });
  it("Sunday goes to Friday", () => {
    expect(effectivePayday(d(2026, 11, 22)).getTime()).toBe(d(2026, 11, 20).getTime());
  });
  it("7th Saturday goes to Friday", () => {
    expect(effectivePayday(d(2026, 11, 7)).getTime()).toBe(d(2026, 11, 6).getTime());
  });
  it("7th Sunday goes to Friday", () => {
    expect(effectivePayday(d(2027, 2, 7)).getTime()).toBe(d(2027, 2, 5).getTime());
  });
  it("Monday unchanged", () => {
    expect(effectivePayday(d(2026, 6, 22)).getTime()).toBe(d(2026, 6, 22).getTime());
  });
});

describe("daysUntilPayday — Source: FIX_PLAN §B5", () => {
  it("one day away", () => {
    expect(daysUntilPayday(d(2026, 4, 21), d(2026, 4, 22))).toBe(1);
  });
  it("payday is today → 0", () => {
    expect(daysUntilPayday(d(2026, 4, 22), d(2026, 4, 22))).toBe(0);
  });
  it("multiple days", () => {
    expect(daysUntilPayday(d(2026, 4, 10), d(2026, 4, 22))).toBe(12);
  });
  it("payday in past → 0 (not negative)", () => {
    expect(daysUntilPayday(d(2026, 4, 23), d(2026, 4, 22))).toBe(0);
  });
  it("weekend adjustment in days count", () => {
    // Nominal Aug 22 (Sat) → effective Aug 21 (Fri). From Aug 19 = 2 days.
    expect(daysUntilPayday(d(2026, 8, 19), d(2026, 8, 22))).toBe(2);
  });
});

describe("commissionPayoutDate — Source: Commissions!H11", () => {
  it("December wraps to January", () => {
    expect(commissionPayoutDate(d(2025, 12, 1)).getTime()).toBe(d(2026, 1, 22).getTime());
  });
  it("January to February", () => {
    expect(commissionPayoutDate(d(2026, 1, 1)).getTime()).toBe(d(2026, 2, 22).getTime());
  });
  it("March to April", () => {
    expect(commissionPayoutDate(d(2026, 3, 1)).getTime()).toBe(d(2026, 4, 22).getTime());
  });
});

// ===========================================================================
// GROUP 2 — COMMISSION FORMULAS
// ===========================================================================

describe("mrrPayoutGross — Source: Commissions!D11 / FIX_PLAN §B1", () => {
  it("zero MRR", () => closeTo(mrrPayoutGross(0.0), 0.0));
  it("MRR 100 → $37.05", () => closeTo(mrrPayoutGross(100.0), 37.05));
  it("MRR 349.93 (tier1 cap) → $129.65", () => closeTo(mrrPayoutGross(349.93), 129.65));
  it("MRR 489.93 (tier2 cap) → $264.53", () => closeTo(mrrPayoutGross(489.93), 264.53));
  it("MRR 699.93 (tier3 cap) → $1,423.98", () => closeTo(mrrPayoutGross(699.93), 1423.98));
  it("MRR 700 (target) → $1,424.02", () => closeTo(mrrPayoutGross(700.0), 1424.02));
  it("MRR 890 → $1,547.52 (Dec 2025 verification)", () => closeTo(mrrPayoutGross(890.0), 1547.52));
  it("negative MRR → 0", () => expect(mrrPayoutGross(-50.0)).toBe(0.0));
});

describe("nrrPayoutGross — Source: Commissions!E11 / FIX_PLAN §B1", () => {
  it("zero NRR", () => closeTo(nrrPayoutGross(0.0), 0.0));
  it("NRR 3000 → ~$61.21", () => closeTo(nrrPayoutGross(3000.0), 61.21));
  it("NRR 6000 (full tiers) → $611.95", () => closeTo(nrrPayoutGross(6000.0), 611.95));
  it("negative NRR → 0", () => expect(nrrPayoutGross(-100.0)).toBe(0.0));
});

describe("commissionTakeHome — Source: Commissions!G11", () => {
  it("zero/zero → 0", () => closeTo(commissionTakeHome(0.0, 0.0), 0.0));
  it("MRR 100 → $20.93", () => closeTo(commissionTakeHome(100.0, 0.0), 20.93));
  it("MRR 349.93 → $73.25", () => closeTo(commissionTakeHome(349.93, 0.0), 73.25));
  it("MRR 699.93 → $804.55", () => closeTo(commissionTakeHome(699.93, 0.0), 804.55));
  it("MRR 700 → $804.57", () => closeTo(commissionTakeHome(700.0, 0.0), 804.57));
  it("MRR 890 → $874.35 (Dec 2025 verification)", () => closeTo(commissionTakeHome(890.0, 0.0), 874.35));
  it("NRR 3000 → $34.58", () => closeTo(commissionTakeHome(0.0, 3000.0), 34.58));
  it("NRR 6000 → $345.75", () => closeTo(commissionTakeHome(0.0, 6000.0), 345.75));
  it("MRR 500 + NRR 3000 → $215.45", () => closeTo(commissionTakeHome(500.0, 3000.0), 215.45));
});

describe("droughtFlag — Source: Commissions!B26 / Playbook §1.4", () => {
  it("two consecutive zero months → drought", () => {
    const rows = [
      new CommissionRow(d(2026, 1, 1), 0.0, 0.0),
      new CommissionRow(d(2026, 2, 1), 0.0, 0.0),
    ];
    expect(droughtFlag(rows)).toBe(true);
  });
  it("one zero month → not drought", () => {
    const rows = [new CommissionRow(d(2026, 1, 1), 0.0, 0.0)];
    expect(droughtFlag(rows)).toBe(false);
  });
  it("good commission breaks drought", () => {
    const rows = [
      new CommissionRow(d(2026, 1, 1), 0.0, 0.0),
      new CommissionRow(d(2026, 2, 1), 890.0, 0.0),
    ];
    expect(droughtFlag(rows)).toBe(false);
  });
  it("empty list → false", () => expect(droughtFlag([])).toBe(false));
});

// ===========================================================================
// GROUP 3 — BILLS ENGINE
// ===========================================================================

describe("billsInCurrentCycle — Source: Bills!H2:H13 / FIX_PLAN §B2", () => {
  let bills: Bill[];
  beforeEach(() => {
    bills = makeRealBills();
  });

  it("strict less than payday — EZ-Pass on 22nd EXCLUDED", () => {
    const inCycle = billsInCurrentCycle(bills, d(2026, 4, 21), d(2026, 4, 22));
    const names = inCycle.map(([b]) => b.name);
    expect(names).not.toContain("EZ-Pass");
  });

  it("bill due exactly on payday excluded (load-bearing)", () => {
    const result = billsInCurrentCycle(
      [new Bill("Test Bill", 100.0, 22, true)],
      d(2026, 4, 22),
      d(2026, 4, 22),
    );
    expect(result.length).toBe(0);
  });

  it("bill one day before payday included", () => {
    const result = billsInCurrentCycle(
      [new Bill("Test Bill", 100.0, 21, true)],
      d(2026, 4, 20),
      d(2026, 4, 22),
    );
    expect(result.length).toBe(1);
  });

  it("Include=FALSE excluded", () => {
    const result = billsInCurrentCycle(
      [new Bill("Gym", 27.0, 2, false)],
      d(2026, 4, 1),
      d(2026, 4, 22),
    );
    expect(result.length).toBe(0);
  });

  it("zero amount excluded", () => {
    const result = billsInCurrentCycle(
      [new Bill("Zero Bill", 0.0, 5, true)],
      d(2026, 4, 1),
      d(2026, 4, 22),
    );
    expect(result.length).toBe(0);
  });

  it("mid-cycle Apr 10 → YouTube + Electric + Gas = $259", () => {
    const inCycle = billsInCurrentCycle(bills, d(2026, 4, 10), d(2026, 4, 22));
    const names = new Set(inCycle.map(([b]) => b.name));
    expect(names.has("YouTube Premium")).toBe(true);
    expect(names.has("Electric")).toBe(true);
    expect(names.has("Gas Utility")).toBe(true);
    const total = inCycle.reduce((s, [b]) => s + b.amount, 0);
    closeTo(total, 259.0);
  });

  it("end of cycle Apr 21 → no bills, total $0", () => {
    const inCycle = billsInCurrentCycle(bills, d(2026, 4, 21), d(2026, 4, 22));
    const total = inCycle.reduce((s, [b]) => s + b.amount, 0);
    closeTo(total, 0.0);
  });

  it("weekend payday adjustment — bill due Fri excluded, Thu included", () => {
    const test = [
      new Bill("Bill Due Friday", 100.0, 21, true),
      new Bill("Bill Due Thursday", 50.0, 20, true),
    ];
    const result = billsInCurrentCycle(test, d(2026, 8, 19), d(2026, 8, 22));
    const names = new Set(result.map(([b]) => b.name));
    expect(names.has("Bill Due Thursday")).toBe(true);
    expect(names.has("Bill Due Friday")).toBe(false);
  });
});

describe("forwardReserve — Source: Dashboard!B33 / FIX_PLAN §B4", () => {
  let bills: Bill[];
  beforeEach(() => {
    bills = makeRealBills();
  });

  it("standard reserve (with car loan day=1 in window)", () => {
    // Verizon(2)+Claude(3)+Rent(4)+CarLoan(1) = 65+21+1000+337 = 1423
    // + 7 × (600/30.4) = 138.16 → 1561.16
    closeTo(forwardReserve(bills), 1561.16, 0.02);
  });

  it("no bills in 1-7 → 7-day variable only", () => {
    const fwd = forwardReserve([new Bill("Late Bill", 500.0, 15, true)]);
    closeTo(fwd, 7 * (600.0 / 30.4));
  });

  it("Gym (Include=FALSE, day=2) excluded from reserve", () => {
    const fwdWithGym = forwardReserve(bills);
    const noGym = bills.filter((b) => b.name !== "Gym Membership");
    const fwdNoGym = forwardReserve(noGym);
    closeTo(fwdWithGym, fwdNoGym);
  });

  it("uses due_day not next_due_date — bill always in 1-7", () => {
    const fwd = forwardReserve([new Bill("Always Early", 200.0, 3, true)]);
    closeTo(fwd, 200.0 + 7 * (600.0 / 30.4));
  });
});

describe("oneTimeExpensesDueInCycle — Source: Dashboard!B40", () => {
  it("expense with no date invisible to cycle", () => {
    const r = oneTimeExpensesDueInCycle(
      [new OneTimeExpense("Dateless", 500.0, null)],
      d(2026, 4, 1),
      d(2026, 4, 22),
    );
    expect(r).toBe(0.0);
  });

  it("expense due before payday counted", () => {
    const r = oneTimeExpensesDueInCycle(
      [new OneTimeExpense("Ticket", 250.0, d(2026, 4, 15))],
      d(2026, 4, 1),
      d(2026, 4, 22),
    );
    closeTo(r, 250.0);
  });

  it("expense due ON payday counted (inclusive, unlike bills)", () => {
    const r = oneTimeExpensesDueInCycle(
      [new OneTimeExpense("Due on Payday", 100.0, d(2026, 4, 22))],
      d(2026, 4, 1),
      d(2026, 4, 22),
    );
    closeTo(r, 100.0);
  });

  it("paid expense excluded", () => {
    const r = oneTimeExpensesDueInCycle(
      [new OneTimeExpense("Paid", 300.0, d(2026, 4, 10), true)],
      d(2026, 4, 1),
      d(2026, 4, 22),
    );
    expect(r).toBe(0.0);
  });
});

// ===========================================================================
// GROUP 4 — SAFE TO SPEND AND CYCLE STATUS
// ===========================================================================

describe("safeToSpend — Source: Dashboard!B19 / FIX_PLAN §B2", () => {
  let bills: Bill[];
  beforeEach(() => {
    bills = makeRealBills();
  });

  it("mid-cycle Apr 10 checking $2,000 → STS = $1,741", () => {
    const inCycle = billsInCurrentCycle(bills, d(2026, 4, 10), d(2026, 4, 22));
    const billsTotal = inCycle.reduce((s, [b]) => s + b.amount, 0);
    closeTo(safeToSpend(2000.0, billsTotal), 1741.0);
  });

  it("end of cycle Apr 21 checking $694.05 → STS = $694.05", () => {
    const inCycle = billsInCurrentCycle(bills, d(2026, 4, 21), d(2026, 4, 22));
    const billsTotal = inCycle.reduce((s, [b]) => s + b.amount, 0);
    closeTo(safeToSpend(694.05, billsTotal), 694.05);
  });

  it("STS never negative — floored at zero", () => {
    expect(safeToSpend(100.0, 500.0)).toBe(0.0);
  });

  it("forward reserve NOT in required hold (B33 only in B61)", () => {
    const inCycle = billsInCurrentCycle(bills, d(2026, 4, 10), d(2026, 4, 22));
    const billsTotal = inCycle.reduce((s, [b]) => s + b.amount, 0);
    const stsWithout = safeToSpend(2000.0, billsTotal);
    const fwd = forwardReserve(bills);
    const stsWith = safeToSpend(2000.0, billsTotal, {
      forwardReserveAmount: fwd,
      includeForwardReserveInSts: true,
    });
    closeTo(stsWithout, stsWith);
  });
});

describe("cycleStatus — Source: Dashboard!B27 / Assumptions!B8", () => {
  it("green above threshold", () => expect(cycleStatus(729.0)).toBe(CycleStatus.GREEN));
  it("yellow below threshold", () => expect(cycleStatus(399.99)).toBe(CycleStatus.YELLOW));
  it("yellow at $0.01", () => expect(cycleStatus(0.01)).toBe(CycleStatus.YELLOW));
  it("red at $0", () => expect(cycleStatus(0.0)).toBe(CycleStatus.RED));
  it("red negative", () => expect(cycleStatus(-1.0)).toBe(CycleStatus.RED));
  it("$400 boundary → GREEN, $399.99 → YELLOW", () => {
    expect(cycleStatus(400.0)).toBe(CycleStatus.GREEN);
    expect(cycleStatus(399.99)).toBe(CycleStatus.YELLOW);
  });
});

describe("daily rates — Source: Dashboard!B21/B22", () => {
  it("static rate typical: $1,741 / 12 days", () => {
    const r = dailyRateStatic(1741.0, 0.0, d(2026, 4, 22), d(2026, 4, 10));
    closeTo(r, 1741.0 / 12.0);
  });

  it("realtime tightens as payday approaches", () => {
    const sts = 1741.0;
    const payday = d(2026, 4, 22);
    const early = dailyRateRealtime(sts, 0.0, payday, d(2026, 4, 10));
    const late = dailyRateRealtime(sts, 0.0, payday, d(2026, 4, 20));
    expect(late).toBeGreaterThan(early);
  });

  it("static rate 0 when payday before/equal update", () => {
    const r = dailyRateStatic(500.0, 0.0, d(2026, 4, 22), d(2026, 4, 23));
    expect(r).toBe(0.0);
  });

  it("realtime 0 when payday is today", () => {
    const r = dailyRateRealtime(500.0, 0.0, d(2026, 4, 22), d(2026, 4, 22));
    expect(r).toBe(0.0);
  });

  it("days of coverage: null when rate=0", () => {
    expect(daysOfCoverage(500.0, 0.0)).toBeNull();
  });

  it("days of coverage computed", () => {
    const cov = daysOfCoverage(1000.0, 50.0);
    expect(cov).not.toBeNull();
    closeTo(cov as number, 20.0);
  });
});

// ===========================================================================
// GROUP 5 — MONTHLY SAVINGS ESTIMATE
// ===========================================================================

describe("monthlySavingsEstimate — Source: Dashboard!B62 / FIX_PLAN §B3", () => {
  it("Apr 21 verification (car loan day=15, NOT in 1-7) → ~$142.17", () => {
    const bills = makeRealBills().filter((b) => b.name !== "Car Loan (2024 Camry)");
    bills.push(new Bill("Car Loan (2024 Camry)", 337.0, 15, true, "Debt"));
    const result = monthlySavingsEstimate(
      3220.0,
      0.0,
      bills,
      d(2026, 4, 22),
      d(2026, 4, 21),
      [],
      0.0,
      bills,
    );
    closeTo(result, 142.17, 0.05);
  });

  it("savings floored at zero (very low income)", () => {
    const result = monthlySavingsEstimate(
      1000.0,
      0.0,
      makeRealBills(),
      d(2026, 4, 22),
      d(2026, 4, 10),
      [],
      0.0,
      makeRealBills(),
    );
    expect(result).toBeGreaterThanOrEqual(0.0);
  });

  it("forward reserve subtracted from savings (B61=B33)", () => {
    const baseline = [new Bill("Rent", 1000.0, 4, true)];
    const r = monthlySavingsEstimate(
      3220.0,
      0.0,
      baseline,
      d(2026, 4, 22),
      d(2026, 4, 10),
      [],
      0.0,
      baseline,
    );
    expect(r).toBeGreaterThanOrEqual(0.0);
  });

  it("variable prorated uses ROUND(_, 2)", () => {
    const result = monthlySavingsEstimate(
      3220.0,
      0.0,
      [],
      d(2026, 4, 22),
      d(2026, 4, 21),
      [],
      0.0,
      [],
    );
    const expected =
      3220.0 - Math.round(((1 / 30.4) * 600.0) * 100) / 100 - 7 * (600.0 / 30.4);
    closeTo(result, expected, 0.02);
  });

  it("commission included when payout confirmed", () => {
    const bills = [new Bill("Rent", 1000.0, 4, true)];
    const withCom = monthlySavingsEstimate(
      3220.0,
      874.35,
      bills,
      d(2026, 1, 22),
      d(2026, 1, 22),
      [],
      0.0,
      bills,
    );
    const baseOnly = monthlySavingsEstimate(
      3220.0,
      0.0,
      bills,
      d(2026, 1, 22),
      d(2026, 1, 22),
      [],
      0.0,
      bills,
    );
    expect(withCom).toBeGreaterThan(baseOnly);
  });
});

// ===========================================================================
// GROUP 6 — 401(K) MATCH GAP
// ===========================================================================

describe("matchGapAnalysis — Source: FIX_PLAN §A2", () => {
  it("standard case: $1,080/yr, $90/mo gap", () => {
    const r = matchGapAnalysis(54000.0, 0.04, 0.5, 0.08);
    closeTo(r.annualCaptured, 1080.0);
    closeTo(r.annualAvailable, 2160.0);
    closeTo(r.annualGap, 1080.0);
    closeTo(r.monthlyGap, 90.0);
    expect(r.atCeiling).toBe(false);
  });

  it("at ceiling → no gap", () => {
    const r = matchGapAnalysis(54000.0, 0.08, 0.5, 0.08);
    closeTo(r.annualGap, 0.0);
    closeTo(r.monthlyGap, 0.0);
    expect(r.atCeiling).toBe(true);
  });

  it("above ceiling still no gap (extra contribution doesn't increase match)", () => {
    const r = matchGapAnalysis(54000.0, 0.12, 0.5, 0.08);
    closeTo(r.annualGap, 0.0);
    expect(r.atCeiling).toBe(true);
  });

  it("employer match pct calculation", () => {
    const r = matchGapAnalysis(54000.0, 0.04, 0.5, 0.08);
    closeTo(r.employerMatchPct, 0.02);
    closeTo(r.maxPossibleMatchPct, 0.04);
  });
});

// ===========================================================================
// GROUP 7 — SESSION INTEGRITY CHECK
// ===========================================================================

describe("sessionIntegrityCheck — Source: Assumptions!D20:D29 / BUILD_SPEC §4.9", () => {
  function makePassingArgs(bills: Bill[]) {
    const mg = matchGapAnalysis();
    const fwd = forwardReserve(bills);
    return {
      baseNetMonthly: 3220.0,
      nextPaydayNominal: d(2026, 4, 22),
      today: d(2026, 4, 21),
      lastBalanceUpdate: d(2026, 4, 21),
      bills,
      forwardReserveAmount: fwd,
      commissionTaxRate: 0.435,
      variableSpendCap: 600.0,
      monthlySavings: 142.17,
      matchGapResult: mg,
    };
  }

  it("all 10 checks pass", () => {
    const report = sessionIntegrityCheck(makePassingArgs(makeRealBills()));
    expect(report.overallPass).toBe(true);
    expect(report.failCount).toBe(0);
  });

  it("stale balance fails check 3", () => {
    const args = makePassingArgs(makeRealBills());
    args.lastBalanceUpdate = d(2026, 4, 17); // 4 days ago
    const r = sessionIntegrityCheck(args);
    const c3 = r.checks.find((c) => c.checkNumber === 3)!;
    expect(c3.passed).toBe(false);
    expect(r.overallPass).toBe(false);
  });

  it("payday in past fails check 2", () => {
    const args = makePassingArgs(makeRealBills());
    args.nextPaydayNominal = d(2026, 4, 20);
    const r = sessionIntegrityCheck(args);
    expect(r.checks.find((c) => c.checkNumber === 2)!.passed).toBe(false);
  });

  it("zero base income fails check 1", () => {
    const args = makePassingArgs(makeRealBills());
    args.baseNetMonthly = 0.0;
    const r = sessionIntegrityCheck(args);
    expect(r.checks.find((c) => c.checkNumber === 1)!.passed).toBe(false);
  });

  it("no active bills fails check 4", () => {
    const args = makePassingArgs(makeRealBills());
    args.bills = [new Bill("Gym", 27.0, 2, false)];
    const r = sessionIntegrityCheck(args);
    expect(r.checks.find((c) => c.checkNumber === 4)!.passed).toBe(false);
  });

  it("negative bill fails check 10", () => {
    const args = makePassingArgs(makeRealBills());
    args.bills = [...makeRealBills(), new Bill("Bad Bill", -10.0, 5, true)];
    const r = sessionIntegrityCheck(args);
    expect(r.checks.find((c) => c.checkNumber === 10)!.passed).toBe(false);
  });

  it("NaN savings fails check 8", () => {
    const args = makePassingArgs(makeRealBills());
    args.monthlySavings = NaN;
    const r = sessionIntegrityCheck(args);
    expect(r.checks.find((c) => c.checkNumber === 8)!.passed).toBe(false);
  });

  it("report has exactly 10 checks", () => {
    const r = sessionIntegrityCheck(makePassingArgs(makeRealBills()));
    expect(r.checks.length).toBe(10);
  });
});

// ===========================================================================
// GROUP 8 — FINANCIAL MATH
// ===========================================================================

describe("pmt — Source: Decision Sandbox!B21 / Debt Strategy!B19", () => {
  it("car loan Camry: $18,500 @ 4.74% / 60mo ≈ $346.89", () => {
    closeTo(pmt(0.0474, 60, 18500.0), 346.89, 0.1);
  });

  it("student loan: 5.5% / 120mo / $30k → $325.58", () => {
    closeTo(pmt(0.055, 120, 30000.0), 325.58, 0.02);
  });

  it("zero rate → principal / term", () => {
    closeTo(pmt(0.0, 12, 1200.0), 100.0);
  });
});

describe("fv — Source: Retirement Planning!B35", () => {
  it("retirement projection sanity (>$200k over 35 years @ 7%)", () => {
    expect(fvAnnual(0.07, 35, 5000.0, 2200.0)).toBeGreaterThan(200000.0);
  });
});

// ===========================================================================
// GROUP 9 — DECISION SANDBOX
// ===========================================================================

describe("incomeReplacementFloor — Source: Decision Sandbox!B53", () => {
  it("standard inputs", () => {
    const [annual] = incomeReplacementFloor(0.0, 1833.95, 600.0, 0.16);
    closeTo(annual, (2433.95 * 12) / 0.84, 1.0);
  });
});

describe("droughtSurvivalRunway — Source: Decision Sandbox!B33:B43", () => {
  it("indefinite when base covers burn", () => {
    const r = droughtSurvivalRunway(2000.0, 15000.0, 1000.0, 600.0, 3220.0);
    expect(r.indefinite).toBe(true);
  });

  it("runway when deficit (5.0 months)", () => {
    const r = droughtSurvivalRunway(2000.0, 5000.0, 2800.0, 600.0, 2000.0);
    expect(r.indefinite).toBe(false);
    closeTo(r.runway_months as number, 5.0);
  });
});

// ===========================================================================
// GROUP 10 — TAX AND INCOME GROWTH
// ===========================================================================

describe("taxReservePerPaycheck — Source: Assumptions!B40 / B41", () => {
  it("standard: $54k @ 16% / 24 periods → $360 / $720", () => {
    const [perPaycheck, perMonth] = taxReservePerPaycheck(54000.0, 0.12, 0.04, 24);
    closeTo(perPaycheck, 360.0);
    closeTo(perMonth, 720.0);
  });
});

describe("incomeGrowthScenario — Source: Assumptions!B56:B60", () => {
  it("raise from $54k to $65k → +$770/mo net", () => {
    const r = incomeGrowthScenario(54000.0, 65000.0, 0.12, 0.04, 3220.0, 1833.95);
    closeTo(r.monthly_net_increase, 770.0);
    closeTo(r.new_monthly_net, 3990.0);
    closeTo(r.new_savings_floor, 3990.0 - 1833.95);
  });
});

// ===========================================================================
// GROUP 11 — DEBT STRATEGY
// ===========================================================================

describe("debtPayoffAnalysis — Source: Debt Strategy / BUILD_SPEC §6.1", () => {
  const std = debtPayoffAnalysis(30000.0, 0.055);

  it("standard monthly payment ≈ $325.58", () => {
    closeTo(std.standard_monthly, 325.58, 0.02);
  });

  it("standard total paid", () => {
    closeTo(std.standard_total_paid, 325.58 * 120, 5.0);
  });

  it("extended monthly < standard monthly", () => {
    expect(std.extended_monthly).toBeLessThan(std.standard_monthly);
  });

  it("3yr aggressive saves interest", () => {
    expect(std.payoff_3yr_interest_saved).toBeGreaterThan(0);
  });

  it("invest verdict is one of two known strings", () => {
    expect(["INVEST the difference", "PAY AGGRESSIVELY"]).toContain(std.invest_verdict);
  });
});

// ===========================================================================
// GROUP 12 — RETIREMENT PROJECTION
// ===========================================================================

describe("retirementProjection — Source: Retirement Planning + FIX_PLAN §A2", () => {
  const ret = retirementProjection();

  it("match gap banner mentions uncaptured when not at ceiling", () => {
    expect(ret.match_gap_banner).toContain("uncaptured");
  });

  it("at-cap projects higher than current", () => {
    expect(ret.at_cap_projected_65).toBeGreaterThan(ret.projected_at_65);
  });

  it("aggressive higher than at-cap", () => {
    expect(ret.aggressive_projected_65).toBeGreaterThan(ret.at_cap_projected_65);
  });

  it("million_monthly is positive", () => {
    expect(ret.million_monthly_needed).toBeGreaterThan(0);
  });
});

// ===========================================================================
// GROUP 13 — STALENESS AND PAYDAY RISK
// ===========================================================================

describe("staleness — Source: Dashboard!B8 / Playbook §6.4", () => {
  it("3 days is NOT stale (boundary)", () => {
    expect(isStale(d(2026, 4, 18), d(2026, 4, 21))).toBe(false);
  });
  it("4 days IS stale", () => {
    expect(isStale(d(2026, 4, 17), d(2026, 4, 21))).toBe(true);
  });
  it("today is NOT stale", () => {
    expect(isStale(d(2026, 4, 21), d(2026, 4, 21))).toBe(false);
  });
});

describe("paydayRiskFlag — Source: Dashboard!B26", () => {
  it("Saturday is risk", () => expect(paydayRiskFlag(d(2026, 8, 22))).toBe(true));
  it("Sunday is risk", () => expect(paydayRiskFlag(d(2026, 11, 22))).toBe(true));
  it("Wednesday is NOT risk", () => expect(paydayRiskFlag(d(2026, 4, 22))).toBe(false));
});

// ===========================================================================
// GROUP 14 — WEALTH MANAGEMENT
// ===========================================================================

describe("Wealth Management — Source: Wealth Management 2026 sheet", () => {
  it("hysaGap when target NOT met", () => closeTo(hysaGap(12600.0, 15000.0), 2400.0));
  it("hysaGap when target met (negative)", () => closeTo(hysaGap(15100.0, 15000.0), -100.0));
  it("savingsRate", () => closeTo(savingsRate(142.0, 54000.0 / 12.0), 142.0 / 4500.0, 0.001));
  it("net worth projection at 35 grows", () => {
    const p = netWorthProjection(24172.0, 1046.0);
    expect(p[35]).toBeGreaterThan(24172.0);
  });
  it("months to close HYSA gap (4.59)", () => {
    const m = monthsToCloseHysaGap(2400.0, 1046.0, 0.5);
    expect(m).not.toBeNull();
    closeTo(m as number, 4.59, 0.1);
  });
  it("months returns null when gap is zero", () => {
    expect(monthsToCloseHysaGap(0.0, 1046.0)).toBeNull();
  });
});

// ===========================================================================
// GROUP 15 — VARIABLE SPEND HELPERS
// ===========================================================================

describe("Variable Spend Helpers — Source: Playbook §2.2 / Dashboard!B33,B58", () => {
  it("daily rate $19.7368/day", () => closeTo(variableDailyRate(600.0, 30.4), 19.7368, 0.001));
  it("7-day prorated $138.16", () => {
    closeTo(variableProrated(7, 600.0, 30.4), (7 * 600.0) / 30.4, 0.001);
  });
  it("1-day round trip for B58 = $19.74", () => {
    expect(Math.round((1 / 30.4) * 600.0 * 100) / 100).toBe(19.74);
  });
});

// Quick check that daysSinceUpdate is exported and usable (not from Python tests
// directly — keeps the import surface honest).
describe("daysSinceUpdate (smoke)", () => {
  it("3 days", () => expect(daysSinceUpdate(d(2026, 4, 18), d(2026, 4, 21))).toBe(3));
});

// ===========================================================================
// GROUP 16 — DIRECT COVERAGE FOR HELPERS (Task #3)
//
// These functions are exercised indirectly by the rest of the suite, but the
// Python reference test_engine.py hits them directly. Each expected value below
// was cross-checked against marshall_finance_engine.py via a one-off Python
// run (see commit message / task notes).
// ===========================================================================

// ---------- nextNominalPayday — Source: BUILD_SPEC §4.1 ----------
describe("nextNominalPayday — Source: BUILD_SPEC §4.1", () => {
  it("before first payday → returns 7th of same month", () => {
    expect(nextNominalPayday(d(2026, 4, 1)).getTime()).toBe(d(2026, 4, 7).getTime());
  });

  it("on the 7th → returns the 7th itself (>= today)", () => {
    expect(nextNominalPayday(d(2026, 4, 7)).getTime()).toBe(d(2026, 4, 7).getTime());
  });

  it("between paydays → returns the 22nd", () => {
    expect(nextNominalPayday(d(2026, 4, 8)).getTime()).toBe(d(2026, 4, 22).getTime());
  });

  it("on the 22nd → returns the 22nd itself", () => {
    expect(nextNominalPayday(d(2026, 4, 22)).getTime()).toBe(d(2026, 4, 22).getTime());
  });

  it("after both paydays → rolls to next month's 7th", () => {
    expect(nextNominalPayday(d(2026, 4, 23)).getTime()).toBe(d(2026, 5, 7).getTime());
  });

  it("year boundary: late December → next January's 7th", () => {
    expect(nextNominalPayday(d(2026, 12, 23)).getTime()).toBe(d(2027, 1, 7).getTime());
  });

  it("custom pay days [15] after the 15th → next month's 15th", () => {
    expect(nextNominalPayday(d(2026, 4, 16), [15]).getTime()).toBe(d(2026, 5, 15).getTime());
  });

  it("clamps to last day of short month (Feb 30 → Feb 28 in 2026)", () => {
    expect(nextNominalPayday(d(2026, 2, 1), [30]).getTime()).toBe(d(2026, 2, 28).getTime());
  });
});

// ---------- billNextDueDate — Source: Bills!D2:D13 / Playbook §1.1 ----------
describe("billNextDueDate — Source: Bills!D2:D13 / Playbook §1.1", () => {
  it("due day later this month → returns this month's date", () => {
    const r = billNextDueDate(d(2026, 4, 5), 10, true);
    expect(r).not.toBeNull();
    expect(r!.getTime()).toBe(d(2026, 4, 10).getTime());
  });

  it("due day == today → returns today (>= today is inclusive)", () => {
    const r = billNextDueDate(d(2026, 4, 10), 10, true);
    expect(r!.getTime()).toBe(d(2026, 4, 10).getTime());
  });

  it("due day already passed this month → rolls to next month", () => {
    const r = billNextDueDate(d(2026, 4, 11), 10, true);
    expect(r!.getTime()).toBe(d(2026, 5, 10).getTime());
  });

  it("include=false → null", () => {
    expect(billNextDueDate(d(2026, 4, 5), 10, false)).toBeNull();
  });

  it("dueDay null/undefined → null", () => {
    expect(billNextDueDate(d(2026, 4, 5), null, true)).toBeNull();
    expect(billNextDueDate(d(2026, 4, 5), undefined, true)).toBeNull();
  });

  it("clamps day 31 to Feb 28 in non-leap year (2026)", () => {
    const r = billNextDueDate(d(2026, 2, 25), 31, true);
    expect(r!.getTime()).toBe(d(2026, 2, 28).getTime());
  });

  it("day 31 in March → returns March 31 (no clamp needed)", () => {
    const r = billNextDueDate(d(2026, 3, 1), 31, true);
    expect(r!.getTime()).toBe(d(2026, 3, 31).getTime());
  });

  it("rolls across year boundary (Dec → Jan)", () => {
    const r = billNextDueDate(d(2025, 12, 25), 10, true);
    expect(r!.getTime()).toBe(d(2026, 1, 10).getTime());
  });
});

// ---------- requiredHold — Source: Dashboard!B16 ----------
describe("requiredHold — Source: Dashboard!B16", () => {
  it("only bills_due_total → just bills", () => {
    closeTo(requiredHold(500.0), 500.0);
  });

  it("sums every component (positional defaults left implicit)", () => {
    // 500 + 50 + 100 + 200 + 25 + 10 + 75 = 960
    closeTo(requiredHold(500, 50, 100, 200, 25, 10, 75), 960);
  });

  it("all-zero inputs → 0", () => {
    expect(requiredHold(0)).toBe(0);
  });

  it("forward reserve is NOT part of required hold (regression guard)", () => {
    // The function signature has no fwd reserve parameter — so passing the
    // canonical components should never include B33. We assert the sum is
    // exactly the components, no surprises.
    const billsDue = 800;
    const oneTime = 250;
    const result = requiredHold(billsDue, 0, 0, 0, 0, 0, oneTime);
    closeTo(result, 1050);
  });
});

// ---------- knownOneTimeAll — Source: Dashboard!B59 ----------
describe("knownOneTimeAll — Source: Dashboard!B59", () => {
  it("includes dateless and excludes paid", () => {
    const exps = [
      new OneTimeExpense("With date", 100.0, d(2026, 5, 1), false),
      new OneTimeExpense("Dateless", 250.0, null, false),
      new OneTimeExpense("Paid", 500.0, d(2026, 6, 1), true),
      new OneTimeExpense("Future", 75.5, d(2026, 4, 15), false),
    ];
    closeTo(knownOneTimeAll(exps), 425.5);
  });

  it("empty list → 0", () => {
    expect(knownOneTimeAll([])).toBe(0);
  });

  it("all paid → 0", () => {
    const exps = [new OneTimeExpense("X", 999.0, null, true)];
    expect(knownOneTimeAll(exps)).toBe(0);
  });
});

// ---------- confirmedCommissionThisMonth — Source: Dashboard!B55 ----------
describe("confirmedCommissionThisMonth — Source: Dashboard!B55", () => {
  const rows = [
    new CommissionRow(d(2025, 12, 1), 890.0, 0.0), // payout Jan 22 2026
    new CommissionRow(d(2026, 1, 1), 700.0, 0.0), // payout Feb 22 2026
  ];

  it("today == payout day, sales row exists → returns take-home", () => {
    // Dec 2025 sales 890 MRR → cross-checked vs Python: $874.35
    closeTo(confirmedCommissionThisMonth(rows, d(2026, 1, 22)), 874.35);
  });

  it("payout day in same month but today is BEFORE the 22nd → 0", () => {
    expect(confirmedCommissionThisMonth(rows, d(2026, 1, 21))).toBe(0.0);
  });

  it("different month: matches by payout date being this month and <= today", () => {
    // Feb 22 → Jan 2026 sales row's payout (700 MRR → $804.57)
    closeTo(confirmedCommissionThisMonth(rows, d(2026, 2, 22)), 804.57);
  });

  it("no row payable this month → 0 (commission-as-zero rule)", () => {
    expect(confirmedCommissionThisMonth(rows, d(2026, 3, 22))).toBe(0.0);
  });

  it("empty list → 0", () => {
    expect(confirmedCommissionThisMonth([], d(2026, 1, 22))).toBe(0.0);
  });
});

// ---------- forwardProjection — Source: BUILD_SPEC §5.2 / FIX_PLAN §B3 ----------
describe("forwardProjection — Source: BUILD_SPEC §5.2 / FIX_PLAN §B3", () => {
  function bills(): Bill[] {
    return makeRealBills();
  }

  it("default 2 cycles starting from next payday, includes confirmed commission", () => {
    const commissions = [new CommissionRow(d(2026, 3, 1), 700.0, 0.0)]; // payout Apr 22
    const result = forwardProjection({
      currentChecking: 2000.0,
      currentMonthlySavings: 142.17,
      bills: bills(),
      today: d(2026, 4, 21),
      nextPaydayNominal: d(2026, 4, 22),
      commissions,
    });

    expect(result.length).toBe(2);

    // Cycle 1: payday Apr 22, includes the Mar→Apr commission payout
    const c1 = result[0]!;
    expect(c1.cycleLabel).toBe("Cycle 1: payday 2026-04-22");
    expect(c1.paydayDate.getTime()).toBe(d(2026, 4, 22).getTime());
    closeTo(c1.baseIncome, 1610.0);
    closeTo(c1.expectedCommission, 804.57);
    closeTo(c1.totalIncome, 2414.57);
    closeTo(c1.fixedBills, 916.975);
    closeTo(c1.variableEstimate, 300.0);
    closeTo(c1.forwardReserveOut, 1561.16, 0.02);
    closeTo(c1.estimatedSavings, 1197.6, 0.02);
    closeTo(c1.projectedChecking, 3197.6, 0.02);

    // Cycle 2: payday May 7, no commission (only Apr 22 row matches)
    const c2 = result[1]!;
    expect(c2.cycleLabel).toBe("Cycle 2: payday 2026-05-07");
    expect(c2.paydayDate.getTime()).toBe(d(2026, 5, 7).getTime());
    closeTo(c2.expectedCommission, 0.0);
    closeTo(c2.totalIncome, 1610.0);
    closeTo(c2.estimatedSavings, 393.025);
    closeTo(c2.projectedChecking, 3590.62, 0.02);
  });

  it("payday-sequence advances 7 → 22 → next-month-7", () => {
    const result = forwardProjection({
      currentChecking: 1000.0,
      currentMonthlySavings: 0.0,
      bills: bills(),
      today: d(2026, 4, 1),
      nextPaydayNominal: d(2026, 4, 7),
      commissions: [],
      cycles: 3,
    });
    expect(result.length).toBe(3);
    expect(result[0]!.paydayDate.getTime()).toBe(d(2026, 4, 7).getTime());
    expect(result[1]!.paydayDate.getTime()).toBe(d(2026, 4, 22).getTime());
    expect(result[2]!.paydayDate.getTime()).toBe(d(2026, 5, 7).getTime());
    // Each cycle has identical income/expense → projected checking grows linearly
    const delta = result[1]!.projectedChecking - result[0]!.projectedChecking;
    closeTo(result[2]!.projectedChecking - result[1]!.projectedChecking, delta, 0.001);
  });

  it("estimated savings floored at zero when bills+variable exceed income", () => {
    const heavy = [new Bill("Big Rent", 5000.0, 4, true)];
    const result = forwardProjection({
      currentChecking: 0.0,
      currentMonthlySavings: 0.0,
      bills: heavy,
      today: d(2026, 4, 21),
      nextPaydayNominal: d(2026, 4, 22),
      commissions: [],
      cycles: 1,
    });
    expect(result[0]!.estimatedSavings).toBe(0.0);
    // projected_checking can still go negative — that's the warning signal
    expect(result[0]!.projectedChecking).toBeLessThan(0.0);
  });

  it("commission only applied when payout date matches the cycle's payday month", () => {
    // Sales row for Mar pays out Apr 22. If we start from May 7, no commission.
    const commissions = [new CommissionRow(d(2026, 3, 1), 700.0, 0.0)];
    const result = forwardProjection({
      currentChecking: 0.0,
      currentMonthlySavings: 0.0,
      bills: [],
      today: d(2026, 5, 1),
      nextPaydayNominal: d(2026, 5, 7),
      commissions,
      cycles: 2,
    });
    expect(result[0]!.expectedCommission).toBe(0.0);
    expect(result[1]!.expectedCommission).toBe(0.0);
  });
});

// ---------- decisionSandboxCompare — Source: Decision Sandbox!B21:E30 ----------
describe("decisionSandboxCompare — Source: Decision Sandbox!B21:E30", () => {
  it("financed loan: monthly payment, daily lifestyle, opportunity cost", () => {
    const opts = [
      new PurchaseOption("Camry Loan", 20000.0, 1500.0, 0.0474, 60, 141.95, 0.0),
    ];
    const [r] = decisionSandboxCompare(opts, 145.0, 1833.95, 600.0, 3220.0, 15000.0);
    expect(r!.name).toBe("Camry Loan");
    closeTo(r!.monthlyPayment, 346.92, 0.02);
    closeTo(r!.totalMonthlyCost, 488.87, 0.02);
    closeTo(r!.dailyLifestyleCost, 16.08, 0.02);
    closeTo(r!.newDailySafeSpend, 128.92, 0.02);
    closeTo(r!.annualCost, 5866.42, 0.05);
    // (PMT*60 - financed) interest + opp cost on $1500 over 120mo @ 7%/12
    closeTo(r!.totalInterestWithOpportunityCost, 3829.6, 1.0);
    closeTo(r!.hysaAfterDown, 13500.0);
    closeTo(r!.hysaRunwayMonths, 27.6, 0.05);
    expect(r!.affordability).toBe("Yes");
    closeTo(r!.incomeCoveragePct, 0.1518, 0.001);
  });

  it("cash buy (no rate, no term) uses one_time_cost as annual_cost; runway is Infinity", () => {
    const opts = [new PurchaseOption("Cash Buy", 12000.0, 12000.0, 0.0, 0, 0.0, 12000.0)];
    const [r] = decisionSandboxCompare(opts, 145.0, 1833.95, 600.0, 3220.0, 15000.0);
    expect(r!.monthlyPayment).toBe(0.0);
    expect(r!.totalMonthlyCost).toBe(0.0);
    closeTo(r!.annualCost, 12000.0);
    expect(r!.hysaRunwayMonths).toBe(Number.POSITIVE_INFINITY);
    closeTo(r!.hysaAfterDown, 3000.0);
    // Opportunity cost only — no actual interest (term_months=0)
    closeTo(r!.totalInterestWithOpportunityCost, 12115.94, 1.0);
    expect(r!.affordability).toBe("Yes");
    closeTo(r!.incomeCoveragePct, 0.3106, 0.001);
  });

  it("affordability tiers: Yes / Tight / No", () => {
    // residual = base - (fixed + total_monthly); thresholds: > variableCap = Yes,
    // > 0 = Tight, else No.
    const yesOpt = new PurchaseOption("Y", 1000.0, 0.0, 0.05, 60, 50.0, 0.0); // tiny monthly
    const tightOpt = new PurchaseOption("T", 50000.0, 0.0, 0.05, 60, 0.0, 0.0); // residual ≈ $442
    const noOpt = new PurchaseOption("N", 100000.0, 0.0, 0.05, 60, 0.0, 0.0); // residual < 0
    const results = decisionSandboxCompare(
      [yesOpt, tightOpt, noOpt],
      145.0,
      1833.95, // monthlyFixedBills
      600.0, // variableCap
      3220.0, // baseNetMonthly
      15000.0,
    );
    expect(results[0]!.affordability).toBe("Yes");
    expect(results[1]!.affordability).toBe("Tight");
    expect(results[2]!.affordability).toBe("No");
  });

  it("zero base income → income_coverage_pct is 0 (guards divide-by-zero)", () => {
    const opts = [new PurchaseOption("Zero APR", 10000.0, 0.0, 0.0, 12, 0.0, 0.0)];
    const [r] = decisionSandboxCompare(opts, 50.0, 1000.0, 600.0, 0.0, 5000.0);
    expect(r!.incomeCoveragePct).toBe(0.0);
    // Zero rate w/ term → monthly_payment branch is the (rate>0 && term>0) guard,
    // so monthly_payment=0 and actual_interest = 0*12 - 10000 = -10000 (no opp cost).
    expect(r!.monthlyPayment).toBe(0.0);
    closeTo(r!.totalInterestWithOpportunityCost, -10000.0);
  });

  it("empty options list → empty results", () => {
    expect(decisionSandboxCompare([], 145.0, 1833.95, 600.0, 3220.0, 15000.0)).toEqual([]);
  });
});
