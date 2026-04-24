import { Router, type IRouter } from "express";
import {
  GetDashboardCycleResponse,
  GetMonthlySavingsResponse,
} from "@workspace/api-zod";
import { computeCycleState, computeMonthlySavings, deriveNextPayday } from "../lib/financeEngine";
import { billsThisMonth } from "../lib/cycleBillEngine";
import { db, oneTimeExpenses, variableSpend, bills, assumptions, commissions, balances } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  BASE_NET_INCOME,
  MONTH_LENGTH_DAYS,
  VARIABLE_SPEND_CAP,
  Bill as EngineBill,
  OneTimeExpense as EngineOneTime,
  monthlySavingsEstimate,
  nextNominalPayday,
} from "@workspace/finance";

const router: IRouter = Router();

router.get("/dashboard/cycle", async (_req, res): Promise<void> => {
  const cycle = await computeCycleState();
  res.json(
    GetDashboardCycleResponse.parse({
      ...cycle,
      lastBalanceUpdate: cycle.lastBalanceUpdate?.toISOString() ?? null,
      nextPayday: cycle.nextPayday?.toISOString().split("T")[0] ?? null,
    })
  );
});

router.get("/dashboard/monthly-savings", async (_req, res): Promise<void> => {
  const savings = await computeMonthlySavings();
  res.json(GetMonthlySavingsResponse.parse(savings));
});

// Discretionary THIS MONTH — month-frame view of remaining spend capability.
// All monetary math delegates to @workspace/finance helpers; this route only
// loads DB rows, projects future paychecks via engine `nextNominalPayday`,
// and uses engine `monthlySavingsEstimate` for the cycle-frame parity number.
router.get("/dashboard/discretionary", async (_req, res): Promise<void> => {
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
  const checking = latestChecking ? parseFloat(latestChecking.amount as unknown as string) : 0;

  const allAssumps = await db.select().from(assumptions);
  const A = (k: string, dflt = 0) => {
    const r = allAssumps.find((a) => a.key === k);
    return r ? parseFloat(r.value) : dflt;
  };
  const baseNetIncome = A("base_net_income", BASE_NET_INCOME);
  const variableCap = A("variable_spend_cap", VARIABLE_SPEND_CAP);
  const monthLengthDays = A("month_length_days", MONTH_LENGTH_DAYS);
  const minimumCushion = A("minimum_cushion", 0);
  const quicksilverBalanceOwed = A("quicksilver_balance_owed", 0);

  // Paychecks remaining this month: walk engine `nextNominalPayday` until end-of-month.
  const paydayDays = [7, 22];
  const monthEndUtc = new Date(Date.UTC(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate()));
  const cursorStart = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  let paychecksRemaining = 0;
  let cursor = new Date(cursorStart);
  while (cursor.getTime() <= monthEndUtc.getTime()) {
    const nominal = nextNominalPayday(cursor, paydayDays);
    if (nominal.getTime() > monthEndUtc.getTime()) break;
    // Count using nominal day; effectivePayday only matters for cash-availability,
    // not for "did this month's paycheck land in checking yet".
    paychecksRemaining += 1;
    cursor = new Date(Date.UTC(nominal.getUTCFullYear(), nominal.getUTCMonth(), nominal.getUTCDate() + 1));
  }
  const remainingPaychecksThisMonth = Math.round((baseNetIncome / 2) * paychecksRemaining * 100) / 100;

  // Confirmed commission for THIS month, split into already-received vs pending.
  const allCommissions = await db.select().from(commissions);
  let confirmedCommissionUnreceived = 0;
  let confirmedCommissionAlready = 0;
  let confirmedCommissionTotal = 0;
  for (const c of allCommissions) {
    if (!c.payoutDate) continue;
    const pd = new Date(c.payoutDate);
    if (pd.getFullYear() !== today.getFullYear() || pd.getMonth() !== today.getMonth()) continue;
    if (c.status !== "paid" && c.status !== "confirmed") continue;
    const amount = parseFloat(c.takeHome);
    confirmedCommissionTotal += amount;
    if (pd <= today) confirmedCommissionAlready += amount;
    else confirmedCommissionUnreceived += amount;
  }

  // Bills remaining this month (Include=TRUE, due day in [today, month end]).
  const allBills = await db.select().from(bills);
  let billsRemainingThisMonth = 0;
  const billsRemainingDetail: { id: number; name: string; amount: number; dueDay: number }[] = [];
  for (const b of allBills) {
    if (!b.includeInCycle) continue;
    const amt = parseFloat(b.amount);
    if (amt <= 0) continue;
    if (b.dueDay >= today.getDate() && b.dueDay <= monthEnd.getDate()) {
      billsRemainingThisMonth += amt;
      billsRemainingDetail.push({ id: b.id, name: b.name, amount: amt, dueDay: b.dueDay });
    }
  }

  // Unpaid one-time expenses: dated through month-end + undated (advisory).
  const oteRows = await db.select().from(oneTimeExpenses).where(eq(oneTimeExpenses.paid, false));
  let oneTimeDatedThisMonth = 0;
  let oneTimeUndated = 0;
  for (const o of oteRows) {
    const amt = parseFloat(o.amount);
    if (!o.dueDate) { oneTimeUndated += amt; continue; }
    const dd = new Date(o.dueDate);
    if (dd >= today && dd <= monthEnd) oneTimeDatedThisMonth += amt;
  }

  // Variable spent this month and remaining (cap − spent).
  const allVs = await db.select().from(variableSpend);
  const monthVs = allVs.filter((v) => new Date(v.weekOf) >= monthStart && new Date(v.weekOf) <= today);
  const variableSpentThisMonth = monthVs.reduce((s, v) => s + parseFloat(v.amount), 0);
  const quicksilverAccruedThisMonth = monthVs
    .filter((v) => v.quicksilver)
    .reduce((s, v) => s + parseFloat(v.amount), 0);
  const variableRemainingThisMonth = Math.max(0, variableCap - variableSpentThisMonth);

  // ---- Aggregate (data shaping; no finance formulas) ----
  const inflows = checking + remainingPaychecksThisMonth + confirmedCommissionUnreceived;
  const outflows =
    billsRemainingThisMonth +
    oneTimeDatedThisMonth +
    variableRemainingThisMonth +
    quicksilverBalanceOwed +
    minimumCushion;
  const discretionaryThisMonth = Math.max(0, inflows - outflows);

  // Cycle parity (Safe-to-Spend frame) — engine via computeCycleState.
  const cycle = await computeCycleState();

  const round = (n: number) => Math.round(n * 100) / 100;

  // ---- Discipline metrics — engine-sourced where possible ----
  const monthBillRows = await billsThisMonth(today);
  const monthBillsForEngine: EngineBill[] = monthBillRows.map(
    (b) => new EngineBill(b.name, b.amount, b.dueDay, true, b.category),
  );
  const fixedMonthlyTotal = monthBillsForEngine.reduce((s, b) => s + b.amount, 0);
  const fixedRatio = baseNetIncome > 0 ? fixedMonthlyTotal / baseNetIncome : 0;

  // Savings rate uses engine `monthlySavingsEstimate` (B62) divided by income —
  // this is the structural savings floor, not an ad-hoc subtraction.
  const oteForEngine: EngineOneTime[] = oteRows.map(
    (o) => new EngineOneTime(o.description, parseFloat(o.amount), o.dueDate ? new Date(o.dueDate) : null, false),
  );
  const nextPayday = deriveNextPayday(today);
  const engineSavings = monthlySavingsEstimate(
    baseNetIncome,
    confirmedCommissionTotal,
    monthBillsForEngine,
    nextPayday,
    today,
    oteForEngine,
    quicksilverBalanceOwed,
    monthBillsForEngine,
    variableCap,
    monthLengthDays,
  );
  const savingsRate = baseNetIncome > 0 ? engineSavings / (baseNetIncome + confirmedCommissionTotal) : 0;

  const dayOfMonth = today.getDate();
  const daysInMonth = monthEnd.getDate();
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
    // Headline
    discretionaryThisMonth: round(discretionaryThisMonth),
    monthEnd: monthEnd.toISOString().split("T")[0],

    // Inflows
    checking: round(checking),
    remainingPaychecksThisMonth,
    paychecksRemainingCount: paychecksRemaining,
    baseNetIncome,
    confirmedCommissionUnreceived: round(confirmedCommissionUnreceived),
    confirmedCommissionAlready: round(confirmedCommissionAlready),
    totalInflowsAvailable: round(inflows),

    // Outflows
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

    // Cycle parity
    safeToSpend: cycle.safeToSpend,
    cycleStatus: cycle.status,

    // Discipline (Playbook spend discipline)
    discipline,
  });
});

// Lightweight integrity summary for the dashboard banner.
// Does NOT log a row. Independent of /integrity/check (which logs).
router.get("/dashboard/integrity-summary", async (_req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const checks: { name: string; status: "pass" | "warn" | "fail"; detail: string }[] = [];

  // 1. Balance freshness
  const { balances } = await import("@workspace/db");
  const [latestBalance] = await db.select().from(balances).where(eq(balances.accountType, "checking")).orderBy(desc(balances.asOfDate)).limit(1);
  if (!latestBalance) {
    checks.push({ name: "Checking balance", status: "fail", detail: "No checking balance recorded." });
  } else {
    const days = Math.floor((today.getTime() - new Date(latestBalance.asOfDate).getTime()) / 86400000);
    if (days > 3) checks.push({ name: "Balance freshness", status: "fail", detail: `Updated ${days} days ago — must be ≤3.` });
    else checks.push({ name: "Balance freshness", status: "pass", detail: `Updated ${days} day(s) ago.` });
  }

  // 2. Next payday
  const [payRow] = await db.select().from(assumptions).where(eq(assumptions.key, "next_payday_date"));
  if (!payRow?.value) checks.push({ name: "Next payday set", status: "fail", detail: "Configure in Settings." });
  else {
    const pd = new Date(payRow.value);
    if (pd < today) checks.push({ name: "Next payday set", status: "fail", detail: `Payday (${payRow.value}) is in the past.` });
    else checks.push({ name: "Next payday set", status: "pass", detail: `Payday: ${payRow.value}.` });
  }

  // 3. Active bills exist
  const allBills = await db.select().from(bills);
  const active = allBills.filter((b) => b.includeInCycle && parseFloat(b.amount) > 0);
  if (active.length === 0) checks.push({ name: "Active bills", status: "warn", detail: "No bills marked Include=TRUE." });
  else checks.push({ name: "Active bills", status: "pass", detail: `${active.length} active bills.` });

  // 4. No negative bills
  const negBills = allBills.filter((b) => parseFloat(b.amount) < 0);
  if (negBills.length > 0) checks.push({ name: "Bill amounts non-negative", status: "fail", detail: `${negBills.length} bill(s) have negative amounts.` });
  else checks.push({ name: "Bill amounts non-negative", status: "pass", detail: "All bills ≥ 0." });

  // 5. Base net income
  const [incRow] = await db.select().from(assumptions).where(eq(assumptions.key, "base_net_income"));
  if (!incRow || parseFloat(incRow.value) <= 0) checks.push({ name: "Base net income", status: "fail", detail: "Set in Settings." });
  else checks.push({ name: "Base net income", status: "pass", detail: `$${parseFloat(incRow.value).toFixed(2)}/mo` });

  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const overall: "pass" | "warn" | "fail" = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  res.json({ overall, failCount, warnCount, checks });
});

export default router;
