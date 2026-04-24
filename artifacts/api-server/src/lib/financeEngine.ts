import { db } from "@workspace/db";
import {
  assumptions,
  oneTimeExpenses,
  variableSpend,
  balances,
  commissions,
  retirementPlan,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  Bill as EngineBill,
  CommissionRow as EngineCommissionRow,
  OneTimeExpense as EngineOneTimeExpense,
  PurchaseOption,
  d as utcDay,
  effectivePayday as engineEffectivePayday,
  nextNominalPayday,
  daysUntilPayday as engineDaysUntilPayday,
  daysSinceUpdate as engineDaysSinceUpdate,
  isStale,
  paydayRiskFlag,
  safeToSpend,
  cycleStatus,
  dailyRateStatic,
  dailyRateRealtime,
  daysOfCoverage,
  forwardReserve as engineForwardReserve,
  oneTimeExpensesDueInCycle,
  monthlySavingsEstimate,
  matchGapAnalysis,
  mrrPayoutGross,
  nrrPayoutGross,
  commissionTakeHome,
  commissionPayoutDate,
  decisionSandboxCompare,
  droughtSurvivalRunway,
  incomeReplacementFloor,
  incomeGrowthScenario,
  pmt,
} from "@workspace/finance";
import {
  enumerateBills,
  forwardReserveFixed,
  deriveNextNominalPayday,
} from "./cycleBillEngine";

export interface CycleState {
  checkingBalance: number;
  lastBalanceUpdate: Date | null;
  nextPayday: Date | null;
  nextPaydayNominal: Date | null;
  daysSinceUpdate: number | null;
  isStale: boolean;
  daysUntilPayday: number | null;
  billsDueBeforePayday: number;
  pendingHoldsReserve: number;
  minimumCushion: number;
  oneTimeDueBeforePayday: number;
  totalRequiredHold: number;
  safeToSpend: number;
  dailyRateFromUpdate: number;
  dailyRateRealTime: number;
  daysOfCoverage: number | null;
  variableSpendUntilPayday: number;
  remainingDiscretionary: number;
  status: "GREEN" | "YELLOW" | "RED";
  paydayRisk: boolean;
  forwardReserve: number;
  alertThreshold: number;
}

export interface MonthlySavingsState {
  baseNetIncome: number;
  confirmedCommission: number;
  totalMonthIncome: number;
  fullMonthFixedBills: number;
  remainingVariableSpendProrated: number;
  knownOneTimeCosts: number;
  quicksilverAccrual: number;
  quicksilverBalanceOwed: number;
  forwardReserve: number;
  estimatedMonthlySavings: number;
  matchGapActive: boolean;
  monthlyMatchGapCost: number;
  savingsAfterMatchBump: number;
  canAffordMatchBump: boolean;
}

async function getAssumption(key: string, fallback: number): Promise<number> {
  const [row] = await db.select().from(assumptions).where(eq(assumptions.key, key));
  if (!row) return fallback;
  return parseFloat(row.value) || fallback;
}

function utcStartOfDay(date: Date): Date {
  return utcDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * Re-export of engine's effectivePayday so other modules don't reach into
 * @workspace/finance directly. Returns weekend-adjusted (Sat/Sun -> Fri).
 */
export function effectivePayday(nominal: Date): Date {
  return engineEffectivePayday(utcStartOfDay(nominal));
}

/**
 * Derive next payday: earliest of {7th, 22nd} that falls on or after `today`,
 * weekend-adjusted. Delegates to the reference engine.
 */
export function deriveNextPayday(today: Date): Date {
  return engineEffectivePayday(nextNominalPayday(utcStartOfDay(today)));
}

export async function computeCycleState(): Promise<CycleState> {
  const alertThreshold = await getAssumption("alert_threshold", 400);
  const monthLengthDays = await getAssumption("month_length_days", 30.4);
  const variableSpendCap = await getAssumption("variable_spend_cap", 600);

  const [latestChecking] = await db
    .select()
    .from(balances)
    .where(eq(balances.accountType, "checking"))
    .orderBy(desc(balances.asOfDate))
    .limit(1);

  const checkingBalance = latestChecking ? parseFloat(latestChecking.amount) : 0;
  const lastBalanceUpdate = latestChecking ? new Date(latestChecking.asOfDate) : null;

  const today = utcStartOfDay(new Date());

  const daysSinceUpdate = lastBalanceUpdate
    ? engineDaysSinceUpdate(utcStartOfDay(lastBalanceUpdate), today)
    : null;

  const stale = daysSinceUpdate === null || isStale(utcStartOfDay(lastBalanceUpdate ?? today), today);

  const nextPaydayNominal = deriveNextNominalPayday(today);
  const nextPayday = engineEffectivePayday(nextPaydayNominal);

  const daysUntilPayday = engineDaysUntilPayday(today, nextPaydayNominal);
  const paydayRisk = paydayRiskFlag(nextPaydayNominal);

  // Bills in current cycle hold (engine enforces strict < effective payday).
  const enriched = await enumerateBills(today);
  const billsDueBeforePayday = enriched
    .filter((b) => b.countsThisCycle)
    .reduce((s, b) => s + b.amount, 0);

  const pendingHoldsReserve = await getAssumption("pending_holds_reserve", 0);
  const minimumCushion = await getAssumption("minimum_cushion", 0);

  // One-time expenses due in cycle (engine: <= effective payday, inclusive).
  const allOneTime = await db.select().from(oneTimeExpenses);
  const engineOneTimes = allOneTime.map(
    (o) =>
      new EngineOneTimeExpense(
        o.description,
        parseFloat(o.amount),
        o.dueDate ? utcStartOfDay(new Date(o.dueDate)) : null,
        o.paid,
      ),
  );
  const oneTimeDueBeforePayday = oneTimeExpensesDueInCycle(
    engineOneTimes,
    today,
    nextPaydayNominal,
  );

  // Forward Reserve (1st-7th bills + 7d variable). Use engine.
  const activeEngineBills = enriched
    .filter((b) => b.isActivePeriod)
    .map(
      (b) =>
        new EngineBill(b.name, b.amount, b.dueDay, b.includeInCycle, b.category, b.autopay),
    );
  const forwardReserve = engineForwardReserve(activeEngineBills, variableSpendCap, monthLengthDays);

  // Required Hold per BUILD_SPEC §4.4: bills + pending + cushion + one-time only.
  // Forward Reserve is NOT subtracted from Safe to Spend.
  const totalRequiredHold =
    billsDueBeforePayday + pendingHoldsReserve + minimumCushion + oneTimeDueBeforePayday;

  const variableSpendUntilPayday = await getAssumption("variable_spend_until_payday", 0);

  const sts = safeToSpend(checkingBalance, billsDueBeforePayday, {
    pendingHolds: pendingHoldsReserve,
    minimumCushion,
    oneTimeDueTotal: oneTimeDueBeforePayday,
    forwardReserveAmount: forwardReserve,
    includeForwardReserveInSts: true,
  });

  const lastUpdateDate = lastBalanceUpdate ? utcStartOfDay(lastBalanceUpdate) : today;

  const dailyRateFromUpdate = dailyRateStatic(
    sts,
    variableSpendUntilPayday,
    nextPaydayNominal,
    lastUpdateDate,
  );

  const dailyRateRealTime = dailyRateRealtime(
    sts,
    variableSpendUntilPayday,
    nextPaydayNominal,
    today,
  );

  const coverage = daysOfCoverage(sts, dailyRateFromUpdate);

  const remainingDiscretionary = Math.max(0, sts - variableSpendUntilPayday);

  // Status: engine GREEN (>=threshold), YELLOW (0<sts<threshold), RED (sts<=0).
  // The api shape distinguishes RED only when checking < hold. With
  // sts = max(0, checking - hold), sts<=0 already implies checking<=hold,
  // so engine status == api status.
  const status = cycleStatus(sts, alertThreshold);

  return {
    checkingBalance,
    lastBalanceUpdate,
    nextPayday,
    nextPaydayNominal,
    daysSinceUpdate,
    isStale: stale,
    daysUntilPayday,
    billsDueBeforePayday,
    pendingHoldsReserve,
    minimumCushion,
    oneTimeDueBeforePayday,
    totalRequiredHold,
    safeToSpend: sts,
    dailyRateFromUpdate,
    dailyRateRealTime,
    daysOfCoverage: coverage,
    variableSpendUntilPayday,
    remainingDiscretionary,
    status,
    paydayRisk,
    forwardReserve,
    alertThreshold,
  };
}

export async function computeMonthlySavings(): Promise<MonthlySavingsState> {
  const monthLengthDays = await getAssumption("month_length_days", 30.4);
  const variableSpendCap = await getAssumption("variable_spend_cap", 600);
  const baseNetIncome = await getAssumption("base_net_income", 3220);

  const today = utcStartOfDay(new Date());
  const nextPaydayNominal = deriveNextNominalPayday(today);

  // Confirmed commission this cycle (paid this month, on or before today)
  const allCommissions = await db.select().from(commissions);
  let confirmedCommission = 0;
  for (const c of allCommissions) {
    if (!c.payoutDate) continue;
    const pd = utcStartOfDay(new Date(c.payoutDate));
    if (
      pd.getUTCFullYear() === today.getUTCFullYear() &&
      pd.getUTCMonth() === today.getUTCMonth() &&
      pd.getTime() <= today.getTime() &&
      (c.status === "paid" || c.status === "confirmed")
    ) {
      confirmedCommission += parseFloat(c.takeHome);
    }
  }

  // Build engine-typed bills/one-times for monthlySavingsEstimate
  const enriched = await enumerateBills(today);
  const includedEngineBills = enriched
    .filter((b) => b.countsThisMonth)
    .map(
      (b) =>
        new EngineBill(b.name, b.amount, b.dueDay, b.includeInCycle, b.category, b.autopay),
    );
  const allActiveEngineBills = enriched
    .filter((b) => b.isActivePeriod)
    .map(
      (b) =>
        new EngineBill(b.name, b.amount, b.dueDay, b.includeInCycle, b.category, b.autopay),
    );

  const fullMonthFixedBills = includedEngineBills.reduce((s, b) => s + b.amount, 0);

  const allOneTimeRows = await db.select().from(oneTimeExpenses);
  const engineOneTimes = allOneTimeRows.map(
    (o) =>
      new EngineOneTimeExpense(
        o.description,
        parseFloat(o.amount),
        o.dueDate ? utcStartOfDay(new Date(o.dueDate)) : null,
        o.paid,
      ),
  );
  const knownOneTimeCosts = engineOneTimes
    .filter((o) => !o.paid)
    .reduce((s, o) => s + o.amount, 0);

  // QuickSilver: manual `quicksilver_balance_owed` is the canonical reserve
  // line. We expose `quicksilverAccrual` (logged QS spend this month) for
  // context only; subtracting it would double-count against the variable cap.
  const vsEntries = await db.select().from(variableSpend);
  let quicksilverAccrual = 0;
  for (const vs of vsEntries) {
    if (vs.quicksilver) quicksilverAccrual += parseFloat(vs.amount);
  }
  const quicksilverBalanceOwed = await getAssumption("quicksilver_balance_owed", 0);

  // Days-to-payday × cap / month-length, ROUND(_, 2). Engine handles internally
  // when called via monthlySavingsEstimate.
  const daysToPayday = engineDaysUntilPayday(today, nextPaydayNominal);
  const remainingVariableSpendProrated = Math.max(
    0,
    Math.round(((daysToPayday) / monthLengthDays) * variableSpendCap * 100) / 100,
  );

  const forwardReserveAmount = engineForwardReserve(
    allActiveEngineBills,
    variableSpendCap,
    monthLengthDays,
  );

  // Engine's monthlySavingsEstimate handles the floor-at-zero formula.
  const estimatedMonthlySavings = monthlySavingsEstimate(
    baseNetIncome,
    confirmedCommission,
    includedEngineBills,
    nextPaydayNominal,
    today,
    engineOneTimes,
    quicksilverBalanceOwed, // treated as quicksilverAccrual line item
    allActiveEngineBills,
    variableSpendCap,
    monthLengthDays,
  );

  const totalMonthIncome = baseNetIncome + confirmedCommission;

  // 401(k) match gap — delegate to engine (FIX_PLAN §A2 corrected formula).
  const [ret] = await db.select().from(retirementPlan).limit(1);
  let matchGapActive = false;
  let monthlyMatchGapCost = 0;
  if (ret) {
    const mg = matchGapAnalysis(
      parseFloat(ret.grossSalary),
      parseFloat(ret.contributionRate),
      parseFloat(ret.employerMatchRate),
      parseFloat(ret.employerMatchCap),
    );
    matchGapActive = mg.annualGap > 0.01;
    monthlyMatchGapCost = Math.round(mg.monthlyGap * 100) / 100;
  }

  const savingsAfterMatchBump = Math.max(0, estimatedMonthlySavings - monthlyMatchGapCost);
  const canAffordMatchBump = savingsAfterMatchBump > 0;

  return {
    baseNetIncome,
    confirmedCommission,
    totalMonthIncome,
    fullMonthFixedBills,
    remainingVariableSpendProrated,
    knownOneTimeCosts,
    quicksilverAccrual,
    quicksilverBalanceOwed,
    forwardReserve: forwardReserveAmount,
    estimatedMonthlySavings,
    matchGapActive,
    monthlyMatchGapCost,
    savingsAfterMatchBump,
    canAffordMatchBump,
  };
}

// ---------------------------------------------------------------------------
// Commission tier helpers — re-export engine versions but keep API compatible
// (rounded to cents) since DB stores rounded values.
// ---------------------------------------------------------------------------

export function computeMrrPayout(mrrAchieved: number, mrrTarget = 700): number {
  return Math.round(mrrPayoutGross(mrrAchieved, mrrTarget) * 100) / 100;
}

export function computeNrrPayout(nrrAchieved: number, nrrTarget = 6000): number {
  return Math.round(nrrPayoutGross(nrrAchieved, nrrTarget) * 100) / 100;
}

export function computeTakeHome(grossPayout: number, taxRate = 0.435): number {
  return Math.round(grossPayout * (1 - taxRate) * 100) / 100;
}

export function computePayoutDate(salesMonthStr: string, payoutDay = 22): string {
  // Use the engine's commissionPayoutDate which handles December rollover.
  const sales = utcStartOfDay(new Date(salesMonthStr));
  const pd = commissionPayoutDate(sales, payoutDay);
  return pd.toISOString().split("T")[0]!;
}

// ---------------------------------------------------------------------------
// Scenario outputs — delegate to engine functions.
// ---------------------------------------------------------------------------

export function computeScenarioOutputs(
  type: string,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "vehicle") {
    const sticker = Number(inputs.sticker) || 0;
    const downPayment = Number(inputs.downPayment) || 0;
    const rate = Number(inputs.rate) || 0;
    const months = Number(inputs.months) || 60;
    const insurance = Number(inputs.insurance) || 0;
    const principal = sticker - downPayment;
    let monthly = 0;
    if (principal > 0 && months > 0) {
      monthly = rate > 0 ? pmt(rate, months, principal) : principal / months;
    }
    const totalCost = monthly * months + downPayment;
    const totalInterest = totalCost - sticker;
    const newMonthlyBurn = monthly + insurance;
    return {
      monthlyPayment: Math.round(monthly * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalInterest: Math.round(totalInterest * 100) / 100,
      newMonthlyBurn: Math.round(newMonthlyBurn * 100) / 100,
    };
  }

  if (type === "drought_survival") {
    const checking = Number(inputs.checking) || 0;
    const hysa = Number(inputs.hysa) || 0;
    const monthlyBurn = Number(inputs.monthlyBurn) || 0;
    // Engine droughtSurvivalRunway expects bills + cap + base; we have the
    // pre-computed burn. Compute runway directly using the engine's formula
    // shape so callers get totalLiquid + months + label.
    const r = droughtSurvivalRunway(checking, hysa, monthlyBurn, 0, 0);
    const runwayMonths = r.indefinite ? 0 : (r.runway_months ?? 0);
    return {
      totalLiquid: r.totalLiquid,
      runwayMonths,
      runwayLabel: `${Math.floor(runwayMonths)} months ${Math.round((runwayMonths % 1) * 30)} days`,
    };
  }

  if (type === "income_floor") {
    const targetSavings = Number(inputs.targetSavings) || 0;
    const fixedMonthly = Number(inputs.fixedMonthly) || 0;
    const variableCap = Number(inputs.variableCap) || 0;
    const taxRate = Number(inputs.taxRate) || 0.22;
    const [annualFloor] = incomeReplacementFloor(
      targetSavings,
      fixedMonthly,
      variableCap,
      taxRate,
    );
    const minMonthlyNet = targetSavings + fixedMonthly + variableCap;
    return {
      requiredMonthlyNet: Math.round(minMonthlyNet * 100) / 100,
      requiredAnnualGross: Math.round(annualFloor * 100) / 100,
    };
  }

  if (type === "income_change") {
    const currentBase = Number(inputs.currentBase) || 0;
    const newBase = Number(inputs.newBase) || 0;
    const taxRate = Number(inputs.taxRate) || 0.22;
    const r = incomeGrowthScenario(currentBase, newBase, taxRate, 0, 0, 0);
    const currentNet = (currentBase / 12) * (1 - taxRate);
    const newNet = (newBase / 12) * (1 - taxRate);
    return {
      currentMonthlyNet: Math.round(currentNet * 100) / 100,
      newMonthlyNet: Math.round(newNet * 100) / 100,
      monthlyIncrease: Math.round(r.monthly_net_increase * 100) / 100,
      annualIncrease: Math.round((newBase - currentBase) * (1 - taxRate) * 100) / 100,
    };
  }

  if (type === "purchase_compare") {
    const opts = Array.isArray(inputs.options) ? (inputs.options as Array<Record<string, unknown>>) : [];
    const purchaseOpts = opts.map(
      (o) =>
        new PurchaseOption(
          String(o.name ?? ""),
          Number(o.totalPrice ?? 0),
          Number(o.downPayment ?? 0),
          Number(o.annualRate ?? 0),
          Number(o.termMonths ?? 60),
          Number(o.monthlyAddons ?? 0),
          Number(o.oneTimeCost ?? 0),
        ),
    );
    return {
      results: decisionSandboxCompare(
        purchaseOpts,
        Number(inputs.currentDailySafeSpend) || 0,
        Number(inputs.monthlyFixedBills) || 0,
        Number(inputs.variableCap) || 600,
        Number(inputs.baseNetMonthly) || 3220,
        Number(inputs.hysaBalance) || 0,
      ),
    };
  }

  return {};
}

// Re-export engine commission helpers under their aliases so callers can switch
// to the central versions piecemeal.
export {
  mrrPayoutGross as computeMrrPayoutRaw,
  nrrPayoutGross as computeNrrPayoutRaw,
  commissionTakeHome as commissionTakeHomeRaw,
};
