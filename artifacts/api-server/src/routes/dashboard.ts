import { Router, type IRouter } from "express";
import { GetDashboardCycleResponse } from "@workspace/api-zod";
import { computeCycleState, deriveNextPayday } from "../lib/financeEngine";
import {
  payDatesInWindow,
  nextPayDate,
  resolvePayCadenceConfig,
} from "../lib/payCadence";
import { billsThisMonth } from "../lib/cycleBillEngine";
import { syncBillPaymentStates } from "../lib/paymentState";
import {
  db,
  oneTimeExpenses,
  variableSpend,
  bills,
  assumptions,
  commissions,
  balances,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  BASE_NET_INCOME,
  MONTH_LENGTH_DAYS,
  VARIABLE_SPEND_CAP,
  Bill as EngineBill,
  commissionTakeHome,
} from "@workspace/finance";

// NOTE: Playbook §1.1 (Forward Reserve subtracted from Safe to Spend) is now
// applied inside @workspace/finance.safeToSpend itself (task #9). No route-layer
// adjustment needed — cycle.safeToSpend and cycle.status are already correct.

const router: IRouter = Router();

router.get("/dashboard/cycle", async (req, res): Promise<void> => {
  // v8.2 — accept `?asOf=YYYY-MM-DD` to simulate a different calendar day.
  // Lets the audit (and any future test suite) verify month-timing stability
  // without mocking the system clock. Real today when omitted.
  //
  // SAFETY: when `asOf` is supplied we MUST NOT run `syncBillPaymentStates`
  // (which mutates rows: flips paid_pending_clear→late_unpaid, rolls cycle
  // keys, etc.) because doing so would let a read-only simulation
  // permanently corrupt real bill state with a future/past date. The
  // engine's read path is pure, so the cycle math itself stays correct;
  // only the auto-state-transition side-effects are skipped under asOf.
  const asOfRaw = typeof req.query.asOf === "string" ? req.query.asOf : null;
  let asOf: Date | undefined;
  if (asOfRaw) {
    // Strict YYYY-MM-DD validation (no time, no timezone) — UTC-anchored
    // so the same string maps to the same simulated day regardless of
    // server locale.
    if (/^\d{4}-\d{2}-\d{2}$/.test(asOfRaw)) {
      const parsed = new Date(asOfRaw + "T00:00:00.000Z");
      if (!isNaN(parsed.getTime())) asOf = parsed;
    }
    if (!asOf) {
      res.status(400).json({ error: "asOf must be YYYY-MM-DD" });
      return;
    }
  }

  if (!asOf) {
    // Only run state-mutating sync on the real-clock path.
    await syncBillPaymentStates(new Date());
  }
  const cycle = await computeCycleState(asOf);
  res.json(
    GetDashboardCycleResponse.parse({
      ...cycle,
      lastBalanceUpdate: cycle.lastBalanceUpdate?.toISOString() ?? null,
      nextPayday: cycle.nextPayday?.toISOString().split("T")[0] ?? null,
    }),
  );
});

// Discretionary THIS MONTH — v8.0 MONTH-ANCHORED FLOW (Playbook Part 0/1).
//
//   discretionary = monthIncome − monthBillsObligated − monthVariable − monthOneTimeObligated
//
// NO Forward Reserve (it's a stock/timing buffer, not a flow item — subtracting
// it from a flow measure produces false catastrophic negatives).
// NO current-checking anchor (causes pre/post-payday swings).
//
// Result CAN be negative. Negative = the month is actually running a deficit.
// Do not floor; surface as red "running a deficit" per Part 5.
router.get("/dashboard/discretionary", async (_req, res): Promise<void> => {
  await syncBillPaymentStates(new Date());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  // ---- Inputs ----
  const [latestChecking] = await db
    .select()
    .from(balances)
    .where(eq(balances.accountType, "checking"))
    .orderBy(desc(balances.asOfDate))
    .limit(1);
  const checking = latestChecking
    ? parseFloat(latestChecking.amount as unknown as string)
    : 0;

  const allAssumps = await db.select().from(assumptions);
  const A = (k: string, dflt = 0) => {
    const r = allAssumps.find((a) => a.key === k);
    if (!r) return dflt;
    const raw = (r.value ?? "").toString().trim();
    if (raw === "") return dflt;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  const baseNetIncome = A("base_net_income", BASE_NET_INCOME);
  const variableCap = A("variable_spend_cap", VARIABLE_SPEND_CAP);
  const monthLengthDays = A("month_length_days", MONTH_LENGTH_DAYS);
  const minimumCushion = A("minimum_cushion", 0);
  const quicksilverBalanceOwed = A("quicksilver_balance_owed", 0);
  const mrrTarget = A("mrr_target", 700);
  const nrrTarget = A("nrr_target", 6000);
  const taxRate = A("commission_tax_rate", 0.435);
  // §1.2 override: empty/missing → use cap − logged. Numeric → use that.
  const overrideRow = allAssumps.find(
    (a) => a.key === "planned_variable_remaining_override",
  );
  const plannedVariableRemainingOverride: number | null =
    overrideRow &&
    overrideRow.value !== "" &&
    !isNaN(parseFloat(overrideRow.value))
      ? parseFloat(overrideRow.value)
      : null;

  // Pay schedule is cadence-driven (PRD: pay-cadence generalization). Cadence,
  // anchor and weekend-shift come from assumptions and DEFAULT to the legacy
  // semi-monthly 7th/22nd, prior-business-day schedule when unset (back-compat).
  // Deposit dates are generated for the current month and weekend-shifted.
  // v8.0 Fix 3 — per-paycheck income override: assumption key
  // `income_override:YYYY-MM-DD` keyed by the (shifted) deposit date. When set,
  // that paycheck uses the override instead of the per-period default. Unset →
  // fall back. Overrides are scoped per-payday. Editable via PUT /assumptions/{key}.
  const S = (k: string): string => {
    const r = allAssumps.find((a) => a.key === k);
    return (r?.value ?? "").toString();
  };
  const payConfig = resolvePayCadenceConfig(S);
  // UTC month bounds match payCadence's UTC convention. The local monthStart/
  // monthEnd above stay local — they drive bill/one-time/variable filtering.
  const cadenceMonthStart = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), 1),
  );
  const cadenceMonthEnd = new Date(
    Date.UTC(today.getFullYear(), today.getMonth() + 1, 0),
  );
  const monthPayDates = payDatesInWindow(
    payConfig.cadence,
    payConfig.anchor,
    payConfig.shift,
    cadenceMonthStart,
    cadenceMonthEnd,
    payConfig.startDate,
  );
  // net_per_period overrides the default per-deposit amount. Unset → spread the
  // base monthly net across the month's deposits, so legacy (2 deposits) keeps
  // baseNetIncome / 2.
  const netPerPeriodRaw = A("net_per_period", NaN);
  const netPerPaycheck =
    Number.isFinite(netPerPeriodRaw) && netPerPeriodRaw > 0
      ? netPerPeriodRaw
      : monthPayDates.length > 0
        ? baseNetIncome / monthPayDates.length
        : 0;
  const incomeOverrideFor = (paydayISO: string): number | null => {
    const row = allAssumps.find(
      (a) => a.key === `income_override:${paydayISO}`,
    );
    if (!row || row.value === "") return null;
    const n = parseFloat(row.value);
    // Accept any finite non-negative number — including 0, which models an
    // intentionally-missed paycheck (e.g. unpaid leave, payroll glitch).
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  let paychecksReceivedThisMonth = 0;
  let expectedRemainingPaychecks = 0;
  let paychecksReceivedCount = 0;
  let paychecksRemainingCount = 0;
  const paycheckBreakdown: {
    paydayDate: string;
    baseAmount: number;
    overrideAmount: number | null;
    appliedAmount: number;
    received: boolean;
  }[] = [];
  for (const dep of monthPayDates) {
    const iso = dep.toISOString().split("T")[0];
    const override = incomeOverrideFor(iso);
    const applied = override ?? netPerPaycheck;
    const received = dep.getTime() <= today.getTime();
    if (received) {
      paychecksReceivedThisMonth += applied;
      paychecksReceivedCount += 1;
    } else {
      // All generated deposits are already within [monthStart, monthEnd].
      expectedRemainingPaychecks += applied;
      paychecksRemainingCount += 1;
    }
    paycheckBreakdown.push({
      paydayDate: iso,
      baseAmount: netPerPaycheck,
      overrideAmount: override,
      appliedAmount: applied,
      received,
    });
  }
  const remainingPaychecksThisMonth = expectedRemainingPaychecks; // back-compat alias
  // Monthly net = sum of this month's deposits (drives the discipline ratios).
  // Legacy (2 × baseNetIncome/2) == baseNetIncome.
  const monthlyNetIncome =
    paychecksReceivedThisMonth + expectedRemainingPaychecks;
  // Single cadence-aware "next payday" for display (cycle window unification is
  // a later commit). Defaults reproduce the legacy deriveNextPayday exactly.
  const nextEffectivePayday = nextPayDate(
    payConfig.cadence,
    payConfig.anchor,
    payConfig.shift,
    today,
    payConfig.startDate,
  );

  // §1.2: commissionPaid (status=paid, payoutDate in [monthStart, today]) and
  // commissionPending (status=pending, payoutDate in (today, monthEnd]).
  const allCommissions = await db.select().from(commissions);
  let commissionPaidThisMonth = 0;
  let commissionPendingThisMonth = 0;
  for (const c of allCommissions) {
    if (!c.payoutDate) continue;
    const pd = new Date(c.payoutDate);
    if (
      pd.getFullYear() !== today.getFullYear() ||
      pd.getMonth() !== today.getMonth()
    )
      continue;
    // Prefer stored takeHome; fall back to recomputing if missing.
    const stored = parseFloat(c.takeHome);
    const amount =
      !isNaN(stored) && stored > 0
        ? stored
        : commissionTakeHome(
            parseFloat(c.mrrAchieved as unknown as string),
            parseFloat(c.nrrAchieved as unknown as string),
            mrrTarget,
            nrrTarget,
            taxRate,
          );
    if (c.status === "paid" && pd <= today) commissionPaidThisMonth += amount;
    else if (c.status === "pending" && pd > today && pd <= monthEnd)
      commissionPendingThisMonth += amount;
  }
  // Back-compat aliases for older UI fields:
  const confirmedCommissionAlready = commissionPaidThisMonth;
  const confirmedCommissionUnreceived = commissionPendingThisMonth;
  const confirmedCommissionTotal =
    commissionPaidThisMonth + commissionPendingThisMonth;

  // v8.0 Part 1.2 — monthBillsObligated = SUM(include=TRUE bills dueDay in
  // this month, payment_state != 'skipped_cycle'). Paid OR unpaid both count
  // (they're real month obligations). Skipped_cycle excluded — user explicitly
  // deferred to next cycle.
  const allBills = await db.select().from(bills);
  let billsThisMonthTotal = 0;
  let billsRemainingThisMonth = 0;
  let billsLateUnpaidThisMonth = 0;
  let billsPaidThisMonth = 0;
  let billsSkippedThisMonth = 0;
  const billsThisMonthDetail: {
    id: number;
    name: string;
    amount: number;
    dueDay: number;
    paymentState: string;
  }[] = [];
  const billsRemainingDetail: {
    id: number;
    name: string;
    amount: number;
    dueDay: number;
    paymentState: string;
  }[] = [];
  for (const b of allBills) {
    if (!b.includeInCycle) continue;
    const amt = parseFloat(b.amount);
    if (amt <= 0) continue;
    if (b.dueDay >= 1 && b.dueDay <= monthEnd.getDate()) {
      if (b.paymentState === "skipped_cycle") {
        billsSkippedThisMonth += amt;
      } else {
        billsThisMonthTotal += amt;
        billsThisMonthDetail.push({
          id: b.id,
          name: b.name,
          amount: amt,
          dueDay: b.dueDay,
          paymentState: b.paymentState,
        });
        if (b.paymentState === "paid") billsPaidThisMonth += amt;
        else if (b.paymentState === "late_unpaid")
          billsLateUnpaidThisMonth += amt;
      }
    }
    // billsRemaining = obligation still expected to leave checking before
    // month-end. Paid bills don't (money already gone). Skipped don't.
    if (
      b.dueDay >= today.getDate() &&
      b.dueDay <= monthEnd.getDate() &&
      b.paymentState !== "paid" &&
      b.paymentState !== "skipped_cycle"
    ) {
      billsRemainingThisMonth += amt;
      billsRemainingDetail.push({
        id: b.id,
        name: b.name,
        amount: amt,
        dueDay: b.dueDay,
        paymentState: b.paymentState,
      });
    }
  }

  // v8.0 Part 3 — one-time obligations.
  // Discretionary subtracts: non-deferred items dated this month (paid or not),
  // plus non-deferred undated unpaid items. Paid items are still month
  // obligations (the money already left this month). Deferred excluded entirely.
  const oteRows = await db.select().from(oneTimeExpenses);
  let oneTimeMonthObligated = 0;
  let oneTimeRemainingFromToday = 0;
  let oneTimeDeferredTotal = 0;
  let oneTimePaidThisMonth = 0;
  const oneTimeDetail: {
    id: number;
    description: string;
    amount: number;
    dueDate: string | null;
    paid: boolean;
    deferred: boolean;
  }[] = [];
  for (const o of oteRows) {
    const amt = parseFloat(o.amount);
    if (o.deferred) {
      oneTimeDeferredTotal += amt;
      continue;
    }
    const dd = o.dueDate ? new Date(o.dueDate) : null;
    const isThisMonth =
      dd === null
        ? !o.paid // undated unpaid → this month
        : dd >= monthStart && dd <= monthEnd;
    if (!isThisMonth) continue;

    oneTimeMonthObligated += amt;
    oneTimeDetail.push({
      id: o.id,
      description: o.description,
      amount: amt,
      dueDate: o.dueDate,
      paid: o.paid,
      deferred: o.deferred,
    });
    if (o.paid) {
      oneTimePaidThisMonth += amt;
    } else if (dd === null || dd >= today) {
      oneTimeRemainingFromToday += amt;
    } else {
      // Overdue unpaid: still in monthObligated (real obligation).
      oneTimeRemainingFromToday += amt;
    }
  }
  // Back-compat aliases for legacy fields:
  const oneTimeThisMonth = oneTimeMonthObligated;
  const oneTimeDatedThisMonth = oneTimeRemainingFromToday;
  const oneTimeUndated = 0;

  // v8.0 Part 4 — variable: ALL spend counts against cap (cash + QuickSilver).
  const allVs = await db.select().from(variableSpend);
  const monthVs = allVs.filter((v) => {
    const w = new Date(v.weekOf);
    return w >= monthStart && w <= monthEnd;
  });
  const variableLoggedThisMonth = monthVs.reduce(
    (s, v) => s + parseFloat(v.amount),
    0,
  );
  const variableSpentThisMonth = variableLoggedThisMonth;
  const quicksilverAccruedThisMonth = monthVs
    .filter((v) => v.quicksilver)
    .reduce((s, v) => s + parseFloat(v.amount), 0);

  // R-as-truth variable model:
  //   R = planned_variable_remaining_override if set, else variable_spend_cap.
  //   R is the user's stated reservation — what they've decided to set aside
  //   for variable spending the rest of the month. Edited via the Overview
  //   "Variable reserved" pill (with Prorate one-tap helper that suggests
  //   cap × daysRemaining / daysInMonth).
  // R subtracts directly from Available-to-Save (headline). It also drives
  // Projected EOM via qsRatio split of logged spend (variableExpectedRemainingCash).
  //   L = variableLoggedThisMonth — AUDIT TOTAL ONLY. Does NOT feed R or the
  //   headline. Surfaces in the pill as a "(spent $L)" awareness chip when
  //   L > R, and in the Discretionary tab as a flow analytic.
  // QuickSilver-flagged variable_spend rows STILL feed quicksilverOwed via
  // the sealed totalRequiredHold path — that's real card debt, not a
  // projection. Adding/deleting a CASH variable row leaves the headline
  // unchanged; adding/deleting a QS row moves it via quicksilverOwed.
  // Trailing daily rate is preserved for display analytics (burn pace) only.
  const dayOfMonth = today.getDate();
  const daysInMonth = monthEnd.getDate();
  const daysRemainingInMonth = Math.max(0, daysInMonth - dayOfMonth + 1);
  // Trailing daily rate (display analytic only — burn pace, etc.).
  const trailingDailyRate =
    dayOfMonth >= 7 && variableLoggedThisMonth > 0
      ? variableLoggedThisMonth / dayOfMonth
      : variableCap / monthLengthDays;
  // Legacy field kept for breakdown display; NOT used in headline.
  const variableExpectedRemainingTrailing = Math.max(
    0,
    trailingDailyRate * Math.max(0, daysRemainingInMonth - 1), // exclude today
  );
  // Variable cap remaining (cap − logged, floored).
  const variableCapRemaining = Math.max(
    0,
    variableCap - variableLoggedThisMonth,
  );
  // R-as-truth: variableExpectedRemaining IS the user's stored reservation
  // (override) directly, falling back to cap when unset. Decoupled from L —
  // logging/deleting cash variable rows does not change this value.
  const variableExpectedRemaining =
    plannedVariableRemainingOverride !== null
      ? Math.max(0, plannedVariableRemainingOverride)
      : variableCap;
  const monthVariableObligation = variableExpectedRemaining; // analytics alias
  const variableRemainingThisMonth = variableExpectedRemaining; // back-compat

  // ============================================================
  // v8.0 HEADLINE — month-anchored flow (Part 0/1).
  //
  //   discretionary = monthIncome
  //                 − monthBillsObligated
  //                 − monthVariable (logged + expected_remaining)
  //                 − monthOneTimeObligated
  //
  // NO forward reserve. NO checking anchor. Can be negative.
  // ============================================================
  const totalMonthIncome =
    paychecksReceivedThisMonth +
    expectedRemainingPaychecks +
    commissionPaidThisMonth +
    commissionPendingThisMonth;
  const totalMonthOutgo =
    billsThisMonthTotal + monthVariableObligation + oneTimeMonthObligated;
  const discretionaryHeadline = totalMonthIncome - totalMonthOutgo;

  // Cycle (Safe to Spend) still uses the FROZEN engine for back-compat.
  const cycle = await computeCycleState();

  // Back-compat aliases for legacy UI still referencing the old field names.
  const inflows = totalMonthIncome;
  const outflows = totalMonthOutgo;

  const round = (n: number) => Math.round(n * 100) / 100;

  // ---- Discipline metrics — engine-sourced where possible ----
  const monthBillRows = await billsThisMonth(today);
  const monthBillsForEngine: EngineBill[] = monthBillRows.map(
    (b) => new EngineBill(b.name, b.amount, b.dueDay, true, b.category),
  );
  const fixedMonthlyTotal = monthBillsForEngine.reduce(
    (s, b) => s + b.amount,
    0,
  );
  const fixedRatio =
    monthlyNetIncome > 0 ? fixedMonthlyTotal / monthlyNetIncome : 0;

  // Monthly Savings = Discretionary − $100 conservative buffer (Playbook B62
  // placeholder). Floored at 0 because "savings" can't be negative — when
  // Discretionary is negative, savings is simply $0 and the negative is shown
  // on the Discretionary line itself.
  const engineSavings = Math.max(0, discretionaryHeadline - 100);
  const savingsRate =
    monthlyNetIncome > 0
      ? engineSavings / (monthlyNetIncome + confirmedCommissionTotal)
      : 0;

  // Cap-derived prorated remaining (legacy breakdown row). Distinct from the
  // trailing-rate-derived variableExpectedRemaining used in the headline.
  const proratedVariableRemainingForBreakdown =
    daysRemainingInMonth * (variableCap / monthLengthDays);

  const expectedVarByNow = (variableCap * dayOfMonth) / daysInMonth;
  const variableBurnPace =
    expectedVarByNow > 0 ? variableSpentThisMonth / expectedVarByNow : 0;
  const statusFor = (
    val: number,
    warnAt: number,
    failAt: number,
    invert = false,
  ): "green" | "amber" | "red" => {
    if (invert) {
      if (val < failAt) return "red";
      if (val < warnAt) return "amber";
      return "green";
    }
    if (val > failAt) return "red";
    if (val > warnAt) return "amber";
    return "green";
  };
  const discipline = {
    fixedMonthlyTotal: round(fixedMonthlyTotal),
    fixedRatio: Math.round(fixedRatio * 1000) / 1000,
    fixedRatioStatus: statusFor(fixedRatio, 0.5, 0.65),
    variableBurnPace: Math.round(variableBurnPace * 1000) / 1000,
    variableBurnPaceStatus: statusFor(variableBurnPace, 1.1, 1.5),
    expectedVariableByNow: round(expectedVarByNow),
    savingsRate: Math.round(savingsRate * 1000) / 1000,
    savingsRateStatus: statusFor(savingsRate, 0.2, 0.1, true),
    dayOfMonth,
    daysInMonth,
  };

  res.json({
    // v8.0 HEADLINE — month-anchored flow. No forward reserve, no checking anchor.
    discretionaryThisMonth: round(discretionaryHeadline),
    monthlySavings: round(engineSavings),
    monthEnd: monthEnd.toISOString().split("T")[0],
    nextEffectivePayday: nextEffectivePayday.toISOString().split("T")[0],

    // Forward Reserve surfaced for cross-reference ONLY (Safe to Spend uses it).
    // NOT subtracted from Discretionary headline per Part 0/1.
    forwardReserve: round(cycle.forwardReserve),
    proratedVariableRemainingThisMonth: round(
      proratedVariableRemainingForBreakdown,
    ),
    daysRemainingInMonth,

    // Income ledger (full month, stable)
    paychecksReceivedThisMonth: round(paychecksReceivedThisMonth),
    paychecksReceivedCount,
    expectedRemainingPaychecks: round(expectedRemainingPaychecks),
    // Fix 3: per-paycheck breakdown with optional overrides
    paycheckBreakdown: paycheckBreakdown.map((p) => ({
      ...p,
      baseAmount: round(p.baseAmount),
      overrideAmount:
        p.overrideAmount !== null ? round(p.overrideAmount) : null,
      appliedAmount: round(p.appliedAmount),
    })),
    commissionPaidThisMonth: round(commissionPaidThisMonth),
    commissionPendingThisMonth: round(commissionPendingThisMonth),
    totalMonthIncome: round(totalMonthIncome),

    // Outgo ledger (month-obligated)
    billsThisMonth: round(billsThisMonthTotal),
    billsThisMonthDetail,
    billsLateUnpaidThisMonth: round(billsLateUnpaidThisMonth),
    billsPaidThisMonth: round(billsPaidThisMonth),
    billsSkippedThisMonth: round(billsSkippedThisMonth),
    variableLoggedThisMonth: round(variableLoggedThisMonth),
    variableExpectedRemaining: round(variableExpectedRemaining),
    variableExpectedRemainingTrailing: round(variableExpectedRemainingTrailing),
    variableCapRemaining: round(variableCapRemaining),
    monthVariableObligation: round(monthVariableObligation),
    trailingDailyRate: round(trailingDailyRate),
    plannedVariableRemainingOverride,
    oneTimeThisMonth: round(oneTimeThisMonth),
    oneTimeMonthObligated: round(oneTimeMonthObligated),
    oneTimePaidThisMonth: round(oneTimePaidThisMonth),
    oneTimeDeferredTotal: round(oneTimeDeferredTotal),
    oneTimeDetail,
    totalMonthOutgo: round(totalMonthOutgo),

    // Back-compat aliases
    checking: round(checking),
    remainingPaychecksThisMonth,
    paychecksRemainingCount,
    baseNetIncome,
    confirmedCommissionUnreceived: round(confirmedCommissionUnreceived),
    confirmedCommissionAlready: round(confirmedCommissionAlready),
    totalInflowsAvailable: round(inflows),
    billsRemainingThisMonth: round(billsRemainingThisMonth),
    billsRemainingDetail,
    oneTimeDatedThisMonth: round(oneTimeDatedThisMonth),
    oneTimeUndatedAdvisory: round(oneTimeUndated),
    variableCap,
    variableSpentThisMonth: round(variableSpentThisMonth),
    variableRemainingThisMonth: round(variableRemainingThisMonth),
    quicksilverBalanceOwed: round(quicksilverBalanceOwed),
    quicksilverAccruedThisMonth: round(quicksilverAccruedThisMonth),
    minimumCushion: round(minimumCushion),
    totalReservationsRequired: round(outflows),

    // §1.1 Forward Reserve subtraction applied inside engine (task #9).
    safeToSpend: cycle.safeToSpend,
    cycleStatus: cycle.status,
    discipline,
  });
});

// ============================================================
// v8.3 — CASH POSITION endpoint
//
// Answers the user's real question: "What will my checking actually look like
// at the end of the month, given some 'paid' bills haven't actually debited
// yet?" Discretionary is income-flow math (full month income vs full month
// obligations). Cash position is balance-flow math (current checking +
// remaining income − every dollar that still has to leave checking).
//
//   projectedEndOfMonthChecking
//     = currentChecking
//     + incomeStillToReceive          (paychecks not yet received + pending commission)
//     − billsNotYetDebited            (paid_pending_clear + paid w/o clearedDate + late_unpaid)
//     − variableExpectedRemaining     (planned variable still to spend from cash)
//     − oneTimeStillToPay             (non-deferred one-times still unpaid)
//
// Each bill is classified explicitly so the UI can offer a per-bill
// "did this debit yet?" toggle. A bill marked `paid` WITHOUT a clearedDate
// is treated as not-yet-debited (you told the engine you paid it, but the
// money hasn't actually left checking). This is the field that's been
// silently inflating "available" numbers.
// ============================================================
router.get("/dashboard/cash-position", async (_req, res): Promise<void> => {
  await syncBillPaymentStates(new Date());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  // ---- Current checking ----
  const [latestChecking] = await db
    .select()
    .from(balances)
    .where(eq(balances.accountType, "checking"))
    .orderBy(desc(balances.asOfDate))
    .limit(1);
  const currentChecking = latestChecking
    ? parseFloat(latestChecking.amount as unknown as string)
    : 0;
  const lastBalanceUpdate = latestChecking?.asOfDate ?? null;
  const cycle = await computeCycleState(today);

  // ---- Assumptions ----
  const allAssumps = await db.select().from(assumptions);
  const A = (k: string, dflt = 0) => {
    const r = allAssumps.find((a) => a.key === k);
    if (!r) return dflt;
    const raw = (r.value ?? "").toString().trim();
    if (raw === "") return dflt;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  const baseNetIncome = A("base_net_income", BASE_NET_INCOME);
  const variableCap = A("variable_spend_cap", VARIABLE_SPEND_CAP);
  const plannedVariableRemainingOverride = (() => {
    const r = allAssumps.find(
      (a) => a.key === "planned_variable_remaining_override",
    );
    if (!r) return null;
    const raw = (r.value ?? "").toString().trim();
    if (raw === "") return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  })();

  // ---- Income still to receive this month ----
  // Cadence-driven (PRD). Deposit dates default to the legacy 7th/22nd schedule
  // when no cadence assumptions are set. Any deposit strictly after today is
  // still expected; per-period amount honors net_per_period and per-date
  // income_override (keyed by the shifted deposit date).
  const S = (k: string): string => {
    const r = allAssumps.find((a) => a.key === k);
    return (r?.value ?? "").toString();
  };
  const payConfig = resolvePayCadenceConfig(S);
  const cadenceMonthStart = new Date(
    Date.UTC(today.getFullYear(), today.getMonth(), 1),
  );
  const cadenceMonthEnd = new Date(
    Date.UTC(today.getFullYear(), today.getMonth() + 1, 0),
  );
  const monthPayDates = payDatesInWindow(
    payConfig.cadence,
    payConfig.anchor,
    payConfig.shift,
    cadenceMonthStart,
    cadenceMonthEnd,
    payConfig.startDate,
  );
  const netPerPeriodRaw = A("net_per_period", NaN);
  const netPerPaycheck =
    Number.isFinite(netPerPeriodRaw) && netPerPeriodRaw > 0
      ? netPerPeriodRaw
      : monthPayDates.length > 0
        ? baseNetIncome / monthPayDates.length
        : 0;
  const incomeOverrideFor = (paydayISO: string): number | null => {
    const row = allAssumps.find(
      (a) => a.key === `income_override:${paydayISO}`,
    );
    if (!row || row.value === "") return null;
    const n = parseFloat(row.value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  let incomeStillToReceive = 0;
  const paychecksStillExpected: { date: string; amount: number }[] = [];
  for (const p of monthPayDates) {
    if (p.getTime() > today.getTime()) {
      const iso = p.toISOString().split("T")[0];
      const amt = incomeOverrideFor(iso) ?? netPerPaycheck;
      incomeStillToReceive += amt;
      paychecksStillExpected.push({ date: iso, amount: amt });
    }
  }

  // Pending commissions (status=confirmed, not yet received this month)
  const commsRows = await db.select().from(commissions);
  let pendingCommissionUnreceived = 0;
  for (const c of commsRows) {
    if (c.status !== "confirmed") continue;
    const expected = c.payoutDate ? new Date(c.payoutDate) : null;
    if (!expected) continue;
    if (expected < monthStart || expected > monthEnd) continue;
    if (expected <= today) continue; // already in checking presumably
    pendingCommissionUnreceived += parseFloat(c.takeHome as unknown as string);
  }
  incomeStillToReceive += pendingCommissionUnreceived;

  // ---- Bill classification ----
  // Three buckets for May bills (dueDay in 1..monthEnd):
  //   alreadyDebited     state=paid AND clearedDate set
  //   notYetDebited      state=paid w/o clearedDate, OR paid_pending_clear, OR late_unpaid
  //   scheduledUnpaid    state=scheduled (counted in notYetDebited too; future debit)
  //   skipped            excluded
  const allBills = await db.select().from(bills);
  type BillRow = {
    id: number;
    name: string;
    amount: number;
    dueDay: number;
    paymentState: string;
    paidDate: string | null;
    clearedDate: string | null;
    cashStatus: "debited" | "pending" | "late" | "scheduled";
  };
  let billsAlreadyDebited = 0;
  let billsNotYetDebited = 0;
  const billsAlreadyDebitedDetail: BillRow[] = [];
  const billsNotYetDebitedDetail: BillRow[] = [];
  for (const b of allBills) {
    if (!b.includeInCycle) continue;
    const amt = parseFloat(b.amount);
    if (amt <= 0) continue;
    if (b.dueDay < 1 || b.dueDay > monthEnd.getDate()) continue;
    if (b.paymentState === "skipped_cycle") continue;
    // QuickSilver / credit-card statement bills (category 'variable') are NOT
    // a checking debit — they're card debt tracked via the separate
    // quicksilverOwed hold path. Counting them here as a remaining bill AND in
    // the QS path double-counts, so exclude them from this checking-flow total.
    // (They still surface in the cycle / Safe-to-Spend QS views.)
    if (b.category === "variable") continue;

    const paidDateStr = b.paidDate
      ? new Date(b.paidDate).toISOString().split("T")[0]
      : null;
    const clearedDateStr = b.clearedDate
      ? new Date(b.clearedDate).toISOString().split("T")[0]
      : null;
    const isCleared = b.paymentState === "paid";

    let cashStatus: BillRow["cashStatus"];
    if (isCleared) cashStatus = "debited";
    else if (b.paymentState === "late_unpaid") cashStatus = "late";
    else if (b.paymentState === "paid_pending_clear") cashStatus = "pending";
    else cashStatus = "scheduled";

    const row: BillRow = {
      id: b.id,
      name: b.name,
      amount: amt,
      dueDay: b.dueDay,
      paymentState: b.paymentState,
      paidDate: paidDateStr,
      clearedDate: clearedDateStr,
      cashStatus,
    };

    if (cashStatus === "debited") {
      billsAlreadyDebited += amt;
      billsAlreadyDebitedDetail.push(row);
    } else {
      billsNotYetDebited += amt;
      billsNotYetDebitedDetail.push(row);
    }
  }

  // ---- R-as-truth (PRORATED): variable reservation drives the headline ----
  // variableExpectedRemaining = R = the user's stored reservation (override
  // assumption) when set — including an explicit 0, their manual lever — else
  // the PRORATED remaining variable for the rest of THIS month
  // (cap × daysRemaining / daysInMonth), NOT the full monthly cap. The cap
  // resets monthly, so mid-month the relevant reservation is only what's left.
  // Decoupled from L — adding/deleting CASH variable rows does NOT change R or
  // the headline. QuickSilver-flagged rows still flow into quicksilverOwed via
  // the sealed totalRequiredHold path; that's real card debt.
  // L is still computed: used (a) for the qsRatio split below so Projected
  // EOM stays consistent with R, (b) for the pill's "(spent $L)" overspend
  // chip, (c) for Discretionary tab analytics.
  const allVs = await db.select().from(variableSpend);
  const monthVs = allVs.filter((v) => {
    const w = new Date(v.weekOf);
    return w >= monthStart && w <= monthEnd;
  });
  const variableLoggedThisMonth = monthVs.reduce(
    (s, v) => s + parseFloat(v.amount),
    0,
  );
  const quicksilverAccruedThisMonth = monthVs
    .filter((v) => v.quicksilver)
    .reduce((s, v) => s + parseFloat(v.amount), 0);
  const dayOfMonth = today.getDate();
  const daysInMonth = monthEnd.getDate();
  const daysRemainingInMonth = Math.max(0, daysInMonth - dayOfMonth + 1);
  const proratedVariableRemaining =
    daysInMonth > 0 ? (variableCap * daysRemainingInMonth) / daysInMonth : 0;
  const variableExpectedRemaining =
    plannedVariableRemainingOverride !== null
      ? Math.max(0, plannedVariableRemainingOverride)
      : proratedVariableRemaining;
  // Pro-rate R into cash and QS portions using the logged QS:cash mix so
  // Projected EOM stays in sync with the headline (Q2 of R-as-truth design).
  const qsRatio =
    variableLoggedThisMonth > 0
      ? quicksilverAccruedThisMonth / variableLoggedThisMonth
      : 0;
  const variableExpectedRemainingCash =
    variableExpectedRemaining * (1 - qsRatio);
  const variableExpectedRemainingQs = variableExpectedRemaining * qsRatio;

  // ---- One-time still to pay (non-deferred, unpaid, this month or undated) ----
  const oteRows = await db.select().from(oneTimeExpenses);
  let oneTimeStillToPay = 0;
  const oneTimeStillToPayDetail: {
    id: number;
    description: string;
    amount: number;
    dueDate: string | null;
  }[] = [];
  for (const o of oteRows) {
    if (o.deferred || o.paid) continue;
    const amt = parseFloat(o.amount);
    const dd = o.dueDate ? new Date(o.dueDate) : null;
    const inWindow = dd === null || (dd >= monthStart && dd <= monthEnd);
    if (!inWindow) continue;
    oneTimeStillToPay += amt;
    oneTimeStillToPayDetail.push({
      id: o.id,
      description: o.description,
      amount: amt,
      dueDate: o.dueDate,
    });
  }

  // ---- Projections ----
  //   commitmentOutflowsRemaining = THIS month's remaining bills + one-time.
  //   commitmentBalance = checking − full required hold. DIAGNOSTIC ONLY now
  //     (kept for cross-reference); the hold includes the next-month forward
  //     reserve, so it is NOT the savable headline.
  //   availableToInvest = the headline savable, on a remaining-obligations basis:
  //       checking − billsNotYetDebited − oneTimeStillToPay − R (prorated variable)
  //   ONLY these three reductions. The next-month forward reserve stays in the
  //   cycle hold (Safe to Spend) and is NOT subtracted here. There is NO
  //   earlyNextMonthVariable term: prorated R already reserves this month's
  //   variable and the cycle hold already handles next-month bills — adding a
  //   flat $130 would double-count.
  const commitmentOutflowsRemaining = billsNotYetDebited + oneTimeStillToPay;
  const commitmentBalance = currentChecking - cycle.totalRequiredHold;
  // QS variable rows still move the user's real position via the sealed hold
  // path (quicksilverOwed → totalRequiredHold → commitmentBalance); that
  // invariant is preserved in the diagnostic commitmentBalance above.
  // earlyNextMonthVariable is retained only as a display label (below); it does
  // NOT reduce availableToInvest.
  const earlyNextMonthVariable = 130;
  const availableToInvest =
    currentChecking - commitmentOutflowsRemaining - variableExpectedRemaining;
  const totalCashOutflowsRemaining =
    commitmentOutflowsRemaining + variableExpectedRemainingCash;
  const projectedEndOfMonthChecking =
    currentChecking + incomeStillToReceive - totalCashOutflowsRemaining;

  const daysSinceUpdate = lastBalanceUpdate
    ? Math.floor(
        (today.getTime() - new Date(lastBalanceUpdate).getTime()) / 86400000,
      )
    : null;

  const round = (n: number) => Math.round(n * 100) / 100;

  res.json({
    asOf: today.toISOString().split("T")[0],
    monthEnd: monthEnd.toISOString().split("T")[0],
    // Starting point
    currentChecking: round(currentChecking),
    lastBalanceUpdate: lastBalanceUpdate
      ? new Date(lastBalanceUpdate).toISOString()
      : null,
    daysSinceUpdate,
    // Inflows
    incomeStillToReceive: round(incomeStillToReceive),
    paychecksStillExpected,
    pendingCommissionUnreceived: round(pendingCommissionUnreceived),
    // Outflows — bills
    billsAlreadyDebited: round(billsAlreadyDebited),
    billsAlreadyDebitedDetail,
    billsNotYetDebited: round(billsNotYetDebited),
    billsNotYetDebitedDetail,
    // Outflows — variable
    variableExpectedRemaining: round(variableExpectedRemaining),
    variableExpectedRemainingCash: round(variableExpectedRemainingCash),
    variableExpectedRemainingQs: round(variableExpectedRemainingQs),
    quicksilverAccruedRatio: Math.round(qsRatio * 1000) / 1000,
    // Outflows — one-time
    oneTimeStillToPay: round(oneTimeStillToPay),
    oneTimeStillToPayDetail,
    // Totals
    commitmentOutflowsRemaining: round(commitmentOutflowsRemaining),
    // Raw "checking − hold" — diagnostic only. The headline number the UI
    // shows is availableToInvest, which additionally subtracts R.
    commitmentBalance: round(commitmentBalance),
    // Canonical user-facing headline = commitmentBalance − R. The dollar
    // amount you can safely sweep to HYSA / brokerage right now without
    // bouncing a known obligation AND while still leaving your stated
    // variable reservation (R) intact.
    availableToInvest: round(availableToInvest),
    earlyNextMonthVariable: round(earlyNextMonthVariable),
    totalCashOutflowsRemaining: round(totalCashOutflowsRemaining),
    projectedEndOfMonthChecking: round(projectedEndOfMonthChecking),
    // Status flags — track the headline (availableToInvest), not the raw.
    isDeficit: availableToInvest < 0,
    isTight: availableToInvest >= 0 && availableToInvest < 100,
  });
});

// Lightweight integrity summary for the dashboard banner.
// Does NOT log a row. Independent of /integrity/check (which logs).
router.get("/dashboard/integrity-summary", async (_req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const checks: {
    name: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }[] = [];

  // 1. Balance freshness
  const { balances } = await import("@workspace/db");
  const [latestBalance] = await db
    .select()
    .from(balances)
    .where(eq(balances.accountType, "checking"))
    .orderBy(desc(balances.asOfDate))
    .limit(1);
  if (!latestBalance) {
    checks.push({
      name: "Checking balance",
      status: "fail",
      detail: "No checking balance recorded.",
    });
  } else {
    const days = Math.floor(
      (today.getTime() - new Date(latestBalance.asOfDate).getTime()) / 86400000,
    );
    if (days > 3)
      checks.push({
        name: "Balance freshness",
        status: "fail",
        detail: `Updated ${days} days ago — must be ≤3.`,
      });
    else
      checks.push({
        name: "Balance freshness",
        status: "pass",
        detail: `Updated ${days} day(s) ago.`,
      });
  }

  // 2. Next payday — cadence-derived (single source). No assumption row is
  // required; defaults to the legacy 7th/22nd schedule. Surfaces the derived
  // date for transparency.
  const derivedPayday = await deriveNextPayday(today);
  checks.push({
    name: "Next payday (derived)",
    status: "pass",
    detail: `Payday: ${derivedPayday.toISOString().slice(0, 10)} (cadence-derived).`,
  });

  // 3. Active bills exist
  const allBills = await db.select().from(bills);
  const active = allBills.filter(
    (b) => b.includeInCycle && parseFloat(b.amount) > 0,
  );
  if (active.length === 0)
    checks.push({
      name: "Active bills",
      status: "warn",
      detail: "No bills marked Include=TRUE.",
    });
  else
    checks.push({
      name: "Active bills",
      status: "pass",
      detail: `${active.length} active bills.`,
    });

  // 4. No negative bills
  const negBills = allBills.filter((b) => parseFloat(b.amount) < 0);
  if (negBills.length > 0)
    checks.push({
      name: "Bill amounts non-negative",
      status: "fail",
      detail: `${negBills.length} bill(s) have negative amounts.`,
    });
  else
    checks.push({
      name: "Bill amounts non-negative",
      status: "pass",
      detail: "All bills ≥ 0.",
    });

  // 5. Base net income
  const [incRow] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "base_net_income"));
  if (!incRow || parseFloat(incRow.value) <= 0)
    checks.push({
      name: "Base net income",
      status: "fail",
      detail: "Set in Settings.",
    });
  else
    checks.push({
      name: "Base net income",
      status: "pass",
      detail: `$${parseFloat(incRow.value).toFixed(2)}/mo`,
    });

  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const overall: "pass" | "warn" | "fail" =
    failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  res.json({ overall, failCount, warnCount, checks });
});

export default router;
