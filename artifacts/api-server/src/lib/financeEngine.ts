import { db } from "@workspace/db";
import {
  assumptions,
  oneTimeExpenses,
  variableSpend,
  balances,
  commissions,
  retirementPlan,
  bills,
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
  billNextDueDate,
  discretionaryThisMonth as engineDiscretionaryThisMonth,
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
  quicksilverOwed: number;
  safeToSpend: number;
  safeToSpendPreFloor: number;
  overCommittedBy: number;
  dailyRateFromUpdate: number;
  dailyRateRealTime: number;
  daysOfCoverage: number | null;
  variableSpendUntilPayday: number;
  remainingDiscretionary: number;
  status: "GREEN" | "YELLOW" | "RED";
  paydayRisk: boolean;
  /**
   * Read-only label: of the bills already in `billsDueBeforePayday`, this is
   * the subset whose dueDay falls in [1, 7]. NOT a separate addend in
   * `totalRequiredHold` — the bills are already counted via the cycle window.
   */
  forwardReserve: number;
  /** Alias of `forwardReserve` (kept for API back-compat). */
  forwardReserveBillsTotal: number;
  /** v8.1 — sum of bills with paymentState='paid_pending_clear'. */
  pendingBillsOwed: number;
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
 * v8.0 Part 3 — exclude deferred one-time expenses from cycle math.
 * Pure helper exposed for unit tests; used by both computeCycleState and
 * computeMonthlySavings to map DB rows to engine-typed expenses.
 */
export interface OneTimeRow {
  description: string;
  amount: string;
  dueDate: string | null;
  paid: boolean;
  deferred: boolean;
}

export function selectActiveOneTimeExpenses(rows: OneTimeRow[]): EngineOneTimeExpense[] {
  return rows
    .filter((o) => !o.deferred)
    .map(
      (o) =>
        new EngineOneTimeExpense(
          o.description,
          parseFloat(o.amount),
          o.dueDate ? utcStartOfDay(new Date(o.dueDate)) : null,
          o.paid,
        ),
    );
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

/**
 * Single source of truth for Required Hold.
 *
 * ONE function computes everything that goes into the hold against checking.
 * `computeCycleState` and `integrity.runChecks` both call this — there is no
 * parallel implementation of cycle membership anywhere else in the codebase.
 *
 * Composition (every dollar counted exactly once):
 *
 *   totalRequiredHold =
 *       billsDueBeforePayday    // bills whose next due date ∈ [today, effectivePayday)
 *     + oneTimeDueBeforePayday  // unpaid, non-deferred one-times in same window
 *     + pendingHoldsReserve     // assumption row
 *     + minimumCushion          // assumption row
 *     + quicksilverOwed         // unpaid QS variable-spend rows
 *     + pendingBillsOwed        // bills marked paid_pending_clear
 *
 * Forward Reserve is NOT a separate addend. It is a READ-ONLY LABEL derived
 * from the bills already in `billsDueBeforePayday`: the subset whose dueDay
 * falls in [1, 7]. On payday-morning rollover days the cycle window straddles
 * the month boundary and naturally captures next month's first-week bills via
 * the bills-due term — adding them again as "forward reserve" was the v9 bug.
 */
export interface RequiredHoldBreakdown {
  today: Date;
  checkingBalance: number;
  lastBalanceUpdate: Date | null;
  daysSinceUpdate: number | null;
  isStale: boolean;
  nextPaydayNominal: Date;
  nextPayday: Date;
  daysUntilPayday: number;
  paydayRisk: boolean;

  billsDueBeforePayday: number;
  oneTimeDueBeforePayday: number;
  pendingHoldsReserve: number;
  minimumCushion: number;
  quicksilverOwed: number;
  pendingBillsOwed: number;
  totalRequiredHold: number;

  /**
   * Read-only label: of the bills already in `billsDueBeforePayday`, this is
   * the subset whose dueDay is 1..7. Surfaces as `cycle.forwardReserve` in the
   * API response for the dashboard's "Forward Reserve" breakdown row. Never
   * added to `totalRequiredHold` again.
   */
  forwardReserveLabel: number;

  safeToSpend: number;
  safeToSpendPreFloor: number;
  overCommittedBy: number;

  alertThreshold: number;
  variableSpendCap: number;
  monthLengthDays: number;
  variableSpendUntilPayday: number;
}

export async function computeRequiredHold(asOf?: Date): Promise<RequiredHoldBreakdown> {
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

  const today = utcStartOfDay(asOf ?? new Date());

  const daysSinceUpdate = lastBalanceUpdate
    ? engineDaysSinceUpdate(utcStartOfDay(lastBalanceUpdate), today)
    : null;
  const stale =
    daysSinceUpdate === null || isStale(utcStartOfDay(lastBalanceUpdate ?? today), today);

  // Payday-morning rollover: when today IS a nominal payday, [today, nextPayday)
  // is empty. Roll forward to the FOLLOWING payday so bills due 23rd-31st AND
  // bills due 1st-7th of next month all fall inside the rolled cycle window —
  // captured exactly once by `billsDueBeforePayday`.
  const rawNominal = deriveNextNominalPayday(today);
  const nextPaydayNominal =
    rawNominal.getTime() === today.getTime()
      ? deriveNextNominalPayday(new Date(today.getTime() + 86400000))
      : rawNominal;
  const nextPayday = engineEffectivePayday(nextPaydayNominal);
  const daysUntilPayday = engineDaysUntilPayday(today, nextPaydayNominal);
  const paydayRisk = paydayRiskFlag(nextPaydayNominal);

  // The hold is the UNION of two bill sets, deduplicated by bill id:
  //   A = bills whose next due date ∈ [today, effectivePayday(rolledNominal))
  //   B = always-hold forward reserve: bills with dueDay 1..7 (next month's
  //       first-week obligations, reserved every day regardless of cycle phase)
  //
  // Union-by-id is the keystone: on payday-morning days the rolled cycle window
  // already captures next-month day-1..7 bills via A, AND those same bills are
  // in B. Without the union we'd re-create the v9 double-count. With the union,
  // any bill that lands in both sets collapses to a single entry — counted once.
  //
  // paid_pending_clear bills are excluded from both subsets and held via
  // pendingBillsOwed instead. skipped_cycle is excluded entirely.
  const enriched = await enumerateBills(today, nextPaydayNominal);

  const cycleBills = enriched.filter(
    (b) => b.countsThisCycle && b.paymentState !== "paid_pending_clear",
  );
  // v9 Fix — Forward Reserve is dueDay-based: it holds the NEXT occurrence of
  // a recurring day-1..7 bill. The bill row's `paymentState` is a
  // per-occurrence flag that refers to the CURRENT period's instance. Marking
  // May's rent paid_pending_clear must not suppress June's rent from the
  // forward reserve. Only `skipped_cycle` (an explicit "exclude this cycle"
  // signal) is honored here.
  const forwardBills = enriched.filter(
    (b) =>
      b.isActivePeriod &&
      b.includeInCycle &&
      b.amount > 0 &&
      b.paymentState !== "skipped_cycle" &&
      b.dueDay >= 1 &&
      b.dueDay <= 7,
  );

  const billsInHoldMap = new Map<number, (typeof enriched)[number]>();
  for (const b of cycleBills) billsInHoldMap.set(b.id, b);
  for (const b of forwardBills) billsInHoldMap.set(b.id, b);
  const billsInHold = Array.from(billsInHoldMap.values());

  const billsDueBeforePayday = billsInHold.reduce((s, b) => s + b.amount, 0);

  // Forward Reserve LABEL: subset of bills already in the hold with dueDay 1-7.
  // Pure derived value — never summed back into totalRequiredHold.
  const forwardReserveLabel = billsInHold
    .filter((b) => b.dueDay >= 1 && b.dueDay <= 7)
    .reduce((s, b) => s + b.amount, 0);

  const pendingHoldsReserve = await getAssumption("pending_holds_reserve", 0);
  const minimumCushion = await getAssumption("minimum_cushion", 0);

  // One-time expenses due in cycle (engine: ≤ effective payday, inclusive).
  // Deferred items excluded from all cycle math (v8.0 Part 3).
  const allOneTime = await db.select().from(oneTimeExpenses);
  const engineOneTimes = selectActiveOneTimeExpenses(allOneTime);
  const oneTimeDueBeforePayday = oneTimeExpensesDueInCycle(
    engineOneTimes,
    today,
    nextPaydayNominal,
  );

  // QuickSilver settlement hold: every QS variable-spend row not yet paid off
  // is a dollar consumed but not yet debited.
  const allVarSpend = await db.select().from(variableSpend);
  const quicksilverOwed = allVarSpend
    .filter((v) => v.quicksilver && v.paidOffAt === null)
    .reduce((s, v) => s + parseFloat(v.amount), 0);

  // Pending Bill Payments hold: bills marked paid_pending_clear haven't
  // actually debited yet. v9 Fix — dedupe against `billsInHold`: now that
  // forwardBills no longer filters out paid_pending_clear, a recurring bill
  // already counted via the cycle/forward window would otherwise be held
  // twice. Bills outside the cycle/forward window (e.g. Electric dueDay=16
  // marked paid_pending_clear) continue to be held here, exactly as before.
  const allBillRows = await db.select().from(bills);
  const inHoldIds = new Set(billsInHold.map((b) => b.id));
  const pendingBillsOwed = allBillRows
    .filter(
      (b) =>
        b.paymentState === "paid_pending_clear" &&
        b.includeInCycle &&
        !inHoldIds.has(b.id),
    )
    .reduce((s, b) => s + parseFloat(b.amount), 0);

  const totalRequiredHold =
    billsDueBeforePayday +
    oneTimeDueBeforePayday +
    pendingHoldsReserve +
    minimumCushion +
    quicksilverOwed +
    pendingBillsOwed;

  const safeToSpendPreFloor = checkingBalance - totalRequiredHold;
  const safeToSpendValue = Math.max(0, safeToSpendPreFloor);
  const overCommittedBy = safeToSpendPreFloor < 0 ? -safeToSpendPreFloor : 0;

  const variableSpendUntilPayday = await getAssumption("variable_spend_until_payday", 0);

  return {
    today,
    checkingBalance,
    lastBalanceUpdate,
    daysSinceUpdate,
    isStale: stale,
    nextPaydayNominal,
    nextPayday,
    daysUntilPayday,
    paydayRisk,
    billsDueBeforePayday,
    oneTimeDueBeforePayday,
    pendingHoldsReserve,
    minimumCushion,
    quicksilverOwed,
    pendingBillsOwed,
    totalRequiredHold,
    forwardReserveLabel,
    safeToSpend: safeToSpendValue,
    safeToSpendPreFloor,
    overCommittedBy,
    alertThreshold,
    variableSpendCap,
    monthLengthDays,
    variableSpendUntilPayday,
  };
}

export async function computeCycleState(asOf?: Date): Promise<CycleState> {
  const hold = await computeRequiredHold(asOf);

  // engine.safeToSpend keeps its semantics — folded through the engine helper
  // so the floor + clamp behaviour stays identical to the reference engine.
  // Forward Reserve is no longer a separate addend; it's purely a label.
  const sts = safeToSpend(hold.checkingBalance, hold.billsDueBeforePayday, {
    pendingHolds: hold.pendingHoldsReserve + hold.quicksilverOwed + hold.pendingBillsOwed,
    minimumCushion: hold.minimumCushion,
    oneTimeDueTotal: hold.oneTimeDueBeforePayday,
    forwardReserveAmount: 0,
    includeForwardReserveInSts: false,
  });

  const lastUpdateDate = hold.lastBalanceUpdate
    ? utcStartOfDay(hold.lastBalanceUpdate)
    : hold.today;

  const dailyRateFromUpdate = dailyRateStatic(
    sts,
    hold.variableSpendUntilPayday,
    hold.nextPaydayNominal,
    lastUpdateDate,
  );

  const dailyRateRealTime = dailyRateRealtime(
    sts,
    hold.variableSpendUntilPayday,
    hold.nextPaydayNominal,
    hold.today,
  );

  const coverage = daysOfCoverage(sts, dailyRateFromUpdate);
  const remainingDiscretionary = Math.max(0, sts - hold.variableSpendUntilPayday);
  const status = cycleStatus(sts, hold.alertThreshold);

  return {
    checkingBalance: hold.checkingBalance,
    lastBalanceUpdate: hold.lastBalanceUpdate,
    nextPayday: hold.nextPayday,
    nextPaydayNominal: hold.nextPaydayNominal,
    daysSinceUpdate: hold.daysSinceUpdate,
    isStale: hold.isStale,
    daysUntilPayday: hold.daysUntilPayday,
    billsDueBeforePayday: hold.billsDueBeforePayday,
    pendingHoldsReserve: hold.pendingHoldsReserve,
    minimumCushion: hold.minimumCushion,
    oneTimeDueBeforePayday: hold.oneTimeDueBeforePayday,
    totalRequiredHold: hold.totalRequiredHold,
    quicksilverOwed: hold.quicksilverOwed,
    safeToSpend: sts,
    safeToSpendPreFloor: hold.safeToSpendPreFloor,
    overCommittedBy: hold.overCommittedBy,
    dailyRateFromUpdate,
    dailyRateRealTime,
    daysOfCoverage: coverage,
    variableSpendUntilPayday: hold.variableSpendUntilPayday,
    remainingDiscretionary,
    status,
    paydayRisk: hold.paydayRisk,
    forwardReserve: hold.forwardReserveLabel,
    forwardReserveBillsTotal: hold.forwardReserveLabel,
    pendingBillsOwed: hold.pendingBillsOwed,
    alertThreshold: hold.alertThreshold,
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

  // Build engine-typed bills/one-times for monthlySavingsEstimate.
  // Per Playbook §2.1 B62, fullMonthFixed (current-month instances) and
  // forwardReserve (next-month days 1-7 instances) are SEPARATE cash events
  // — both subtracted with no dedup. The Defect-1 cycle-bill exclusion is
  // intentionally NOT used here, otherwise B62 would overstate savings by
  // omitting the May 1-7 reservation.
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

  // v8.0 Part 3 — deferred items excluded from monthly savings ledger too.
  const allOneTimeRows = await db.select().from(oneTimeExpenses);
  const engineOneTimes = selectActiveOneTimeExpenses(allOneTimeRows);
  const knownOneTimeCosts = engineOneTimes
    .filter((o) => !o.paid)
    .reduce((s, o) => s + o.amount, 0);

  // QuickSilver accrual = sum of QS-tagged variable_spend log entries this
  // month. Per Playbook §2.1 B60, this is subtracted from Monthly Savings
  // Estimate as already-spent credit-card liability that must be paid from
  // checking — distinct from B58 (forward variable budget through payday).
  // The two are separate buckets and intentionally non-overlapping.
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

  // v9 — match dashboard engine: Forward Reserve = sum of include=TRUE
  // bills with dueDay 1..7 of next calendar month. No buffer. No window.
  void engineForwardReserve; // legacy helper, intentionally bypassed
  void allActiveEngineBills;
  const forwardReserveAmount = enriched
    .filter((b) => b.isActivePeriod && b.includeInCycle && b.amount > 0 && b.dueDay >= 1 && b.dueDay <= 7 && b.paymentState !== "skipped_cycle")
    .reduce((s, b) => s + b.amount, 0);

  // PLACEHOLDER (per user direction 2026-04-24): Monthly Savings Estimate is
  // expressed as Discretionary minus a fixed $100 buffer. Rationale: Monthly
  // Savings must always be ≤ Discretionary (both end at the same payday
  // boundary), and the $100 offset keeps it conservative. The full Playbook
  // §2.1 B62 formula is preserved in `monthlySavingsEstimate()` for tests
  // and tooling, but we don't wire it to the dashboard headline until the
  // income/instance accounting is reconciled.
  const [latestChecking] = await db
    .select()
    .from(balances)
    .where(eq(balances.accountType, "checking"))
    .orderBy(desc(balances.asOfDate))
    .limit(1);
  const checking = latestChecking
    ? parseFloat(latestChecking.amount as unknown as string)
    : 0;

  // Bills remaining in the current calendar month (Include=TRUE, due day in
  // [today, month_end]).
  const monthEndDay = new Date(
    today.getUTCFullYear(),
    today.getUTCMonth() + 1,
    0,
  ).getUTCDate();
  const todayDay = today.getUTCDate();
  const billsRemainingThisMonth = includedEngineBills
    .filter((b) => b.dueDay >= todayDay && b.dueDay <= monthEndDay)
    .reduce((s, b) => s + b.amount, 0);

  // Unpaid one-time expenses dated through month-end.
  const monthEndDate = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), monthEndDay),
  );
  const oneTimeDatedThisMonth = engineOneTimes
    .filter(
      (o) =>
        !o.paid &&
        o.dueDate !== null &&
        o.dueDate.getTime() >= today.getTime() &&
        o.dueDate.getTime() <= monthEndDate.getTime(),
    )
    .reduce((s, o) => s + o.amount, 0);

  const discretionary = engineDiscretionaryThisMonth(
    checking,
    billsRemainingThisMonth,
    oneTimeDatedThisMonth,
    quicksilverBalanceOwed,
    includedEngineBills,
    today,
    variableSpendCap,
    monthLengthDays,
  );
  const estimatedMonthlySavings = Math.max(0, discretionary - 100);

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
