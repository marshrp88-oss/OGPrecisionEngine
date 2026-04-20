import { Router, type IRouter } from "express";
import { db, integrityLog, bills, assumptions, retirementPlan, balances, playbookVersions } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  RunIntegrityCheckResponse,
  GetIntegrityHistoryResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

interface Check {
  checkNumber: number;
  description: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  // Check 1: Last balance update freshness
  const [latestBalance] = await db.select().from(balances).orderBy(desc(balances.asOfDate)).limit(1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (!latestBalance) {
    checks.push({ checkNumber: 1, description: "Balance data exists", status: "fail", detail: "No balance data found. Enter current checking balance." });
  } else {
    const days = Math.floor((today.getTime() - new Date(latestBalance.asOfDate).getTime()) / (1000 * 60 * 60 * 24));
    if (days > 3) {
      checks.push({ checkNumber: 1, description: "Balance data freshness", status: "fail", detail: `Balance last updated ${days} days ago. Update required (must be ≤3 days).` });
    } else {
      checks.push({ checkNumber: 1, description: "Balance data freshness", status: "pass", detail: `Balance updated ${days} day(s) ago. OK.` });
    }
  }

  // Check 2: Next payday date exists and is not past
  const [payRow] = await db.select().from(assumptions).where(eq(assumptions.key, "next_payday_date"));
  if (!payRow || !payRow.value) {
    checks.push({ checkNumber: 2, description: "Next payday date set", status: "fail", detail: "Next payday date not configured. Set it in Settings." });
  } else {
    const payday = new Date(payRow.value);
    if (payday < today) {
      checks.push({ checkNumber: 2, description: "Next payday date is current", status: "fail", detail: `Next payday date (${payRow.value}) is in the past. Update it.` });
    } else {
      checks.push({ checkNumber: 2, description: "Next payday date is current", status: "pass", detail: `Next payday: ${payRow.value}.` });
    }
  }

  // Check 3: Base net income is set
  const [baseIncomeRow] = await db.select().from(assumptions).where(eq(assumptions.key, "base_net_income"));
  if (!baseIncomeRow || parseFloat(baseIncomeRow.value) <= 0) {
    checks.push({ checkNumber: 3, description: "Base net income configured", status: "fail", detail: "Base net income is not set or zero. Configure in Settings." });
  } else {
    checks.push({ checkNumber: 3, description: "Base net income configured", status: "pass", detail: `Base net income: $${parseFloat(baseIncomeRow.value).toFixed(2)}/mo.` });
  }

  // Check 4: At least one include=TRUE bill exists
  const allBills = await db.select().from(bills);
  const activeBills = allBills.filter((b) => b.includeInCycle);
  if (activeBills.length === 0) {
    checks.push({ checkNumber: 4, description: "Active bills configured", status: "warn", detail: "No bills marked Include=TRUE. Add your recurring bills." });
  } else {
    checks.push({ checkNumber: 4, description: "Active bills configured", status: "pass", detail: `${activeBills.length} active bill(s) configured.` });
  }

  // Check 5: Car loan row (if exists) should be Include=FALSE
  const carLoanBill = allBills.find((b) => b.name.toLowerCase().includes("car loan") || b.name.toLowerCase().includes("car payment"));
  if (carLoanBill && carLoanBill.includeInCycle) {
    checks.push({ checkNumber: 5, description: "Car loan eliminated (Include=FALSE)", status: "warn", detail: "Car loan bill has Include=TRUE. If lien was paid March 2026, set Include=FALSE." });
  } else {
    checks.push({ checkNumber: 5, description: "Car loan status", status: "pass", detail: carLoanBill ? "Car loan bill exists with Include=FALSE (correct)." : "No car loan bill found (OK if eliminated)." });
  }

  // Check 6: Alert threshold is set
  const [alertRow] = await db.select().from(assumptions).where(eq(assumptions.key, "alert_threshold"));
  const alertThreshold = alertRow ? parseFloat(alertRow.value) : 0;
  if (!alertRow || alertThreshold <= 0) {
    checks.push({ checkNumber: 6, description: "Alert threshold configured", status: "warn", detail: "Alert threshold not set. Default $400. Configure in Settings." });
  } else {
    checks.push({ checkNumber: 6, description: "Alert threshold configured", status: "pass", detail: `YELLOW threshold: $${alertThreshold}.` });
  }

  // Check 7: Variable spend cap is set
  const [varCapRow] = await db.select().from(assumptions).where(eq(assumptions.key, "variable_spend_cap"));
  if (!varCapRow || parseFloat(varCapRow.value) <= 0) {
    checks.push({ checkNumber: 7, description: "Variable spend cap configured", status: "warn", detail: "Variable spend cap not set. Default $600/mo. Configure in Settings." });
  } else {
    checks.push({ checkNumber: 7, description: "Variable spend cap configured", status: "pass", detail: `Variable cap: $${parseFloat(varCapRow.value)}/mo.` });
  }

  // Check 8: HYSA target is set
  const [hysaTargetRow] = await db.select().from(assumptions).where(eq(assumptions.key, "hysa_target"));
  if (!hysaTargetRow || parseFloat(hysaTargetRow.value) <= 0) {
    checks.push({ checkNumber: 8, description: "HYSA target configured", status: "warn", detail: "HYSA target not set. Default $15,000. Configure in Settings." });
  } else {
    checks.push({ checkNumber: 8, description: "HYSA target configured", status: "pass", detail: `HYSA target: $${parseFloat(hysaTargetRow.value).toLocaleString()}.` });
  }

  // Check 9: Retirement plan is configured
  const [ret] = await db.select().from(retirementPlan).limit(1);
  if (!ret) {
    checks.push({ checkNumber: 9, description: "Retirement plan configured", status: "warn", detail: "No retirement plan configured. Go to Retirement Planning." });
  } else {
    const contribRate = parseFloat(ret.contributionRate) * 100;
    const matchCap = parseFloat(ret.employerMatchCap) * 100;
    if (contribRate < matchCap) {
      checks.push({ checkNumber: 9, description: "401(k) match captured", status: "warn", detail: `Contributing ${contribRate}% vs ${matchCap}% match cap. $540/yr in free money uncaptured.` });
    } else {
      checks.push({ checkNumber: 9, description: "401(k) match captured", status: "pass", detail: "Contributing at or above match cap. Full employer match captured." });
    }
  }

  // Check 10: Playbook is loaded
  const [playbook] = await db.select().from(playbookVersions).orderBy(desc(playbookVersions.effectiveFrom)).limit(1);
  if (!playbook) {
    checks.push({ checkNumber: 10, description: "Playbook loaded", status: "warn", detail: "No playbook version found." });
  } else {
    checks.push({ checkNumber: 10, description: "Playbook loaded", status: "pass", detail: `Playbook v${playbook.version} loaded.` });
  }

  return checks;
}

router.post("/integrity/check", async (_req, res): Promise<void> => {
  const checks = await runChecks();
  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;

  let overallStatus: "pass" | "fail" | "warn" = "pass";
  if (failCount > 0) overallStatus = "fail";
  else if (warnCount > 0) overallStatus = "warn";

  const [logged] = await db
    .insert(integrityLog)
    .values({
      overallStatus,
      checksJson: checks,
      notes: `${failCount} failures, ${warnCount} warnings`,
    })
    .returning();

  res.json(
    RunIntegrityCheckResponse.parse({
      id: logged?.id ?? 0,
      runAt: logged?.runAt ?? new Date(),
      overallStatus,
      checks,
      notes: `${failCount} failures, ${warnCount} warnings`,
    })
  );
});

router.get("/integrity/history", async (_req, res): Promise<void> => {
  const rows = await db.select().from(integrityLog).orderBy(desc(integrityLog.runAt)).limit(20);
  const parsed = rows.map((r) => ({
    id: r.id,
    runAt: r.runAt,
    overallStatus: r.overallStatus as "pass" | "fail" | "warn",
    checks: r.checksJson as unknown[],
    notes: r.notes,
  }));
  res.json(GetIntegrityHistoryResponse.parse(parsed));
});

export default router;
