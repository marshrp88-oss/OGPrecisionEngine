/**
 * engine.ts
 * =========
 * TypeScript port of marshall_finance_engine.py — the reference implementation
 * for "Reserve" (Marshall Finance), the personal financial operating system
 * replacing OG_Financial_Engine_7_2.xlsx.
 *
 * Every function is:
 *   - Pure (inputs -> output, no side effects)
 *   - Typed
 *   - Documented with the source cell or playbook section
 *   - Numerically equivalent to the Python reference (engine.test.ts must pass)
 *
 * SOURCE AUTHORITY (in descending precedence):
 *   1. FIX_PLAN.md  (most recent corrections — overrides all)
 *   2. OG_Financial_Engine_7_2.xlsx  (workbook formulas)
 *   3. Claude_Financial_Playbook_v7_3.docx  (methodology)
 *   4. BUILD_SPEC.md  (architecture)
 *
 * Conversion notes (Python -> TypeScript):
 *   - All dates use UTC midnight to avoid DST/timezone drift.
 *   - weekday() is Mon=0..Sun=6 (Python convention) — see `pyWeekday`.
 *   - Day arithmetic uses millisecond diff / 86_400_000 with Math.round to
 *     guard against floating point.
 *   - Rounding to N decimals uses Math.round(x * 10^N) / 10^N (NOT toFixed,
 *     which returns a string and rounds half-to-even).
 */

// ---------------------------------------------------------------------------
// 0. CONSTANTS  (Assumptions sheet — all values from B2:B15)
// ---------------------------------------------------------------------------

export const POSTING_CUSHION_DAYS = 1;
export const COMMISSION_TAX_RATE = 0.435;
export const MONTH_LENGTH_DAYS = 30.4;
export const COMMISSION_PAYOUT_DAY = 22;
export const MRR_TARGET = 700.0;
export const NRR_TARGET = 6000.0;
export const ALERT_THRESHOLD_YELLOW = 400.0;
export const VARIABLE_SPEND_CAP = 600.0;
export const BASE_NET_INCOME = 3220.0;
export const HYSA_TARGET = 15000.0;
export const RETIREMENT_RETURN = 0.07;
export const TAX_ANNUAL_RESERVE = 400.0;
export const SAVINGS_TO_HYSA_RATIO = 0.5;
export const INCLUDE_FORWARD_RESERVE_IN_STS = true;

// FIX_PLAN §A2 — corrected 401(k) match structure (replaces old B7/B8)
export const K401_MATCH_MULTIPLIER = 0.5;
export const K401_EMPLOYEE_CEILING = 0.08;
export const K401_CONTRIBUTION_PCT = 0.04;

export const GROSS_SALARY = 54000.0;
export const FED_TAX_RATE = 0.12;
export const STATE_TAX_RATE = 0.04;
export const PAY_PERIODS_PER_YEAR = 24;

export const DROUGHT_THRESHOLD = 50.0;
export const STALENESS_WARN_DAYS = 3;

// ---------------------------------------------------------------------------
// DATE HELPERS  (UTC-anchored to avoid timezone drift)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Construct a date at UTC midnight. Use this everywhere instead of `new Date()`
 * to keep day arithmetic exact across DST boundaries.
 */
export function d(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/** Days in `month` of `year` (month is 1-indexed). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Python-style weekday: Mon=0..Sun=6. */
function pyWeekday(date: Date): number {
  // JS getUTCDay: Sun=0..Sat=6  ->  Python: Mon=0..Sun=6
  return (date.getUTCDay() + 6) % 7;
}

/** Whole-day difference `a - b` (signed). */
function dayDiff(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

/** Replace day-of-month, keeping year/month. */
function withDay(date: Date, day: number): Date {
  return d(date.getUTCFullYear(), date.getUTCMonth() + 1, day);
}

/** Subtract N days. */
function minusDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * MS_PER_DAY);
}

/** Compare two dates by day (ignores time component since we only use UTC midnight). */
function dateEq(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

/** Round to N decimal places (NOT toFixed). */
export function roundTo(x: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(x * factor) / factor;
}

// ---------------------------------------------------------------------------
// 1. DATA CLASSES (positional constructors mirror Python dataclass call sites)
// ---------------------------------------------------------------------------

export class Bill {
  constructor(
    public name: string,
    public amount: number,
    public dueDay: number,
    public include: boolean,
    public category: string = "",
    public autopay: boolean = true,
    public notes: string = "",
  ) {}
}

export class OneTimeExpense {
  constructor(
    public name: string,
    public amount: number,
    public dueDate: Date | null,
    public paid: boolean = false,
  ) {}
}

export class CommissionRow {
  constructor(
    public salesMonth: Date,
    public mrrAchieved: number,
    public nrrAchieved: number,
  ) {}
}

export class VariableSpendEntry {
  constructor(
    public weekStart: Date,
    public amount: number,
    public cardAccrual: number = 0.0,
  ) {}
}

export class PurchaseOption {
  constructor(
    public name: string,
    public totalPrice: number,
    public downPayment: number = 0.0,
    public annualRate: number = 0.0,
    public termMonths: number = 60,
    public monthlyAddons: number = 0.0,
    public oneTimeCost: number = 0.0,
  ) {}
}

export class IntegrityCheckResult {
  constructor(
    public checkNumber: number,
    public description: string,
    public passed: boolean,
    public detail: string = "",
  ) {}
}

// ---------------------------------------------------------------------------
// 2. DATE UTILITIES
// ---------------------------------------------------------------------------

/**
 * Weekend-adjust a nominal payday to the prior Friday.
 * Source: Dashboard!B26 / BUILD_SPEC §4.7 / FIX_PLAN §B6
 */
export function effectivePayday(nominal: Date): Date {
  const dow = pyWeekday(nominal); // 0=Mon..5=Sat,6=Sun
  if (dow === 5) return minusDays(nominal, 1); // Sat -> Fri
  if (dow === 6) return minusDays(nominal, 2); // Sun -> Fri
  return nominal;
}

/**
 * Return the next nominal payday date (before weekend adjustment).
 * Pay schedule is semi-monthly on the 7th and 22nd by default.
 * Source: BUILD_SPEC §4.1
 */
export function nextNominalPayday(today: Date, payDays: number[] = [7, 22]): Date {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const candidates: Date[] = [];
  const lastDom = daysInMonth(y, m);
  for (const day of payDays) {
    const dd = Math.min(day, lastDom);
    const cand = d(y, m, dd);
    if (cand.getTime() >= today.getTime()) candidates.push(cand);
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.getTime() - b.getTime());
    return candidates[0]!;
  }
  // All paydays this month have passed — advance to next month
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const nmLast = daysInMonth(ny, nm);
  return d(ny, nm, Math.min(payDays[0]!, nmLast));
}

/**
 * Days remaining until the effective payday. Floor at 0 (never negative).
 * Source: FIX_PLAN §B5 — off-by-one fix.
 */
export function daysUntilPayday(today: Date, nextPaydayNominal: Date): number {
  const eff = effectivePayday(nextPaydayNominal);
  const delta = dayDiff(eff, today);
  return Math.max(0, delta);
}

/**
 * Compute next due date for a bill — Bills!Column D formula.
 * Source: Bills!D2:D13 / Playbook §1.1
 */
export function billNextDueDate(
  today: Date,
  dueDay: number | null | undefined,
  include: boolean,
): Date | null {
  if (!include || dueDay == null) return null;
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const lastDom = daysInMonth(y, m);
  const clamped = Math.min(dueDay, lastDom);
  const candidate = d(y, m, clamped);
  if (candidate.getTime() >= today.getTime()) return candidate;
  // Roll to next month
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const nmLast = daysInMonth(ny, nm);
  return d(ny, nm, Math.min(dueDay, nmLast));
}

/**
 * Payout date for a given sales month: the 22nd of the following month.
 * Source: Commissions!H11
 */
export function commissionPayoutDate(
  salesMonth: Date,
  payoutDay: number = COMMISSION_PAYOUT_DAY,
): Date {
  const y = salesMonth.getUTCFullYear();
  const m = salesMonth.getUTCMonth() + 1;
  if (m === 12) return d(y + 1, 1, payoutDay);
  return d(y, m + 1, payoutDay);
}

/** Days since the checking balance was last updated. Source: Dashboard!B8 */
export function daysSinceUpdate(lastUpdate: Date, today: Date): number {
  return dayDiff(today, lastUpdate);
}

// ---------------------------------------------------------------------------
// 3. FINANCIAL MATH UTILITIES
// ---------------------------------------------------------------------------

/**
 * Monthly loan payment — Excel PMT(rate/12, term, -principal).
 * PMT(r, n, pv) = pv * r / (1 - (1+r)^-n)
 * Source: Decision Sandbox!B21, Debt Strategy!B19
 */
export function pmt(annualRate: number, termMonths: number, principal: number): number {
  if (annualRate === 0) {
    return termMonths > 0 ? principal / termMonths : 0.0;
  }
  const r = annualRate / 12;
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths));
}

/**
 * Future value — Excel FV(rate, nper, pmt, pv) but with positive sign convention.
 * FV = pv * (1+r)^n + pmt * ((1+r)^n - 1) / r
 * Source: Retirement Planning!B35/B36/B39/B40 and Decision Sandbox!B26
 */
export function fv(annualRate: number, periods: number, payment: number, pv: number): number {
  if (annualRate === 0) return pv + payment * periods;
  const r = annualRate;
  const growth = Math.pow(1 + r, periods);
  return pv * growth + (payment * (growth - 1)) / r;
}

/**
 * Future value with annual contributions and annual compounding.
 * Used for retirement projections.
 * Source: Retirement Planning!B35
 */
export function fvAnnual(
  annualRate: number,
  years: number,
  annualPayment: number,
  pv: number,
): number {
  return fv(annualRate, years, annualPayment, pv);
}

// ---------------------------------------------------------------------------
// 4. COMMISSION ENGINE
// ---------------------------------------------------------------------------

/**
 * MRR gross payout — 4-tier piecewise.
 * Source: Commissions!D11 / FIX_PLAN §B1 / BUILD_SPEC §5.3
 */
export function mrrPayoutGross(mrr: number, mrrTarget: number = MRR_TARGET): number {
  if (mrr <= 0) return 0.0;
  const tier1Cap = 349.93;
  const tier2Cap = 489.93;
  const tier3Cap = mrrTarget - 0.07; // = 699.93 when target = 700

  const tier1 = Math.max(0.0, Math.min(mrr, tier1Cap)) * 0.3705;
  const tier2 = Math.max(0.0, Math.min(mrr, tier2Cap) - tier1Cap) * 0.9634;
  const tier3 = Math.max(0.0, Math.min(mrr, tier3Cap) - tier2Cap) * 5.5212;
  const tier4 = Math.max(0.0, mrr - tier3Cap) * 0.65;
  return tier1 + tier2 + tier3 + tier4;
}

/**
 * NRR gross payout — 4-tier piecewise.
 * Source: Commissions!E11 / FIX_PLAN §B1 / BUILD_SPEC §5.3
 */
export function nrrPayoutGross(nrr: number, nrrTarget: number = NRR_TARGET): number {
  if (nrr <= 0) return 0.0;
  const tier1Cap = 2999.4;
  const tier2Cap = 4199.4;
  const tier3Cap = nrrTarget - 0.6; // = 5999.40 when target = 6000

  const tier1 = Math.max(0.0, Math.min(nrr, tier1Cap)) * 0.0204;
  const tier2 = Math.max(0.0, Math.min(nrr, tier2Cap) - tier1Cap) * 0.0388;
  const tier3 = Math.max(0.0, Math.min(nrr, tier3Cap) - tier2Cap) * 0.2801;
  const tier4 = Math.max(0.0, nrr - tier3Cap) * 0.042;
  return tier1 + tier2 + tier3 + tier4;
}

/**
 * Take-home commission after estimated tax withholding.
 * Source: Commissions!G11
 */
export function commissionTakeHome(
  mrr: number,
  nrr: number,
  mrrTarget: number = MRR_TARGET,
  nrrTarget: number = NRR_TARGET,
  taxRate: number = COMMISSION_TAX_RATE,
): number {
  const gross = mrrPayoutGross(mrr, mrrTarget) + nrrPayoutGross(nrr, nrrTarget);
  return gross * (1.0 - taxRate);
}

/**
 * Commission take-home confirmed for the current month.
 * Source: Dashboard!B55
 */
export function confirmedCommissionThisMonth(
  commissions: CommissionRow[],
  today: Date,
  mrrTarget: number = MRR_TARGET,
  nrrTarget: number = NRR_TARGET,
  taxRate: number = COMMISSION_TAX_RATE,
  payoutDay: number = COMMISSION_PAYOUT_DAY,
): number {
  const targetPayout = d(today.getUTCFullYear(), today.getUTCMonth() + 1, payoutDay);
  for (const row of commissions) {
    const pd = commissionPayoutDate(row.salesMonth, payoutDay);
    if (dateEq(pd, targetPayout) && pd.getTime() <= today.getTime()) {
      return commissionTakeHome(row.mrrAchieved, row.nrrAchieved, mrrTarget, nrrTarget, taxRate);
    }
  }
  return 0.0;
}

/**
 * Drought flag — true if the most recent N consecutive commission months all
 * had take-home below the drought threshold.
 * Source: Commissions!B26 / Playbook §1.4 / BUILD_SPEC §6.1
 */
export function droughtFlag(
  commissions: CommissionRow[],
  threshold: number = DROUGHT_THRESHOLD,
  mrrTarget: number = MRR_TARGET,
  nrrTarget: number = NRR_TARGET,
  taxRate: number = COMMISSION_TAX_RATE,
  consecutiveMonths: number = 2,
): boolean {
  if (commissions.length === 0) return false;
  const sorted = [...commissions].sort((a, b) => a.salesMonth.getTime() - b.salesMonth.getTime());
  const recent = sorted.slice(-consecutiveMonths);
  if (recent.length < consecutiveMonths) return false;
  return recent.every(
    (r) =>
      commissionTakeHome(r.mrrAchieved, r.nrrAchieved, mrrTarget, nrrTarget, taxRate) < threshold,
  );
}

// ---------------------------------------------------------------------------
// 5. BILLS ENGINE
// ---------------------------------------------------------------------------

/**
 * Filter bills that count in the current cycle hold.
 * CRITICAL: strict next_due < effective_payday (bills due ON payday excluded).
 * Source: Bills!H2:H13 / Playbook §1.1 / BUILD_SPEC §4.4 / FIX_PLAN §B2
 */
export function billsInCurrentCycle(
  bills: Bill[],
  today: Date,
  nextPaydayNominal: Date,
): Array<[Bill, Date]> {
  const effectiveNext = effectivePayday(nextPaydayNominal);
  const result: Array<[Bill, Date]> = [];
  for (const bill of bills) {
    if (!bill.include) continue;
    if (bill.amount <= 0) continue;
    const nextDue = billNextDueDate(today, bill.dueDay, bill.include);
    if (nextDue === null) continue;
    if (nextDue.getTime() >= today.getTime() && nextDue.getTime() < effectiveNext.getTime()) {
      result.push([bill, nextDue]);
    }
  }
  return result;
}

/**
 * Forward Reserve: bills due 1st-7th of next month (Include=TRUE) plus 7 days
 * of prorated variable spend. Uses due_day, NOT computed next_due_date.
 * Source: Dashboard!B33 / Playbook §2.1 / BUILD_SPEC §4.3 / FIX_PLAN §B4
 */
export function forwardReserve(
  bills: Bill[],
  variableCap: number = VARIABLE_SPEND_CAP,
  monthLengthDays: number = MONTH_LENGTH_DAYS,
): number {
  let bills1To7 = 0.0;
  for (const b of bills) {
    if (b.include && b.dueDay >= 1 && b.dueDay <= 7) bills1To7 += b.amount;
  }
  const dailyVariable = variableCap / monthLengthDays;
  return bills1To7 + 7.0 * dailyVariable;
}

/**
 * Total Required Hold — sum of all reserves against checking.
 * NOTE: Forward Reserve (B33) is NOT included.
 * Source: Dashboard!B16
 */
export function requiredHold(
  billsDueTotal: number,
  pendingHolds: number = 0.0,
  minimumCushion: number = 0.0,
  checkingFloor: number = 0.0,
  irregularBuffer: number = 0.0,
  timingBuffer: number = 0.0,
  oneTimeDueTotal: number = 0.0,
): number {
  return (
    billsDueTotal +
    pendingHolds +
    minimumCushion +
    checkingFloor +
    irregularBuffer +
    timingBuffer +
    oneTimeDueTotal
  );
}

/**
 * Sum of one-time expenses with due dates falling in the current cycle.
 * Upper bound is <= effective payday (inclusive, unlike bills which are <).
 * Source: Dashboard!B40 / BUILD_SPEC §4.5
 */
export function oneTimeExpensesDueInCycle(
  expenses: OneTimeExpense[],
  today: Date,
  nextPaydayNominal: Date,
): number {
  const effectiveNext = effectivePayday(nextPaydayNominal);
  let total = 0.0;
  for (const e of expenses) {
    if (
      !e.paid &&
      e.dueDate !== null &&
      e.dueDate.getTime() >= today.getTime() &&
      e.dueDate.getTime() <= effectiveNext.getTime()
    ) {
      total += e.amount;
    }
  }
  return total;
}

/**
 * Sum of ALL unpaid one-time expenses regardless of due date.
 * Source: Dashboard!B59
 */
export function knownOneTimeAll(expenses: OneTimeExpense[]): number {
  let total = 0.0;
  for (const e of expenses) if (!e.paid) total += e.amount;
  return total;
}

// ---------------------------------------------------------------------------
// 6. CYCLE DECISION OUTPUTS
// ---------------------------------------------------------------------------

export interface SafeToSpendOpts {
  pendingHolds?: number;
  minimumCushion?: number;
  checkingFloor?: number;
  irregularBuffer?: number;
  timingBuffer?: number;
  oneTimeDueTotal?: number;
  forwardReserveAmount?: number;
  includeForwardReserveInSts?: boolean;
}

/**
 * Safe to Spend — primary cycle decision output.
 * CRITICAL: safe_to_spend NEVER calls forward_reserve. They answer different
 * questions (this cycle's spend vs end-of-cycle savings).
 * Source: Dashboard!B19 / Playbook §1.2 / BUILD_SPEC §4.4 / FIX_PLAN §B2
 */
export function safeToSpend(
  checkingBalance: number,
  billsDueTotal: number,
  opts: SafeToSpendOpts = {},
): number {
  const {
    pendingHolds = 0.0,
    minimumCushion = 0.0,
    checkingFloor = 0.0,
    irregularBuffer = 0.0,
    timingBuffer = 0.0,
    oneTimeDueTotal = 0.0,
    forwardReserveAmount = 0.0,
    includeForwardReserveInSts = INCLUDE_FORWARD_RESERVE_IN_STS,
  } = opts;
  const hold = requiredHold(
    billsDueTotal,
    pendingHolds,
    minimumCushion,
    checkingFloor,
    irregularBuffer,
    timingBuffer,
    oneTimeDueTotal,
  );
  const effectiveHold = includeForwardReserveInSts ? hold : hold - forwardReserveAmount;
  return Math.max(0.0, checkingBalance - effectiveHold);
}

/**
 * Daily Rate (From Last Update) — static rate anchored to balance update date.
 * Returns 0 if payday already arrived (B4 <= B5).
 * Source: Dashboard!B21
 */
export function dailyRateStatic(
  safeToSpendAmount: number,
  variableSpendUntilPayday: number,
  nextPaydayNominal: Date,
  lastBalanceUpdate: Date,
): number {
  const eff = effectivePayday(nextPaydayNominal);
  const days = dayDiff(eff, lastBalanceUpdate);
  if (days <= 0) return 0.0;
  return Math.max(0.0, (safeToSpendAmount - variableSpendUntilPayday) / days);
}

/**
 * Daily Rate (Real-Time) — tightens daily as payday approaches.
 * Source: Dashboard!B22
 */
export function dailyRateRealtime(
  safeToSpendAmount: number,
  variableSpendUntilPayday: number,
  nextPaydayNominal: Date,
  today: Date,
): number {
  const eff = effectivePayday(nextPaydayNominal);
  const days = dayDiff(eff, today);
  if (days <= 0) return 0.0;
  return Math.max(0.0, (safeToSpendAmount - variableSpendUntilPayday) / days);
}

/**
 * Days of coverage at the current daily rate.
 * Returns null when daily rate is 0 (no meaningful coverage figure).
 * Source: Dashboard!B23
 */
export function daysOfCoverage(safeToSpendAmount: number, dailyRate: number): number | null {
  if (dailyRate === 0) return null;
  return safeToSpendAmount / dailyRate;
}

export const CycleStatus = {
  RED: "RED",
  YELLOW: "YELLOW",
  GREEN: "GREEN",
} as const;
export type CycleStatus = (typeof CycleStatus)[keyof typeof CycleStatus];

/**
 * RED / YELLOW / GREEN cycle status.
 *   RED:    safeToSpend <= 0
 *   YELLOW: 0 < safeToSpend < threshold
 *   GREEN:  safeToSpend >= threshold
 * Source: Dashboard!B27 / Assumptions!B8 / BUILD_SPEC §4.10
 */
export function cycleStatus(
  safeToSpendAmount: number,
  yellowThreshold: number = ALERT_THRESHOLD_YELLOW,
): CycleStatus {
  if (safeToSpendAmount <= 0) return CycleStatus.RED;
  if (safeToSpendAmount < yellowThreshold) return CycleStatus.YELLOW;
  return CycleStatus.GREEN;
}

// ---------------------------------------------------------------------------
// 7. MONTHLY SAVINGS ESTIMATE  (Dashboard B62 — master output)
// ---------------------------------------------------------------------------

/**
 * Estimated Monthly Savings — forward-looking cycle savings floor.
 * = MAX(0, total_income - fixed - variable_prorated - one_time - qs - forward_reserve)
 * Source: Dashboard!B56-B62 / Playbook §2.1 / BUILD_SPEC §5.4 / FIX_PLAN §B3
 */
export function monthlySavingsEstimate(
  baseNetMonthly: number,
  confirmedCommission: number,
  includedBills: Bill[],
  nextPaydayNominal: Date,
  today: Date,
  oneTimeExpenses: OneTimeExpense[],
  quicksilverAccrual: number,
  billsForReserve: Bill[],
  variableCap: number = VARIABLE_SPEND_CAP,
  monthLengthDays: number = MONTH_LENGTH_DAYS,
): number {
  const totalMonthIncome = baseNetMonthly + confirmedCommission;

  // B57 — SUMIFS(Bills!B, Bills!F, TRUE)
  let fullMonthFixed = 0.0;
  for (const b of includedBills) if (b.include) fullMonthFixed += b.amount;

  // B58 — ROUND(((days_to_payday) / 30.4) * variable_cap, 2)
  const daysToPayday = dayDiff(effectivePayday(nextPaydayNominal), today);
  const remainingVariableProrated = roundTo(
    Math.max(0.0, (daysToPayday / monthLengthDays) * variableCap),
    2,
  );

  // B59 — sum of all unpaid one-time expenses
  const knownOneTime = knownOneTimeAll(oneTimeExpenses);

  // B60 — QuickSilver accrual
  const qsAccrual = quicksilverAccrual;

  // B61 = B33 — forward reserve
  const fwdReserve = forwardReserve(billsForReserve, variableCap, monthLengthDays);

  const result =
    totalMonthIncome -
    fullMonthFixed -
    remainingVariableProrated -
    knownOneTime -
    qsAccrual -
    fwdReserve;
  return Math.max(0.0, result);
}

/**
 * Discretionary This Month — end-of-month deployable surplus from current
 * checking, after funding every known outflow between today and the first
 * paycheck of the following month.
 *
 * Answers: "How much cash can I save, invest, or spend on non-obligated
 *           purchases this month after every known obligation is funded?"
 *
 * Distinct from safeToSpend (current-cycle spending authority — no forward
 * reserve, paycheck-bounded) and from monthlySavingsEstimate (full-month
 * income/outflow ledger, paycheck-boundary). Discretionary is checking-only
 * and explicitly subtracts forwardReserve per Playbook §2.1.
 *
 * Formula:
 *   MAX(0,
 *     checking
 *     - unpaid_fixed_bills_remaining_this_month
 *     - prorated_variable_remaining_this_month
 *     - unpaid_one_time_expenses_remaining_this_month
 *     - quicksilver_accrual_not_yet_posted
 *     - forward_reserve(billsForReserve)
 *   )
 *
 *   prorated_variable = days_remaining_in_month * (variable_cap / month_length_days)
 *     where days_remaining_in_month = (lastDayOfMonth - today + 1), inclusive
 *     of today and inclusive of the last day.
 *
 * Source: Playbook §2.1 (Forward Reserve Rule) / Cycle Dashboard headline.
 */
export function discretionaryThisMonth(
  checkingBalance: number,
  unpaidFixedBillsRemainingThisMonth: number,
  unpaidOneTimeExpensesRemainingThisMonth: number,
  quicksilverAccrualNotYetPosted: number,
  billsForReserve: Bill[],
  today: Date,
  variableCap: number = VARIABLE_SPEND_CAP,
  monthLengthDays: number = MONTH_LENGTH_DAYS,
): number {
  const year = today.getUTCFullYear();
  const monthIdx = today.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  const todayDay = today.getUTCDate();
  const daysRemaining = Math.max(0, lastDay - todayDay + 1);
  const proratedVariableRemaining = daysRemaining * (variableCap / monthLengthDays);
  const fwdReserve = forwardReserve(billsForReserve, variableCap, monthLengthDays);
  const result =
    checkingBalance -
    unpaidFixedBillsRemainingThisMonth -
    proratedVariableRemaining -
    unpaidOneTimeExpensesRemainingThisMonth -
    quicksilverAccrualNotYetPosted -
    fwdReserve;
  return Math.max(0.0, result);
}

// ---------------------------------------------------------------------------
// 8. 401(K) MATCH GAP  (FIX_PLAN §A2 — corrected formula)
// ---------------------------------------------------------------------------

export interface MatchGapResult {
  effectiveEmployeePct: number;
  employerMatchPct: number;
  maxPossibleMatchPct: number;
  matchGapPct: number;
  annualCaptured: number;
  annualAvailable: number;
  annualGap: number;
  monthlyGap: number;
  atCeiling: boolean;
}

/**
 * 401(k) match gap using the CORRECTED formula from FIX_PLAN §A2.
 * Verified values @ gross $54k, contribution 4%, multiplier 0.50, ceiling 0.08:
 *   annual_gap = $1,080/yr, monthly_gap = $90/mo
 * Source: FIX_PLAN §A2
 */
export function matchGapAnalysis(
  grossSalary: number = GROSS_SALARY,
  contributionPct: number = K401_CONTRIBUTION_PCT,
  matchMultiplier: number = K401_MATCH_MULTIPLIER,
  employeeCeiling: number = K401_EMPLOYEE_CEILING,
): MatchGapResult {
  const effectiveEmployee = Math.min(contributionPct, employeeCeiling);
  const employerMatchPct = effectiveEmployee * matchMultiplier;
  const maxPossibleMatch = employeeCeiling * matchMultiplier;
  const matchGapPct = maxPossibleMatch - employerMatchPct;

  const annualCaptured = grossSalary * employerMatchPct;
  const annualAvailable = grossSalary * maxPossibleMatch;
  const annualGap = annualAvailable - annualCaptured;
  const monthlyGap = annualGap / 12.0;

  return {
    effectiveEmployeePct: effectiveEmployee,
    employerMatchPct,
    maxPossibleMatchPct: maxPossibleMatch,
    matchGapPct,
    annualCaptured,
    annualAvailable,
    annualGap,
    monthlyGap,
    atCeiling: contributionPct >= employeeCeiling,
  };
}

// ---------------------------------------------------------------------------
// 9. SESSION INTEGRITY CHECK  (Assumptions D20:D29 -> D31)
// ---------------------------------------------------------------------------

export interface SessionIntegrityReport {
  checks: IntegrityCheckResult[];
  overallPass: boolean;
  failCount: number;
  statusText: string;
}

export interface SessionIntegrityArgs {
  baseNetMonthly: number;
  nextPaydayNominal: Date;
  today: Date;
  lastBalanceUpdate: Date;
  bills: Bill[];
  forwardReserveAmount: number;
  commissionTaxRate: number;
  variableSpendCap: number;
  monthlySavings: number;
  matchGapResult: MatchGapResult | null;
}

/**
 * 10-point session integrity check. Any failure = investigate before proceeding.
 * Source: Assumptions!D20:D29, D31 / Playbook §1.3 / BUILD_SPEC §4.9
 */
export function sessionIntegrityCheck(args: SessionIntegrityArgs): SessionIntegrityReport {
  const {
    baseNetMonthly,
    nextPaydayNominal,
    today,
    lastBalanceUpdate,
    bills,
    forwardReserveAmount,
    commissionTaxRate,
    variableSpendCap,
    monthlySavings,
    matchGapResult,
  } = args;

  const checks: IntegrityCheckResult[] = [];

  checks.push(
    new IntegrityCheckResult(
      1,
      "Base net income set and positive",
      baseNetMonthly > 0,
      `baseNetMonthly=${baseNetMonthly}`,
    ),
  );

  const eff = effectivePayday(nextPaydayNominal);
  checks.push(
    new IntegrityCheckResult(
      2,
      "Next effective payday is in the future",
      eff.getTime() > today.getTime(),
      `effectivePayday=${eff.toISOString().slice(0, 10)}, today=${today.toISOString().slice(0, 10)}`,
    ),
  );

  const staleness = daysSinceUpdate(lastBalanceUpdate, today);
  checks.push(
    new IntegrityCheckResult(
      3,
      `Balance update <= ${STALENESS_WARN_DAYS} days old`,
      staleness <= STALENESS_WARN_DAYS,
      `daysSinceUpdate=${staleness}`,
    ),
  );

  const activeBillCount = bills.filter((b) => b.include).length;
  checks.push(
    new IntegrityCheckResult(
      4,
      "At least one bill is Include=TRUE",
      activeBillCount > 0,
      `activeBills=${activeBillCount}`,
    ),
  );

  checks.push(
    new IntegrityCheckResult(
      5,
      "Forward reserve is non-negative",
      forwardReserveAmount >= 0,
      `forwardReserve=${forwardReserveAmount.toFixed(2)}`,
    ),
  );

  checks.push(
    new IntegrityCheckResult(
      6,
      "Commission tax rate is configured",
      commissionTaxRate > 0 && commissionTaxRate < 1,
      `commissionTaxRate=${commissionTaxRate}`,
    ),
  );

  checks.push(
    new IntegrityCheckResult(
      7,
      "Variable spend cap is configured",
      variableSpendCap > 0,
      `variableSpendCap=${variableSpendCap}`,
    ),
  );

  const savingsValid =
    monthlySavings !== null &&
    monthlySavings !== undefined &&
    !Number.isNaN(monthlySavings) &&
    Number.isFinite(monthlySavings);
  checks.push(
    new IntegrityCheckResult(
      8,
      "Monthly savings estimate is a valid number",
      savingsValid,
      `monthlySavings=${monthlySavings}`,
    ),
  );

  const matchGapOk = matchGapResult !== null && !Number.isNaN(matchGapResult.annualGap);
  checks.push(
    new IntegrityCheckResult(
      9,
      "401(k) match gap computed successfully",
      matchGapOk,
      `annualGap=${matchGapResult ? matchGapResult.annualGap : "None"}`,
    ),
  );

  const negativeBills = bills.filter((b) => b.amount < 0).map((b) => b.name);
  checks.push(
    new IntegrityCheckResult(
      10,
      "No bill has a negative amount",
      negativeBills.length === 0,
      `negativeBills=${JSON.stringify(negativeBills)}`,
    ),
  );

  const failCount = checks.filter((c) => !c.passed).length;
  const overallPass = failCount === 0;
  return {
    checks,
    overallPass,
    failCount,
    statusText: overallPass ? "ALL 10 CHECKS PASS" : `${failCount} CHECK(S) FAILED`,
  };
}

// ---------------------------------------------------------------------------
// 10. FORWARD PROJECTION  (2-cycle cash flow)
// ---------------------------------------------------------------------------

export interface ProjectionCycle {
  cycleLabel: string;
  paydayDate: Date;
  baseIncome: number;
  expectedCommission: number;
  totalIncome: number;
  fixedBills: number;
  variableEstimate: number;
  forwardReserveOut: number;
  estimatedSavings: number;
  projectedChecking: number;
}

export interface ForwardProjectionArgs {
  currentChecking: number;
  bills: Bill[];
  today: Date;
  nextPaydayNominal: Date;
  commissions: CommissionRow[];
  baseNetMonthly?: number;
  variableCap?: number;
  monthLengthDays?: number;
  mrrTarget?: number;
  nrrTarget?: number;
  taxRate?: number;
  payoutDay?: number;
  cycles?: number;
}

/**
 * Multi-cycle forward cash flow projection.
 * Source: BUILD_SPEC §5.2 / FIX_PLAN §B3
 */
export function forwardProjection(args: ForwardProjectionArgs): ProjectionCycle[] {
  const {
    currentChecking,
    bills,
    nextPaydayNominal,
    commissions,
    baseNetMonthly = BASE_NET_INCOME,
    variableCap = VARIABLE_SPEND_CAP,
    monthLengthDays = MONTH_LENGTH_DAYS,
    mrrTarget = MRR_TARGET,
    nrrTarget = NRR_TARGET,
    taxRate = COMMISSION_TAX_RATE,
    payoutDay = COMMISSION_PAYOUT_DAY,
    cycles = 2,
  } = args;

  const result: ProjectionCycle[] = [];
  const paydays: Date[] = [effectivePayday(nextPaydayNominal)];
  let nominal = nextPaydayNominal;
  for (let i = 0; i < cycles - 1; i++) {
    const day = nominal.getUTCDate();
    if (day === 7) {
      nominal = withDay(nominal, 22);
    } else {
      const m = nominal.getUTCMonth() + 1;
      const y = nominal.getUTCFullYear();
      nominal = m === 12 ? d(y + 1, 1, 7) : d(y, m + 1, 7);
    }
    paydays.push(effectivePayday(nominal));
  }

  let runningChecking = currentChecking;

  for (let i = 0; i < paydays.length; i++) {
    const payday = paydays[i]!;
    const label = `Cycle ${i + 1}: payday ${payday.toISOString().slice(0, 10)}`;
    const targetPayout = d(payday.getUTCFullYear(), payday.getUTCMonth() + 1, payoutDay);

    let expectedCommission = 0.0;
    for (const row of commissions) {
      const pd = commissionPayoutDate(row.salesMonth, payoutDay);
      if (dateEq(pd, targetPayout) && pd.getTime() <= payday.getTime()) {
        expectedCommission = commissionTakeHome(
          row.mrrAchieved,
          row.nrrAchieved,
          mrrTarget,
          nrrTarget,
          taxRate,
        );
      }
    }

    const totalIncome = baseNetMonthly / 2.0 + expectedCommission;
    let includedSum = 0.0;
    for (const b of bills) if (b.include) includedSum += b.amount;
    const fixedHalf = includedSum / 2.0;
    const variableEst = variableCap / 2.0;
    const fwdRes = forwardReserve(bills, variableCap, monthLengthDays);

    const estSavings = Math.max(0.0, totalIncome - fixedHalf - variableEst);
    runningChecking = runningChecking + totalIncome - fixedHalf - variableEst;

    result.push({
      cycleLabel: label,
      paydayDate: payday,
      baseIncome: baseNetMonthly / 2.0,
      expectedCommission,
      totalIncome,
      fixedBills: fixedHalf,
      variableEstimate: variableEst,
      forwardReserveOut: fwdRes,
      estimatedSavings: estSavings,
      projectedChecking: runningChecking,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// 11. DECISION SANDBOX
// ---------------------------------------------------------------------------

export interface PurchaseComparisonResult {
  name: string;
  monthlyPayment: number;
  totalMonthlyCost: number;
  dailyLifestyleCost: number;
  newDailySafeSpend: number;
  annualCost: number;
  totalInterestWithOpportunityCost: number;
  hysaAfterDown: number;
  hysaRunwayMonths: number;
  affordability: string;
  incomeCoveragePct: number;
}

/**
 * Purchase comparison across up to 4 options.
 * Source: Decision Sandbox!B21:E30 / BUILD_SPEC §6.1 item 7
 */
export function decisionSandboxCompare(
  options: PurchaseOption[],
  currentDailySafeSpend: number,
  monthlyFixedBills: number,
  variableCap: number,
  baseNetMonthly: number,
  hysaBalance: number,
  returnAssumption: number = RETIREMENT_RETURN,
  opportunityCostMonths: number = 120,
): PurchaseComparisonResult[] {
  const results: PurchaseComparisonResult[] = [];

  for (const opt of options) {
    const financed = opt.totalPrice - opt.downPayment;
    const monthlyPayment =
      opt.annualRate > 0 && opt.termMonths > 0 ? pmt(opt.annualRate, opt.termMonths, financed) : 0.0;

    const totalMonthly = monthlyPayment + opt.monthlyAddons;
    const dailyLifestyle = totalMonthly / 30.4;
    const newDailySafe = currentDailySafeSpend - dailyLifestyle;

    const annualCost =
      opt.totalPrice > 0 && opt.termMonths > 0 ? totalMonthly * 12 : opt.oneTimeCost;

    const actualInterest =
      opt.termMonths > 0 ? monthlyPayment * opt.termMonths - financed : 0.0;
    let oppCost = 0.0;
    if (opt.downPayment > 0) {
      oppCost = fv(returnAssumption / 12, opportunityCostMonths, 0.0, opt.downPayment) - opt.downPayment;
    }
    const totalInterest = actualInterest + oppCost;

    const hysaAfter = hysaBalance - opt.downPayment;
    const hysaRunway = totalMonthly > 0 ? roundTo(hysaAfter / totalMonthly, 1) : Number.POSITIVE_INFINITY;

    const residual = baseNetMonthly - (monthlyFixedBills + totalMonthly);
    let affordability: string;
    if (residual > variableCap) affordability = "Yes";
    else if (residual > 0) affordability = "Tight";
    else affordability = "No";

    const incomePct = baseNetMonthly > 0 ? annualCost / (baseNetMonthly * 12) : 0.0;

    results.push({
      name: opt.name,
      monthlyPayment,
      totalMonthlyCost: totalMonthly,
      dailyLifestyleCost: dailyLifestyle,
      newDailySafeSpend: newDailySafe,
      annualCost,
      totalInterestWithOpportunityCost: totalInterest,
      hysaAfterDown: hysaAfter,
      hysaRunwayMonths: hysaRunway,
      affordability,
      incomeCoveragePct: incomePct,
    });
  }

  return results;
}

/**
 * Minimum base salary (annual, monthly gross) to maintain the savings floor at
 * $0 commission.
 * Source: Decision Sandbox!B53
 */
export function incomeReplacementFloor(
  monthlySavingsTarget: number,
  monthlyFixedBills: number,
  variableCap: number,
  totalTaxRate: number,
): [number, number] {
  const minMonthlyNet = monthlySavingsTarget + monthlyFixedBills + variableCap;
  const annualFloor = (minMonthlyNet * 12) / (1.0 - totalTaxRate);
  return [annualFloor, annualFloor / 12.0];
}

export interface DroughtRunwayResult {
  totalLiquid: number;
  totalBurn: number;
  monthlyDeficit: number;
  monthlySurplus: number;
  runway_months: number | null;
  indefinite: boolean;
}

/**
 * Zero-commission runway calculation.
 * Source: Decision Sandbox!B33:B43
 */
export function droughtSurvivalRunway(
  checkingBalance: number,
  hysaBalance: number,
  monthlyFixedBills: number,
  variableCap: number,
  baseNetMonthly: number,
): DroughtRunwayResult {
  const totalLiquid = checkingBalance + hysaBalance;
  const totalBurn = monthlyFixedBills + variableCap;
  const monthlyDeficit = Math.max(0.0, totalBurn - baseNetMonthly);
  const monthlySurplus = Math.max(0.0, baseNetMonthly - totalBurn);

  let runway_months: number | null;
  let indefinite: boolean;
  if (monthlyDeficit <= 0) {
    runway_months = null;
    indefinite = true;
  } else {
    runway_months = roundTo(totalLiquid / monthlyDeficit, 1);
    indefinite = false;
  }

  return { totalLiquid, totalBurn, monthlyDeficit, monthlySurplus, runway_months, indefinite };
}

// ---------------------------------------------------------------------------
// 12. TAX PLANNING  (Assumptions B35:B41)
// ---------------------------------------------------------------------------

/**
 * Tax reserve amounts — per paycheck and per month. Returns [perPaycheck, perMonth].
 * Source: Assumptions!B38, B40, B41
 */
export function taxReservePerPaycheck(
  grossAnnual: number = GROSS_SALARY,
  fedRate: number = FED_TAX_RATE,
  stateRate: number = STATE_TAX_RATE,
  payPeriods: number = PAY_PERIODS_PER_YEAR,
): [number, number] {
  const annualLiability = grossAnnual * (fedRate + stateRate);
  const perPaycheck = annualLiability / payPeriods;
  const perMonth = annualLiability / 12.0;
  return [perPaycheck, perMonth];
}

// ---------------------------------------------------------------------------
// 13. INCOME GROWTH SCENARIO  (Assumptions B53:B60)
// ---------------------------------------------------------------------------

export interface IncomeGrowthResult {
  current_base_salary: number;
  new_base_salary: number;
  monthly_net_increase: number;
  new_monthly_net: number;
  current_fixed_bills: number;
  new_savings_floor: number;
  savings_floor_improvement: number;
}

/**
 * Raise impact modeling — how a salary change flows to savings.
 * Source: Assumptions!B56:B60
 */
export function incomeGrowthScenario(
  currentBaseSalary: number = GROSS_SALARY,
  newBaseSalary: number = 65000.0,
  fedRate: number = FED_TAX_RATE,
  stateRate: number = STATE_TAX_RATE,
  baseNetMonthly: number = BASE_NET_INCOME,
  monthlyFixedBills: number = 0.0,
): IncomeGrowthResult {
  const monthlyNetIncrease = ((newBaseSalary - currentBaseSalary) * (1 - fedRate - stateRate)) / 12.0;
  const newMonthlyNet = baseNetMonthly + monthlyNetIncrease;
  const newSavingsFloor = newMonthlyNet - monthlyFixedBills;
  return {
    current_base_salary: currentBaseSalary,
    new_base_salary: newBaseSalary,
    monthly_net_increase: monthlyNetIncrease,
    new_monthly_net: newMonthlyNet,
    current_fixed_bills: monthlyFixedBills,
    new_savings_floor: newSavingsFloor,
    savings_floor_improvement: monthlyNetIncrease,
  };
}

// ---------------------------------------------------------------------------
// 14. DEBT STRATEGY  (Debt Strategy sheet)
// ---------------------------------------------------------------------------

export interface DebtAnalysis {
  standard_monthly: number;
  standard_total_paid: number;
  standard_total_interest: number;
  extended_monthly: number;
  extended_total_paid: number;
  extended_total_interest: number;
  extra_interest_extended_vs_standard: number;
  payoff_3yr_monthly: number;
  payoff_3yr_total_interest: number;
  payoff_3yr_interest_saved: number;
  payoff_5yr_monthly: number;
  payoff_5yr_total_interest: number;
  payoff_5yr_interest_saved: number;
  payoff_7yr_monthly: number;
  payoff_7yr_total_interest: number;
  payoff_7yr_interest_saved: number;
  invest_fv_3yr_extra: number;
  invest_verdict: "INVEST the difference" | "PAY AGGRESSIVELY";
  invest_dollar_advantage: number;
}

/**
 * Student loan debt strategy analysis.
 * Source: Debt Strategy!B19-B50 / BUILD_SPEC §6.1 item 5
 */
export function debtPayoffAnalysis(
  balance: number,
  annualRate: number,
  standardTermYears: number = 10,
  extendedTermYears: number = 25,
  returnAssumption: number = RETIREMENT_RETURN,
): DebtAnalysis {
  const stdMonthly = pmt(annualRate, standardTermYears * 12, balance);
  const stdTotal = stdMonthly * standardTermYears * 12;
  const stdInterest = stdTotal - balance;

  const extMonthly = pmt(annualRate, extendedTermYears * 12, balance);
  const extTotal = extMonthly * extendedTermYears * 12;
  const extInterest = extTotal - balance;
  const extraInterest = extInterest - stdInterest;

  const m3 = pmt(annualRate, 36, balance);
  const i3 = m3 * 36 - balance;
  const s3 = stdInterest - i3;

  const m5 = pmt(annualRate, 60, balance);
  const i5 = m5 * 60 - balance;
  const s5 = stdInterest - i5;

  const m7 = pmt(annualRate, 84, balance);
  const i7 = m7 * 84 - balance;
  const s7 = stdInterest - i7;

  const extraMonthly = m3 - stdMonthly;
  const investFv = fvAnnual(returnAssumption / 12, 120, extraMonthly, 0.0);
  const dollarAdvantage = investFv - s3;
  const verdict: DebtAnalysis["invest_verdict"] =
    investFv > s3 ? "INVEST the difference" : "PAY AGGRESSIVELY";

  return {
    standard_monthly: stdMonthly,
    standard_total_paid: stdTotal,
    standard_total_interest: stdInterest,
    extended_monthly: extMonthly,
    extended_total_paid: extTotal,
    extended_total_interest: extInterest,
    extra_interest_extended_vs_standard: extraInterest,
    payoff_3yr_monthly: m3,
    payoff_3yr_total_interest: i3,
    payoff_3yr_interest_saved: s3,
    payoff_5yr_monthly: m5,
    payoff_5yr_total_interest: i5,
    payoff_5yr_interest_saved: s5,
    payoff_7yr_monthly: m7,
    payoff_7yr_total_interest: i7,
    payoff_7yr_interest_saved: s7,
    invest_fv_3yr_extra: investFv,
    invest_verdict: verdict,
    invest_dollar_advantage: Math.abs(dollarAdvantage),
  };
}

// ---------------------------------------------------------------------------
// 15. RETIREMENT PLANNING  (Retirement Planning sheet)
// ---------------------------------------------------------------------------

export interface RetirementProjectionResult {
  years_to_retirement: number;
  annual_contribution: number;
  monthly_contribution: number;
  employer_match_captured: number;
  max_employer_match: number;
  total_annual_going_in: number;
  projected_at_60: number;
  projected_at_65: number;
  at_cap_projected_60: number;
  at_cap_projected_65: number;
  aggressive_projected_60: number;
  aggressive_projected_65: number;
  match_gap_banner: string;
  million_monthly_needed: number;
}

/**
 * 401(k) projections at three contribution rates (current, ceiling, aggressive 12%).
 * Source: Retirement Planning!B35-B40 / FIX_PLAN §A2
 */
export function retirementProjection(
  grossSalary: number = GROSS_SALARY,
  contributionPct: number = K401_CONTRIBUTION_PCT,
  currentBalance: number = 2200.0,
  currentAge: number = 30,
  targetAge: number = 65,
  returnAssumption: number = RETIREMENT_RETURN,
  matchMultiplier: number = K401_MATCH_MULTIPLIER,
  employeeCeiling: number = K401_EMPLOYEE_CEILING,
): RetirementProjectionResult {
  const years = targetAge - currentAge;

  const empAnnual = grossSalary * contributionPct;
  const matchGap = matchGapAnalysis(grossSalary, contributionPct, matchMultiplier, employeeCeiling);
  const matchCaptured = matchGap.annualCaptured;
  const totalAnnual = empAnnual + matchCaptured;

  const proj60 = fvAnnual(returnAssumption, 60 - currentAge, totalAnnual, currentBalance);
  const proj65 = fvAnnual(returnAssumption, years, totalAnnual, currentBalance);

  const capEmpAnnual = grossSalary * employeeCeiling;
  const capMatch = matchGapAnalysis(grossSalary, employeeCeiling, matchMultiplier, employeeCeiling);
  const capTotal = capEmpAnnual + capMatch.annualCaptured;
  const cap60 = fvAnnual(returnAssumption, 60 - currentAge, capTotal, currentBalance);
  const cap65 = fvAnnual(returnAssumption, years, capTotal, currentBalance);

  const aggPct = 0.12;
  const aggEmp = grossSalary * aggPct;
  const aggMatch = matchGapAnalysis(grossSalary, aggPct, matchMultiplier, employeeCeiling);
  const aggTotal = aggEmp + aggMatch.annualCaptured;
  const agg60 = fvAnnual(returnAssumption, 60 - currentAge, aggTotal, currentBalance);
  const agg65 = fvAnnual(returnAssumption, years, aggTotal, currentBalance);

  let banner: string;
  if (matchGap.atCeiling) {
    banner = "Full match captured";
  } else {
    const monthlyGap = matchGap.monthlyGap;
    const annualGap = matchGap.annualGap;
    banner =
      `Contributing ${(contributionPct * 100).toFixed(1)}% vs ` +
      `${(employeeCeiling * 100).toFixed(1)}% employee contribution ceiling. ` +
      `$${annualGap.toFixed(2)}/year ($${monthlyGap.toFixed(2)}/mo) in free employer match uncaptured.`;
  }

  const rM = returnAssumption / 12;
  const nM = years * 12;
  const growth = Math.pow(1 + rM, nM);
  let millionMonthly = ((1_000_000 - currentBalance * growth) * rM) / (growth - 1);
  millionMonthly = Math.max(0.0, millionMonthly);

  return {
    years_to_retirement: years,
    annual_contribution: empAnnual,
    monthly_contribution: empAnnual / 24,
    employer_match_captured: matchCaptured,
    max_employer_match: matchGap.annualAvailable,
    total_annual_going_in: totalAnnual,
    projected_at_60: proj60,
    projected_at_65: proj65,
    at_cap_projected_60: cap60,
    at_cap_projected_65: cap65,
    aggressive_projected_60: agg60,
    aggressive_projected_65: agg65,
    match_gap_banner: banner,
    million_monthly_needed: millionMonthly,
  };
}

// ---------------------------------------------------------------------------
// 16. WEALTH MANAGEMENT OUTPUTS
// ---------------------------------------------------------------------------

/** HYSA gap to target. Negative = surplus beyond target. */
export function hysaGap(current: number, target: number = HYSA_TARGET): number {
  return target - current;
}

/**
 * Months to close HYSA gap assuming `savingsToHysaRatio` of savings go to HYSA.
 * Returns null if gap is 0/negative (already at target) or no savings allocated.
 */
export function monthsToCloseHysaGap(
  gap: number,
  monthlySavings: number,
  savingsToHysaRatio: number = SAVINGS_TO_HYSA_RATIO,
): number | null {
  if (gap <= 0) return null;
  const allocated = monthlySavings * savingsToHysaRatio;
  if (allocated <= 0) return null;
  return gap / allocated;
}

/** Savings rate as fraction of gross monthly income. Target: 0.20. */
export function savingsRate(monthlySavings: number, grossMonthly: number): number {
  if (grossMonthly <= 0) return 0.0;
  return monthlySavings / grossMonthly;
}

/**
 * Net worth FV at target ages. Returns object keyed by target age.
 * Source: Wealth Management Net Worth Projection
 */
export function netWorthProjection(
  currentNetWorth: number,
  monthlySavingsFloor: number,
  currentAge: number = 30,
  targetAges: number[] = [35, 40, 45],
  returnAssumption: number = RETIREMENT_RETURN,
): Record<number, number> {
  const results: Record<number, number> = {};
  for (const age of targetAges) {
    const years = age - currentAge;
    if (years <= 0) {
      results[age] = currentNetWorth;
    } else {
      const annualSavings = monthlySavingsFloor * 12;
      results[age] = fvAnnual(returnAssumption, years, annualSavings, currentNetWorth);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 17. STALENESS CHECK  (Dashboard B8 / Playbook §6.4)
// ---------------------------------------------------------------------------

/** True if checking balance is more than `warnDays` old. */
export function isStale(
  lastBalanceUpdate: Date,
  today: Date,
  warnDays: number = STALENESS_WARN_DAYS,
): boolean {
  return daysSinceUpdate(lastBalanceUpdate, today) > warnDays;
}

/** True if nominal payday falls on a weekend. Source: Dashboard!B26 */
export function paydayRiskFlag(nextPaydayNominal: Date): boolean {
  return pyWeekday(nextPaydayNominal) >= 5;
}

// ---------------------------------------------------------------------------
// 18. VARIABLE SPEND PRORATION HELPERS
// ---------------------------------------------------------------------------

/** Daily variable spend allowance. Playbook §2.2: $600 / 30.4 = $19.74/day */
export function variableDailyRate(
  variableCap: number = VARIABLE_SPEND_CAP,
  monthLengthDays: number = MONTH_LENGTH_DAYS,
): number {
  return variableCap / monthLengthDays;
}

/** Variable spend for a given number of days (e.g., 7 days of forward reserve). */
export function variableProrated(
  days: number,
  variableCap: number = VARIABLE_SPEND_CAP,
  monthLengthDays: number = MONTH_LENGTH_DAYS,
): number {
  return days * (variableCap / monthLengthDays);
}
