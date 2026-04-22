import { Router, type IRouter } from "express";
import {
  GetDashboardCycleResponse,
  GetMonthlySavingsResponse,
} from "@workspace/api-zod";
import { computeCycleState, computeMonthlySavings } from "../lib/financeEngine";
import { db, oneTimeExpenses, variableSpend, bills, assumptions } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

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

// Discretionary breakdown — returns the components that make up
// "Discretionary This Cycle" (Safe to Spend minus already-spent variable).
router.get("/dashboard/discretionary", async (_req, res): Promise<void> => {
  const cycle = await computeCycleState();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  // Determine cycle window: from the most-recent past payday (or month start
  // if unknown) through today. We approximate "last payday" as the next payday
  // minus 14 days when known, else use month start.
  let cycleStart: Date = monthStart;
  if (cycle.nextPayday) {
    const np = new Date(cycle.nextPayday);
    const lp = new Date(np);
    lp.setDate(lp.getDate() - 14);
    if (lp <= today) cycleStart = lp;
  }

  const allVs = await db.select().from(variableSpend);

  // Cycle-window variable spend (canonical input for Discretionary)
  const cycleVs = allVs.filter((v) => {
    const d = new Date(v.weekOf);
    return d >= cycleStart && d <= today;
  });
  const variableSpentThisCycle = cycleVs.reduce((s, v) => s + parseFloat(v.amount), 0);

  // Month-window (informational: cap progress + QuickSilver accrual)
  const monthVs = allVs.filter((v) => new Date(v.weekOf) >= monthStart && new Date(v.weekOf) <= today);
  const variableSpentMonth = monthVs.reduce((s, v) => s + parseFloat(v.amount), 0);
  const quicksilverAccrued = monthVs.filter((v) => v.quicksilver).reduce((s, v) => s + parseFloat(v.amount), 0);

  const [varCapRow] = await db.select().from(assumptions).where(eq(assumptions.key, "variable_spend_cap"));
  const variableCap = varCapRow ? parseFloat(varCapRow.value) : 600;
  const variableRemaining = Math.max(0, variableCap - variableSpentMonth);

  // Unpaid one-time expenses with no due-date (advisory only — not in cycle hold)
  const oteRows = await db.select().from(oneTimeExpenses).where(eq(oneTimeExpenses.paid, false));
  const undatedOneTime = oteRows.filter((o) => !o.dueDate).reduce((s, o) => s + parseFloat(o.amount), 0);

  // Canonical Discretionary This Cycle: Safe to Spend minus log-derived
  // variable already spent this cycle. Always >= 0.
  const discretionaryThisCycle = Math.max(0, cycle.safeToSpend - variableSpentThisCycle);

  res.json({
    safeToSpend: cycle.safeToSpend,
    cycleStart: cycleStart.toISOString().split("T")[0],
    variableSpentThisCycle: Math.round(variableSpentThisCycle * 100) / 100,
    variableSpentThisMonth: Math.round(variableSpentMonth * 100) / 100,
    variableCap,
    variableRemainingThisMonth: Math.round(variableRemaining * 100) / 100,
    quicksilverAccruedThisMonth: Math.round(quicksilverAccrued * 100) / 100,
    discretionaryThisCycle: Math.round(discretionaryThisCycle * 100) / 100,
    undatedOneTimeOutstanding: Math.round(undatedOneTime * 100) / 100,
    // Kept for transparency — assumption-based estimate (not authoritative)
    variableSpendUntilPaydayAssumption: cycle.variableSpendUntilPayday,
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
