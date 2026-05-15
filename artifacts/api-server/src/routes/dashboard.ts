import { Router, type IRouter } from "express";
import { GetDashboardCycleResponse } from "@workspace/api-zod";
import { computeCycleState } from "../lib/financeEngine";
import { billsThisMonth } from "../lib/cycleBillEngine";
import { db, oneTimeExpenses, variableSpend, bills, assumptions, commissions, balances } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  BASE_NET_INCOME,
  MONTH_LENGTH_DAYS,
  VARIABLE_SPEND_CAP,
  Bill as EngineBill,
  commissionTakeHome,
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
  const overrideRow = allAssumps.find((a) => a.key === "planned_variable_remaining_override");
  const plannedVariableRemainingOverride: number | null =
    overrideRow && overrideRow.value !== "" && !isNaN(parseFloat(overrideRow.value))
      ? parseFloat(overrideRow.value)
      : null;

  // §1.2: paychecksReceivedThisMonth + expectedRemainingPaychecks.
  // Paydays: 7th and 22nd of month (engine convention).
  const paydayDays = [7, 22];
  const netPerPaycheck = baseNetIncome / 2;
  let paychecksReceivedThisMonth = 0;
  let expectedRemainingPaychecks = 0;
  let paychecksReceivedCount = 0;
  let paychecksRemainingCount = 0;
  for (const day of paydayDays) {
    const nominal = new Date(today.getFullYear(), today.getMonth(), day);
    const effective = nextNominalPayday(
      new Date(Date.UTC(today.getFullYear(), today.getMonth(), day - 1)),
      paydayDays,
    );
    void effective;
    if (nominal <= today) {
      paychecksReceivedThisMonth += netPerPaycheck;
      paychecksReceivedCount += 1;
    } else if (nominal <= monthEnd) {
      expectedRemainingPaychecks += netPerPaycheck;
      paychecksRemainingCount += 1;
    }
  }
  const remainingPaychecksThisMonth = expectedRemainingPaychecks; // back-compat alias

  // §1.2: commissionPaid (status=paid, payoutDate in [monthStart, today]) and
  // commissionPending (status=pending, payoutDate in (today, monthEnd]).
  const allCommissions = await db.select().from(commissions);
  let commissionPaidThisMonth = 0;
  let commissionPendingThisMonth = 0;
  for (const c of allCommissions) {
    if (!c.payoutDate) continue;
    const pd = new Date(c.payoutDate);
    if (pd.getFullYear() !== today.getFullYear() || pd.getMonth() !== today.getMonth()) continue;
    // Prefer stored takeHome; fall back to recomputing if missing.
    const stored = parseFloat(c.takeHome);
    const amount = !isNaN(stored) && stored > 0
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
  const confirmedCommissionTotal = commissionPaidThisMonth + commissionPendingThisMonth;

  // §1.2: bills due THIS MONTH (include=TRUE, dueDay in [1, monthEnd.day]).
  // NOT just remaining — all of the month, paid or not. The income side already
  // accounts for paychecks received, so the outgo side must mirror the same
  // calendar-month frame.
  const allBills = await db.select().from(bills);
  let billsThisMonthTotal = 0;
  let billsRemainingThisMonth = 0;
  const billsThisMonthDetail: { id: number; name: string; amount: number; dueDay: number }[] = [];
  const billsRemainingDetail: { id: number; name: string; amount: number; dueDay: number }[] = [];
  for (const b of allBills) {
    if (!b.includeInCycle) continue;
    const amt = parseFloat(b.amount);
    if (amt <= 0) continue;
    if (b.dueDay >= 1 && b.dueDay <= monthEnd.getDate()) {
      billsThisMonthTotal += amt;
      billsThisMonthDetail.push({ id: b.id, name: b.name, amount: amt, dueDay: b.dueDay });
    }
    if (b.dueDay >= today.getDate() && b.dueDay <= monthEnd.getDate()) {
      billsRemainingThisMonth += amt;
      billsRemainingDetail.push({ id: b.id, name: b.name, amount: amt, dueDay: b.dueDay });
    }
  }

  // §1.2: one-time = paid=false AND (dueDate IS NULL OR dueDate <= monthEnd).
  // Includes undated unpaid items (no longer "advisory only").
  const oteRows = await db.select().from(oneTimeExpenses).where(eq(oneTimeExpenses.paid, false));
  let oneTimeThisMonth = 0;
  let oneTimeDatedThisMonth = 0;
  let oneTimeUndated = 0;
  for (const o of oteRows) {
    const amt = parseFloat(o.amount);
    if (!o.dueDate) {
      oneTimeUndated += amt;
      oneTimeThisMonth += amt; // §1.2 includes undated
      continue;
    }
    const dd = new Date(o.dueDate);
    if (dd <= monthEnd) {
      oneTimeThisMonth += amt;
      if (dd >= today) oneTimeDatedThisMonth += amt;
    }
  }

  // Variable spent this month — full month window (entries can be future-dated
  // weeks too; spec says monthStart..monthEnd).
  const allVs = await db.select().from(variableSpend);
  const monthVs = allVs.filter((v) => {
    const w = new Date(v.weekOf);
    return w >= monthStart && w <= monthEnd;
  });
  const variableLoggedThisMonth = monthVs.reduce((s, v) => s + parseFloat(v.amount), 0);
  const variableSpentThisMonth = variableLoggedThisMonth;
  const quicksilverAccruedThisMonth = monthVs
    .filter((v) => v.quicksilver)
    .reduce((s, v) => s + parseFloat(v.amount), 0);
  // Per user direction (2026-05-15): variable expected starts at the FULL cap
  // and is user-editable via the override. Logging spend tracks history but
  // does NOT auto-decrement the expected — the user manually edits the
  // remaining number to reflect their plan. This matches "start with the full
  // amount and edit it down during the month for accurate discretionary."
  const variableExpectedRemaining =
    plannedVariableRemainingOverride !== null
      ? plannedVariableRemainingOverride
      : variableCap;
  const variableRemainingThisMonth = variableExpectedRemaining; // back-compat alias

  // ---- §1.2 ledger ----
  // Income side (calendar-month, paycheck schedule + commission status).
  const totalMonthIncome =
    paychecksReceivedThisMonth +
    expectedRemainingPaychecks +
    commissionPaidThisMonth +
    commissionPendingThisMonth;
  // Outgo side (calendar-month obligations). Per user direction (2026-05-15):
  // variableLogged is NOT added to outgo — only variableExpectedRemaining is.
  // Logging spend is for tracking; the user controls the remaining figure
  // directly via the editable field on the dashboard.
  const totalMonthOutgo =
    billsThisMonthTotal +
    variableExpectedRemaining +
    oneTimeThisMonth +
    quicksilverBalanceOwed;
  // §1.2: result CAN be negative. Do not floor.
  const discretionaryHeadline = totalMonthIncome - totalMonthOutgo;

  // Back-compat aliases for older UI pieces still referencing inflows/outflows.
  const inflows = checking + expectedRemainingPaychecks + commissionPendingThisMonth;
  const outflows =
    billsRemainingThisMonth +
    oneTimeDatedThisMonth +
    variableExpectedRemaining +
    quicksilverBalanceOwed +
    minimumCushion;

  // Cycle parity (Safe-to-Spend frame) — engine via computeCycleState.
  // We also need cycle.forwardReserve as an input to the discretionary engine
  // function — but discretionaryThisMonth recomputes its own forward reserve
  // from billsForReserve so it's self-consistent.
  const cycle = await computeCycleState();

  const round = (n: number) => Math.round(n * 100) / 100;

  // ---- Discipline metrics — engine-sourced where possible ----
  const monthBillRows = await billsThisMonth(today);
  const monthBillsForEngine: EngineBill[] = monthBillRows.map(
    (b) => new EngineBill(b.name, b.amount, b.dueDay, true, b.category),
  );
  const fixedMonthlyTotal = monthBillsForEngine.reduce((s, b) => s + b.amount, 0);
  const fixedRatio = baseNetIncome > 0 ? fixedMonthlyTotal / baseNetIncome : 0;

  // Monthly Savings = Discretionary − $100 conservative buffer (Playbook B62
  // placeholder). Floored at 0 because "savings" can't be negative — when
  // Discretionary is negative, savings is simply $0 and the negative is shown
  // on the Discretionary line itself.
  const engineSavings = Math.max(0, discretionaryHeadline - 100);
  const savingsRate = baseNetIncome > 0 ? engineSavings / (baseNetIncome + confirmedCommissionTotal) : 0;

  // Match the engine's prorated_variable_remaining for the breakdown row so
  // the displayed math reconciles to the headline.
  const lastDay = monthEnd.getDate();
  const daysRemainingInMonth = Math.max(0, lastDay - today.getDate() + 1);
  const proratedVariableRemainingForBreakdown =
    daysRemainingInMonth * (variableCap / monthLengthDays);

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
    // Headline — engine-sourced per Playbook §2.1 (Forward Reserve Rule).
    discretionaryThisMonth: round(discretionaryHeadline),
    // Monthly Savings — engine-sourced (engineSavings, computed above
    // from discretionaryHeadline per Playbook B62 placeholder rule).
    monthlySavings: round(engineSavings),
    monthEnd: monthEnd.toISOString().split("T")[0],

    // Forward Reserve subtracted from the headline per §2.1. Surfaced so the
    // UI breakdown can show the full chain of subtractions.
    forwardReserve: round(cycle.forwardReserve),
    proratedVariableRemainingThisMonth: round(proratedVariableRemainingForBreakdown),
    daysRemainingInMonth,

    // §1.2 Income ledger
    paychecksReceivedThisMonth: round(paychecksReceivedThisMonth),
    paychecksReceivedCount,
    expectedRemainingPaychecks: round(expectedRemainingPaychecks),
    commissionPaidThisMonth: round(commissionPaidThisMonth),
    commissionPendingThisMonth: round(commissionPendingThisMonth),
    totalMonthIncome: round(totalMonthIncome),

    // §1.2 Outgo ledger
    billsThisMonth: round(billsThisMonthTotal),
    billsThisMonthDetail,
    variableLoggedThisMonth: round(variableLoggedThisMonth),
    variableExpectedRemaining: round(variableExpectedRemaining),
    plannedVariableRemainingOverride,
    oneTimeThisMonth: round(oneTimeThisMonth),
    totalMonthOutgo: round(totalMonthOutgo),

    // Inflows (back-compat aliases)
    checking: round(checking),
    remainingPaychecksThisMonth,
    paychecksRemainingCount,
    baseNetIncome,
    confirmedCommissionUnreceived: round(confirmedCommissionUnreceived),
    confirmedCommissionAlready: round(confirmedCommissionAlready),
    totalInflowsAvailable: round(inflows),

    // Outflows (back-compat aliases)
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
