import { db } from "@workspace/db";
import {
  assumptions,
  bills,
  oneTimeExpenses,
  variableSpend,
  balances,
  commissions,
  retirementPlan,
} from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";

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

function parseDate(d: string | null): Date | null {
  if (!d) return null;
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function daysBetween(a: Date, b: Date): number {
  return Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

/**
 * Effective payday: weekend-adjusted. Saturday or Sunday paydays bump back to Friday.
 */
export function effectivePayday(nominal: Date): Date {
  const d = new Date(nominal);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  if (day === 6) {
    d.setDate(d.getDate() - 1);
  } else if (day === 0) {
    d.setDate(d.getDate() - 2);
  }
  return d;
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

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const daysSinceUpdate = lastBalanceUpdate
    ? Math.max(0, Math.floor((today.getTime() - lastBalanceUpdate.getTime()) / (1000 * 60 * 60 * 24)))
    : null;

  const isStale = daysSinceUpdate === null || daysSinceUpdate > 3;

  const nextPaydayStr = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "next_payday_date"))
    .then(([r]) => r?.value ?? null);

  const nextPaydayNominal = parseDate(nextPaydayStr);
  const nextPayday = nextPaydayNominal ? effectivePayday(nextPaydayNominal) : null;

  const daysUntilPayday = nextPayday ? Math.max(0, daysBetween(today, nextPayday)) : null;

  const paydayRisk = nextPaydayNominal ? isWeekend(nextPaydayNominal) : false;

  const allBills = await db.select().from(bills);
  let billsDueBeforePayday = 0;

  for (const bill of allBills) {
    if (!bill.includeInCycle) continue;
    const amount = parseFloat(bill.amount);
    if (amount <= 0) continue;

    if (bill.activeFrom || bill.activeUntil) {
      const activeFrom = bill.activeFrom ? new Date(bill.activeFrom) : null;
      const activeUntil = bill.activeUntil ? new Date(bill.activeUntil) : null;
      if (activeFrom && today < activeFrom) continue;
      if (activeUntil && today > activeUntil) continue;
    }

    const dueDay = bill.dueDay;
    let dueDateThisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay);
    if (dueDateThisMonth < today) {
      dueDateThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
    }

    const dueDate = dueDateThisMonth;
    if (nextPayday && dueDate >= today && dueDate < nextPayday) {
      billsDueBeforePayday += amount;
    }
  }

  const pendingHoldsReserve = await getAssumption("pending_holds_reserve", 0);
  const minimumCushion = await getAssumption("minimum_cushion", 0);

  const allOneTime = await db.select().from(oneTimeExpenses);
  let oneTimeDueBeforePayday = 0;
  for (const ote of allOneTime) {
    if (ote.paid) continue;
    if (!ote.dueDate) continue;
    const amount = parseFloat(ote.amount);
    if (amount <= 0) continue;
    const dueDate = new Date(ote.dueDate);
    if (nextPayday && dueDate >= today && dueDate <= nextPayday) {
      oneTimeDueBeforePayday += amount;
    }
  }

  // Forward reserve: bills due 1st-7th of next month + 7 days prorated variable
  let forwardReserveFixed = 0;
  for (const bill of allBills) {
    if (!bill.includeInCycle) continue;
    const amount = parseFloat(bill.amount);
    if (amount <= 0) continue;
    const dueDay = bill.dueDay;
    if (dueDay >= 1 && dueDay <= 7) {
      if (bill.activeFrom || bill.activeUntil) {
        const activeFrom = bill.activeFrom ? new Date(bill.activeFrom) : null;
        const activeUntil = bill.activeUntil ? new Date(bill.activeUntil) : null;
        if (activeFrom && today < activeFrom) continue;
        if (activeUntil && today > activeUntil) continue;
      }
      forwardReserveFixed += amount;
    }
  }
  const perDayVariable = variableSpendCap / monthLengthDays;
  const forwardReserve = forwardReserveFixed + 7 * perDayVariable;

  // Required Hold per BUILD_SPEC §4.4: bills + pending + cushion + one-time only.
  // Forward Reserve is NOT subtracted from Safe to Spend.
  const totalRequiredHold =
    billsDueBeforePayday + pendingHoldsReserve + minimumCushion + oneTimeDueBeforePayday;

  const safeToSpend = Math.max(0, checkingBalance - totalRequiredHold);

  const lastUpdateDate = lastBalanceUpdate ? new Date(lastBalanceUpdate) : today;
  lastUpdateDate.setHours(0, 0, 0, 0);

  const daysFromUpdateToPayday =
    nextPayday && lastUpdateDate < nextPayday
      ? daysBetween(lastUpdateDate, nextPayday)
      : 0;

  const variableSpendUntilPayday = await getAssumption("variable_spend_until_payday", 0);

  const dailyRateFromUpdate =
    daysFromUpdateToPayday > 0
      ? Math.max(0, (safeToSpend - variableSpendUntilPayday) / daysFromUpdateToPayday)
      : 0;

  const daysFromTodayToPayday =
    nextPayday && today < nextPayday ? daysBetween(today, nextPayday) : 0;

  const dailyRateRealTime =
    daysFromTodayToPayday > 0
      ? Math.max(0, (safeToSpend - variableSpendUntilPayday) / daysFromTodayToPayday)
      : 0;

  const daysOfCoverage =
    dailyRateFromUpdate > 0 ? safeToSpend / dailyRateFromUpdate : null;

  const remainingDiscretionary = Math.max(0, safeToSpend - variableSpendUntilPayday);

  let status: "GREEN" | "YELLOW" | "RED" = "GREEN";
  if (safeToSpend <= 0 && totalRequiredHold > checkingBalance) status = "RED";
  else if (safeToSpend < alertThreshold) status = "YELLOW";

  return {
    checkingBalance,
    lastBalanceUpdate,
    nextPayday,
    nextPaydayNominal,
    daysSinceUpdate,
    isStale,
    daysUntilPayday,
    billsDueBeforePayday,
    pendingHoldsReserve,
    minimumCushion,
    oneTimeDueBeforePayday,
    totalRequiredHold,
    safeToSpend,
    dailyRateFromUpdate,
    dailyRateRealTime,
    daysOfCoverage,
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

  const nextPaydayStr = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "next_payday_date"))
    .then(([r]) => r?.value ?? null);
  const nextPaydayNominal = parseDate(nextPaydayStr);
  const nextPayday = nextPaydayNominal ? effectivePayday(nextPaydayNominal) : null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Confirmed commission this cycle (paid this month, on or before today)
  const allCommissions = await db.select().from(commissions);
  let confirmedCommission = 0;
  for (const c of allCommissions) {
    if (!c.payoutDate) continue;
    const pd = new Date(c.payoutDate);
    if (
      pd.getFullYear() === today.getFullYear() &&
      pd.getMonth() === today.getMonth() &&
      pd <= today &&
      (c.status === "paid" || c.status === "confirmed")
    ) {
      confirmedCommission += parseFloat(c.takeHome);
    }
  }

  const totalMonthIncome = baseNetIncome + confirmedCommission;

  const allBills = await db.select().from(bills);
  let fullMonthFixedBills = 0;
  for (const bill of allBills) {
    if (!bill.includeInCycle) continue;
    const amount = parseFloat(bill.amount);
    if (amount <= 0) continue;
    if (bill.activeFrom || bill.activeUntil) {
      const activeFrom = bill.activeFrom ? new Date(bill.activeFrom) : null;
      const activeUntil = bill.activeUntil ? new Date(bill.activeUntil) : null;
      if (activeFrom && today < activeFrom) continue;
      if (activeUntil && today > activeUntil) continue;
    }
    fullMonthFixedBills += amount;
  }

  const daysToPayday = nextPayday ? Math.max(0, daysBetween(today, nextPayday)) : 0;
  const remainingVariableSpendProrated =
    Math.max(0, Math.round(((daysToPayday) / monthLengthDays) * variableSpendCap * 100) / 100);

  const allOneTime = await db.select().from(oneTimeExpenses).where(eq(oneTimeExpenses.paid, false));
  let knownOneTimeCosts = 0;
  for (const ote of allOneTime) {
    knownOneTimeCosts += parseFloat(ote.amount);
  }

  // QuickSilver: manual `quicksilver_balance_owed` is the canonical reserve
  // line — it represents the carryover CC balance Marshall pays mid-next-month.
  // We expose `quicksilverAccrual` (logged QS spend this month) for context
  // only; subtracting it here would double-count against the variable-cap
  // reservation (which already covers gas+food regardless of payment method).
  const vsEntries = await db.select().from(variableSpend);
  let quicksilverAccrual = 0;
  for (const vs of vsEntries) {
    if (vs.quicksilver) quicksilverAccrual += parseFloat(vs.amount);
  }
  const quicksilverBalanceOwed = await getAssumption("quicksilver_balance_owed", 0);

  let forwardReserveFixed = 0;
  for (const bill of allBills) {
    if (!bill.includeInCycle) continue;
    const amount = parseFloat(bill.amount);
    if (amount <= 0) continue;
    const dueDay = bill.dueDay;
    if (dueDay >= 1 && dueDay <= 7) {
      if (bill.activeFrom || bill.activeUntil) {
        const activeFrom = bill.activeFrom ? new Date(bill.activeFrom) : null;
        const activeUntil = bill.activeUntil ? new Date(bill.activeUntil) : null;
        if (activeFrom && today < activeFrom) continue;
        if (activeUntil && today > activeUntil) continue;
      }
      forwardReserveFixed += amount;
    }
  }
  const perDayVariable = variableSpendCap / monthLengthDays;
  const forwardReserve = forwardReserveFixed + 7 * perDayVariable;

  const estimatedMonthlySavings = Math.max(
    0,
    totalMonthIncome -
      fullMonthFixedBills -
      remainingVariableSpendProrated -
      knownOneTimeCosts -
      quicksilverBalanceOwed -
      forwardReserve
  );

  // 401(k) match gap analysis using new schema semantics:
  //   contribRate = employee contribution % of gross
  //   matchMultiplier (stored in employerMatchRate field) = fraction of employee % matched
  //   employeeContribCeiling (stored in employerMatchCap field) = ceiling for match
  const [ret] = await db.select().from(retirementPlan).limit(1);
  let matchGapActive = false;
  let monthlyMatchGapCost = 0;
  if (ret) {
    const contribRate = parseFloat(ret.contributionRate);
    const matchMultiplier = parseFloat(ret.employerMatchRate);
    const ceiling = parseFloat(ret.employerMatchCap);
    const grossSalary = parseFloat(ret.grossSalary);

    const effectiveEmployeePct = Math.min(contribRate, ceiling);
    const employerMatchPctOfGross = effectiveEmployeePct * matchMultiplier;
    const maxMatchPctOfGross = ceiling * matchMultiplier;
    const annualMatchCaptured = grossSalary * employerMatchPctOfGross;
    const annualMatchAvailable = grossSalary * maxMatchPctOfGross;
    const annualMatchGap = annualMatchAvailable - annualMatchCaptured;

    matchGapActive = annualMatchGap > 0.01;
    monthlyMatchGapCost = Math.round((annualMatchGap / 12) * 100) / 100;
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
    forwardReserve,
    estimatedMonthlySavings,
    matchGapActive,
    monthlyMatchGapCost,
    savingsAfterMatchBump,
    canAffordMatchBump,
  };
}

/**
 * MRR commission payout — Odoo tier formula from workbook v7.2.
 * Tier breakpoints: $349.93, $489.93, target-$0.07 (=$699.93 when target=700).
 * Tier rates: 0.3705, 0.9634, 5.5212, 0.65 (above target).
 */
export function computeMrrPayout(mrrAchieved: number, mrrTarget = 700): number {
  if (mrrAchieved <= 0) return 0;
  const tier1Cap = 349.93;
  const tier2Cap = 489.93;
  const tier3Cap = mrrTarget - 0.07;

  const t1 = Math.max(0, Math.min(mrrAchieved, tier1Cap)) * 0.3705;
  const t2 = Math.max(0, Math.min(mrrAchieved, tier2Cap) - tier1Cap) * 0.9634;
  const t3 = Math.max(0, Math.min(mrrAchieved, tier3Cap) - tier2Cap) * 5.5212;
  const t4 = Math.max(0, mrrAchieved - tier3Cap) * 0.65;

  return Math.round((t1 + t2 + t3 + t4) * 100) / 100;
}

/**
 * NRR commission payout — Odoo tier formula from workbook v7.2.
 * Tier breakpoints: $2,999.40, $4,199.40, target-$0.60 (=$5,999.40 when target=6000).
 * Tier rates: 0.0204, 0.0388, 0.2801, 0.042 (above target).
 */
export function computeNrrPayout(nrrAchieved: number, nrrTarget = 6000): number {
  if (nrrAchieved <= 0) return 0;
  const tier1Cap = 2999.40;
  const tier2Cap = 4199.40;
  const tier3Cap = nrrTarget - 0.6;

  const t1 = Math.max(0, Math.min(nrrAchieved, tier1Cap)) * 0.0204;
  const t2 = Math.max(0, Math.min(nrrAchieved, tier2Cap) - tier1Cap) * 0.0388;
  const t3 = Math.max(0, Math.min(nrrAchieved, tier3Cap) - tier2Cap) * 0.2801;
  const t4 = Math.max(0, nrrAchieved - tier3Cap) * 0.042;

  return Math.round((t1 + t2 + t3 + t4) * 100) / 100;
}

export function computeTakeHome(grossPayout: number, taxRate = 0.435): number {
  return Math.round(grossPayout * (1 - taxRate) * 100) / 100;
}

export function computePayoutDate(salesMonthStr: string, payoutDay = 22): string {
  const salesDate = new Date(salesMonthStr);
  const payoutMonth = salesDate.getMonth() + 1;
  const payoutYear = salesDate.getFullYear() + (payoutMonth > 11 ? 1 : 0);
  const actualMonth = payoutMonth > 11 ? 0 : payoutMonth;
  const d = new Date(payoutYear, actualMonth, payoutDay);
  return d.toISOString().split("T")[0];
}

export function computeScenarioOutputs(type: string, inputs: Record<string, unknown>): Record<string, unknown> {
  if (type === "vehicle") {
    const sticker = Number(inputs.sticker) || 0;
    const downPayment = Number(inputs.downPayment) || 0;
    const rate = Number(inputs.rate) || 0;
    const months = Number(inputs.months) || 60;
    const insurance = Number(inputs.insurance) || 0;
    const principal = sticker - downPayment;
    const monthlyRate = rate / 12;
    const payment =
      principal > 0 && monthlyRate > 0
        ? (principal * monthlyRate * Math.pow(1 + monthlyRate, months)) /
          (Math.pow(1 + monthlyRate, months) - 1)
        : 0;
    const totalCost = payment * months + downPayment;
    const totalInterest = totalCost - sticker;
    const newMonthlyBurn = payment + insurance;
    return {
      monthlyPayment: Math.round(payment * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalInterest: Math.round(totalInterest * 100) / 100,
      newMonthlyBurn: Math.round(newMonthlyBurn * 100) / 100,
    };
  }

  if (type === "drought_survival") {
    const checking = Number(inputs.checking) || 0;
    const hysa = Number(inputs.hysa) || 0;
    const monthlyBurn = Number(inputs.monthlyBurn) || 0;
    const totalLiquid = checking + hysa;
    const runwayMonths = monthlyBurn > 0 ? totalLiquid / monthlyBurn : 0;
    return {
      totalLiquid,
      runwayMonths: Math.round(runwayMonths * 10) / 10,
      runwayLabel: `${Math.floor(runwayMonths)} months ${Math.round((runwayMonths % 1) * 30)} days`,
    };
  }

  if (type === "income_floor") {
    const targetSavings = Number(inputs.targetSavings) || 0;
    const fixedMonthly = Number(inputs.fixedMonthly) || 0;
    const variableCap = Number(inputs.variableCap) || 0;
    const taxRate = Number(inputs.taxRate) || 0.22;
    const requiredNet = targetSavings + fixedMonthly + variableCap;
    const requiredGross = (requiredNet / (1 - taxRate)) * 12;
    return {
      requiredMonthlyNet: Math.round(requiredNet * 100) / 100,
      requiredAnnualGross: Math.round(requiredGross * 100) / 100,
    };
  }

  if (type === "income_change") {
    const currentBase = Number(inputs.currentBase) || 0;
    const newBase = Number(inputs.newBase) || 0;
    const taxRate = Number(inputs.taxRate) || 0.22;
    const currentNet = (currentBase / 12) * (1 - taxRate);
    const newNet = (newBase / 12) * (1 - taxRate);
    return {
      currentMonthlyNet: Math.round(currentNet * 100) / 100,
      newMonthlyNet: Math.round(newNet * 100) / 100,
      monthlyIncrease: Math.round((newNet - currentNet) * 100) / 100,
      annualIncrease: Math.round((newBase - currentBase) * (1 - taxRate) * 100) / 100,
    };
  }

  return {};
}
