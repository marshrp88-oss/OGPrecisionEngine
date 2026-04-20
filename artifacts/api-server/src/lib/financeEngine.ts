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
import { eq, desc, and, lte, gte } from "drizzle-orm";

export interface CycleState {
  checkingBalance: number;
  lastBalanceUpdate: Date | null;
  nextPayday: Date | null;
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
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function isWeekend(d: Date): boolean {
  const day = d.getDay(); // 0=Sun, 6=Sat
  return day === 0 || day === 6;
}

export async function computeCycleState(): Promise<CycleState> {
  const alertThreshold = await getAssumption("alert_threshold", 400);
  const monthLengthDays = await getAssumption("month_length_days", 30.4);
  const variableSpendCap = await getAssumption("variable_spend_cap", 600);

  // Get latest checking balance
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
    ? daysBetween(lastBalanceUpdate, today)
    : null;

  // Stale if >3 days old or no balance recorded
  const isStale = daysSinceUpdate === null || daysSinceUpdate > 3;

  // Get next payday from assumptions
  const nextPaydayStr = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "next_payday_date"))
    .then(([r]) => r?.value ?? null);

  const nextPayday = parseDate(nextPaydayStr);
  const daysUntilPayday = nextPayday ? Math.max(0, daysBetween(today, nextPayday)) : null;

  const paydayRisk = nextPayday ? isWeekend(nextPayday) : false;

  // Bills due before next payday — Column H AND-gate logic:
  // include=TRUE, amount>0, dueDate >= today, dueDate < nextPayday
  const allBills = await db.select().from(bills);
  let billsDueBeforePayday = 0;

  for (const bill of allBills) {
    if (!bill.includeInCycle) continue;
    const amount = parseFloat(bill.amount);
    if (amount <= 0) continue;

    // Check active_from / active_until (prepaid bills)
    if (bill.activeFrom || bill.activeUntil) {
      const activeFrom = bill.activeFrom ? new Date(bill.activeFrom) : null;
      const activeUntil = bill.activeUntil ? new Date(bill.activeUntil) : null;
      if (activeFrom && today < activeFrom) continue;
      if (activeUntil && today > activeUntil) continue;
    }

    // Compute next due date for this bill
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

  // Pending holds and minimum cushion from assumptions
  const pendingHoldsReserve = await getAssumption("pending_holds_reserve", 0);
  const minimumCushion = await getAssumption("minimum_cushion", 0);

  // One-time expenses due before payday
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

  // Total required hold
  const totalRequiredHold =
    billsDueBeforePayday + pendingHoldsReserve + minimumCushion + oneTimeDueBeforePayday;

  // Safe to Spend — clamped to 0
  const safeToSpend = Math.max(0, checkingBalance - totalRequiredHold);

  // Daily rates
  const lastUpdateDate = lastBalanceUpdate ? new Date(lastBalanceUpdate) : today;
  lastUpdateDate.setHours(0, 0, 0, 0);

  const daysFromUpdateToPayday =
    nextPayday && lastUpdateDate < nextPayday
      ? daysBetween(lastUpdateDate, nextPayday)
      : 0;

  // Variable spend until payday (user inputs via assumptions or variable spend log)
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

  // Status
  let status: "GREEN" | "YELLOW" | "RED" = "GREEN";
  if (safeToSpend <= 0) status = "RED";
  else if (safeToSpend < alertThreshold) status = "YELLOW";

  return {
    checkingBalance,
    lastBalanceUpdate,
    nextPayday,
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

  // Next payday
  const nextPaydayStr = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "next_payday_date"))
    .then(([r]) => r?.value ?? null);
  const nextPayday = parseDate(nextPaydayStr);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Confirmed commission this cycle (22nd of current month)
  const now = new Date();
  const payoutDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-22`;
  const [confirmedRow] = await db
    .select()
    .from(commissions)
    .where(and(eq(commissions.payoutDate, payoutDateStr), eq(commissions.status, "confirmed")))
    .limit(1);
  const confirmedCommission = confirmedRow ? parseFloat(confirmedRow.takeHome) : 0;

  const totalMonthIncome = baseNetIncome + confirmedCommission;

  // Full month fixed bills (include=TRUE)
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

  // Remaining variable spend prorated: (days to payday / 30.4) * cap
  const daysToPayday = nextPayday ? Math.max(0, daysBetween(today, nextPayday)) : 0;
  const remainingVariableSpendProrated =
    Math.max(0, Math.round(((daysToPayday) / monthLengthDays) * variableSpendCap * 100) / 100);

  // Known one-time costs (ALL, regardless of due date)
  const allOneTime = await db.select().from(oneTimeExpenses).where(eq(oneTimeExpenses.paid, false));
  let knownOneTimeCosts = 0;
  for (const ote of allOneTime) {
    knownOneTimeCosts += parseFloat(ote.amount);
  }

  // QuickSilver accrual: sum of quicksilver=true variable spend
  const vsEntries = await db.select().from(variableSpend);
  let quicksilverAccrual = 0;
  for (const vs of vsEntries) {
    if (vs.quicksilver) quicksilverAccrual += parseFloat(vs.amount);
  }

  // Forward reserve
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
      quicksilverAccrual -
      forwardReserve
  );

  // 401k match gap analysis
  const [ret] = await db.select().from(retirementPlan).limit(1);
  let matchGapActive = false;
  let monthlyMatchGapCost = 0;
  if (ret) {
    const contribRate = parseFloat(ret.contributionRate);
    const matchCap = parseFloat(ret.employerMatchCap);
    matchGapActive = contribRate < matchCap;
    if (matchGapActive) {
      const grossSalary = parseFloat(ret.grossSalary);
      const gapRate = matchCap - contribRate;
      // Rough net cost: gap * salary / 12 * (1 - 0.25 tax)
      monthlyMatchGapCost = Math.round((grossSalary * gapRate) / 12 * 0.75);
    }
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
    forwardReserve,
    estimatedMonthlySavings,
    matchGapActive,
    monthlyMatchGapCost,
    savingsAfterMatchBump,
    canAffordMatchBump,
  };
}

export function computeMrrPayout(mrrAchieved: number, mrrTarget: number): number {
  const excess = Math.max(0, mrrAchieved - mrrTarget);
  let payout = 0;
  if (mrrAchieved <= 0) return 0;
  // Tiered: 0-$100: 0.10x, $101-$300: 0.25x, $301-$500: 0.40x, $501-$700: 0.55x, >$700: 0.65x
  if (mrrAchieved <= 100) {
    payout = mrrAchieved * 0.10;
  } else if (mrrAchieved <= 300) {
    payout = 100 * 0.10 + (mrrAchieved - 100) * 0.25;
  } else if (mrrAchieved <= 500) {
    payout = 100 * 0.10 + 200 * 0.25 + (mrrAchieved - 300) * 0.40;
  } else if (mrrAchieved <= mrrTarget) {
    payout = 100 * 0.10 + 200 * 0.25 + 200 * 0.40 + (mrrAchieved - 500) * 0.55;
  } else {
    payout = 100 * 0.10 + 200 * 0.25 + 200 * 0.40 + (mrrTarget - 500) * 0.55 + excess * 0.65;
  }
  return Math.round(payout * 100) / 100;
}

export function computeNrrPayout(nrrAchieved: number, nrrTarget: number): number {
  if (nrrAchieved <= 0) return 0;
  // Tiered: 0-$1000: 0.005x, $1001-$2000: 0.010x, $2001-$4000: 0.020x, $4001-$6000: 0.030x, >$6000: 0.042x
  let payout = 0;
  if (nrrAchieved <= 1000) {
    payout = nrrAchieved * 0.005;
  } else if (nrrAchieved <= 2000) {
    payout = 1000 * 0.005 + (nrrAchieved - 1000) * 0.010;
  } else if (nrrAchieved <= 4000) {
    payout = 1000 * 0.005 + 1000 * 0.010 + (nrrAchieved - 2000) * 0.020;
  } else if (nrrAchieved <= nrrTarget) {
    payout = 1000 * 0.005 + 1000 * 0.010 + 2000 * 0.020 + (nrrAchieved - 4000) * 0.030;
  } else {
    payout = 1000 * 0.005 + 1000 * 0.010 + 2000 * 0.020 + (nrrTarget - 4000) * 0.030 + (nrrAchieved - nrrTarget) * 0.042;
  }
  return Math.round(payout * 100) / 100;
}

export function computeTakeHome(grossPayout: number, taxRate = 0.435): number {
  return Math.round(grossPayout * (1 - taxRate) * 100) / 100;
}

export function computePayoutDate(salesMonthStr: string, payoutDay = 22): string {
  const salesDate = new Date(salesMonthStr);
  const payoutMonth = salesDate.getMonth() + 1; // next month
  const payoutYear = salesDate.getFullYear() + (payoutMonth > 11 ? 1 : 0);
  const actualMonth = payoutMonth > 11 ? 0 : payoutMonth;
  const d = new Date(payoutYear, actualMonth, payoutDay);
  return d.toISOString().split("T")[0];
}

export function computeScenarioOutputs(type: string, inputs: Record<string, unknown>): Record<string, unknown> {
  if (type === "vehicle") {
    const sticker = Number(inputs.sticker) || 0;
    const downPayment = Number(inputs.downPayment) || 3700;
    const rate = Number(inputs.rate) || 0.0574;
    const months = Number(inputs.months) || 60;
    const insurance = Number(inputs.insurance) || 182;
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
    const targetPayment = Number(inputs.targetPayment) || 315;
    const affordable = payment <= targetPayment;
    return {
      monthlyPayment: Math.round(payment * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalInterest: Math.round(totalInterest * 100) / 100,
      newMonthlyBurn: Math.round(newMonthlyBurn * 100) / 100,
      affordable,
      paymentVsTarget: `$${Math.round(payment)} vs $${targetPayment} target`,
    };
  }

  if (type === "drought_survival") {
    const checking = Number(inputs.checking) || 0;
    const hysa = Number(inputs.hysa) || 0;
    const monthlyBurn = Number(inputs.monthlyBurn) || 2104;
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
    const fixedMonthly = Number(inputs.fixedMonthly) || 2104;
    const variableCap = Number(inputs.variableCap) || 600;
    const taxRate = Number(inputs.taxRate) || 0.22;
    const requiredNet = targetSavings + fixedMonthly + variableCap;
    const requiredGross = requiredNet / (1 - taxRate) * 12;
    return {
      requiredMonthlyNet: Math.round(requiredNet * 100) / 100,
      requiredAnnualGross: Math.round(requiredGross * 100) / 100,
    };
  }

  if (type === "income_change") {
    const currentBase = Number(inputs.currentBase) || 54000;
    const newBase = Number(inputs.newBase) || 65000;
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
