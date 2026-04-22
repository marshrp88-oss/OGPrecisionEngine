import {
  db,
  integrityLog,
  bills,
  assumptions,
  retirementPlan,
  balances,
  playbookVersions,
  oneTimeExpenses,
  variableSpend,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { computeCycleState } from "./financeEngine";
import { billsInCycle, billsThisMonth } from "./cycleBillEngine";
import { logger } from "./logger";

export interface IntegrityCheck {
  checkNumber: number;
  description: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

export interface IntegrityRunResult {
  id: number;
  runAt: Date;
  overallStatus: "pass" | "fail" | "warn";
  checks: IntegrityCheck[];
  notes: string;
}

const CENT = 0.005;

async function runChecks(): Promise<IntegrityCheck[]> {
  const checks: IntegrityCheck[] = [];

  const [latestBalance] = await db
    .select()
    .from(balances)
    .orderBy(desc(balances.asOfDate))
    .limit(1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (!latestBalance) {
    checks.push({
      checkNumber: 1,
      description: "Balance data exists",
      status: "fail",
      detail: "No balance data found. Enter current checking balance.",
    });
  } else {
    const days = Math.floor(
      (today.getTime() - new Date(latestBalance.asOfDate).getTime()) /
        (1000 * 60 * 60 * 24),
    );
    if (days > 3) {
      checks.push({
        checkNumber: 1,
        description: "Balance data freshness",
        status: "fail",
        detail: `Balance last updated ${days} days ago. Update required (must be ≤3 days).`,
      });
    } else {
      checks.push({
        checkNumber: 1,
        description: "Balance data freshness",
        status: "pass",
        detail: `Balance updated ${days} day(s) ago. OK.`,
      });
    }
  }

  const [payRow] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "next_payday_date"));
  if (!payRow || !payRow.value) {
    checks.push({
      checkNumber: 2,
      description: "Next payday date set",
      status: "fail",
      detail: "Next payday date not configured. Set it in Settings.",
    });
  } else {
    const payday = new Date(payRow.value);
    if (payday < today) {
      checks.push({
        checkNumber: 2,
        description: "Next payday date is current",
        status: "fail",
        detail: `Next payday date (${payRow.value}) is in the past. Update it.`,
      });
    } else {
      checks.push({
        checkNumber: 2,
        description: "Next payday date is current",
        status: "pass",
        detail: `Next payday: ${payRow.value}.`,
      });
    }
  }

  const [baseIncomeRow] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "base_net_income"));
  if (!baseIncomeRow || parseFloat(baseIncomeRow.value) <= 0) {
    checks.push({
      checkNumber: 3,
      description: "Base net income configured",
      status: "fail",
      detail: "Base net income is not set or zero. Configure in Settings.",
    });
  } else {
    checks.push({
      checkNumber: 3,
      description: "Base net income configured",
      status: "pass",
      detail: `Base net income: $${parseFloat(baseIncomeRow.value).toFixed(2)}/mo.`,
    });
  }

  const allBills = await db.select().from(bills);
  const activeBills = allBills.filter((b) => b.includeInCycle);
  if (activeBills.length === 0) {
    checks.push({
      checkNumber: 4,
      description: "Active bills configured",
      status: "warn",
      detail: "No bills marked Include=TRUE. Add your recurring bills.",
    });
  } else {
    checks.push({
      checkNumber: 4,
      description: "Active bills configured",
      status: "pass",
      detail: `${activeBills.length} active bill(s) configured.`,
    });
  }

  const carLoanBill = allBills.find(
    (b) =>
      b.name.toLowerCase().includes("car loan") ||
      b.name.toLowerCase().includes("car payment"),
  );
  if (carLoanBill && carLoanBill.includeInCycle) {
    checks.push({
      checkNumber: 5,
      description: "Car loan eliminated (Include=FALSE)",
      status: "warn",
      detail:
        "Car loan bill has Include=TRUE. If lien was paid March 2026, set Include=FALSE.",
    });
  } else {
    checks.push({
      checkNumber: 5,
      description: "Car loan status",
      status: "pass",
      detail: carLoanBill
        ? "Car loan bill exists with Include=FALSE (correct)."
        : "No car loan bill found (OK if eliminated).",
    });
  }

  const [alertRow] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "alert_threshold"));
  const alertThreshold = alertRow ? parseFloat(alertRow.value) : 0;
  if (!alertRow || alertThreshold <= 0) {
    checks.push({
      checkNumber: 6,
      description: "Alert threshold configured",
      status: "warn",
      detail: "Alert threshold not set. Default $400. Configure in Settings.",
    });
  } else {
    checks.push({
      checkNumber: 6,
      description: "Alert threshold configured",
      status: "pass",
      detail: `YELLOW threshold: $${alertThreshold}.`,
    });
  }

  const [varCapRow] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "variable_spend_cap"));
  if (!varCapRow || parseFloat(varCapRow.value) <= 0) {
    checks.push({
      checkNumber: 7,
      description: "Variable spend cap configured",
      status: "warn",
      detail:
        "Variable spend cap not set. Default $600/mo. Configure in Settings.",
    });
  } else {
    checks.push({
      checkNumber: 7,
      description: "Variable spend cap configured",
      status: "pass",
      detail: `Variable cap: $${parseFloat(varCapRow.value)}/mo.`,
    });
  }

  const [hysaTargetRow] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "hysa_target"));
  if (!hysaTargetRow || parseFloat(hysaTargetRow.value) <= 0) {
    checks.push({
      checkNumber: 8,
      description: "HYSA target configured",
      status: "warn",
      detail: "HYSA target not set. Default $15,000. Configure in Settings.",
    });
  } else {
    checks.push({
      checkNumber: 8,
      description: "HYSA target configured",
      status: "pass",
      detail: `HYSA target: $${parseFloat(hysaTargetRow.value).toLocaleString()}.`,
    });
  }

  const [ret] = await db.select().from(retirementPlan).limit(1);
  if (!ret) {
    checks.push({
      checkNumber: 9,
      description: "Retirement plan configured",
      status: "warn",
      detail: "No retirement plan configured. Go to Retirement Planning.",
    });
  } else {
    const contribRate = parseFloat(ret.contributionRate) * 100;
    const matchCap = parseFloat(ret.employerMatchCap) * 100;
    if (contribRate < matchCap) {
      checks.push({
        checkNumber: 9,
        description: "401(k) match captured",
        status: "warn",
        detail: `Contributing ${contribRate}% vs ${matchCap}% match cap. $540/yr in free money uncaptured.`,
      });
    } else {
      checks.push({
        checkNumber: 9,
        description: "401(k) match captured",
        status: "pass",
        detail:
          "Contributing at or above match cap. Full employer match captured.",
      });
    }
  }

  const [playbook] = await db
    .select()
    .from(playbookVersions)
    .orderBy(desc(playbookVersions.effectiveFrom))
    .limit(1);
  if (!playbook) {
    checks.push({
      checkNumber: 10,
      description: "Playbook loaded",
      status: "warn",
      detail: "No playbook version found.",
    });
  } else {
    checks.push({
      checkNumber: 10,
      description: "Playbook loaded",
      status: "pass",
      detail: `Playbook v${playbook.version} loaded.`,
    });
  }

  // Check 11: Cycle math invariant — independently recompute from raw DB and
  // verify Checking = RequiredHold + SafeToSpend (when not underwater).
  // This catches silent drift between the engine and source-of-truth state.
  try {
    const cycle = await computeCycleState();
    const cycleBills = await billsInCycle(today);
    const billsTotal = cycleBills.reduce((s, b) => s + b.amount, 0);

    const pendingRow = await db
      .select()
      .from(assumptions)
      .where(eq(assumptions.key, "pending_holds_reserve"))
      .then(([r]) => (r ? parseFloat(r.value) : 0));
    const cushionRow = await db
      .select()
      .from(assumptions)
      .where(eq(assumptions.key, "minimum_cushion"))
      .then(([r]) => (r ? parseFloat(r.value) : 0));

    const oneTimeRows = await db.select().from(oneTimeExpenses);
    const nextPaydayMs = new Date(cycle.nextPayday).getTime();
    const oneTimeBeforePayday = oneTimeRows.reduce((s, ote) => {
      if (ote.paid || !ote.dueDate) return s;
      const amt = parseFloat(ote.amount);
      if (amt <= 0) return s;
      const due = new Date(ote.dueDate).getTime();
      if (due >= today.getTime() && due <= nextPaydayMs) return s + amt;
      return s;
    }, 0);

    const expectedHold =
      billsTotal + pendingRow + cushionRow + oneTimeBeforePayday;
    const expectedSafe = Math.max(0, cycle.checkingBalance - expectedHold);

    const holdDelta = Math.abs(cycle.totalRequiredHold - expectedHold);
    const safeDelta = Math.abs(cycle.safeToSpend - expectedSafe);

    if (holdDelta > CENT || safeDelta > CENT) {
      checks.push({
        checkNumber: 11,
        description: "Cycle math invariant",
        status: "fail",
        detail: `Engine drift detected. RequiredHold delta $${holdDelta.toFixed(2)}, SafeToSpend delta $${safeDelta.toFixed(2)}. Engine output does not match independent recomputation from raw DB.`,
      });
    } else if (cycle.checkingBalance < expectedHold) {
      const underBy = expectedHold - cycle.checkingBalance;
      checks.push({
        checkNumber: 11,
        description: "Cycle math invariant",
        status: "fail",
        detail: `Underwater by $${underBy.toFixed(2)}. Required Hold ($${expectedHold.toFixed(2)}) exceeds checking balance ($${cycle.checkingBalance.toFixed(2)}). Safe-to-Spend clamped to $0; this cycle cannot fund itself.`,
      });
    } else {
      checks.push({
        checkNumber: 11,
        description: "Cycle math invariant",
        status: "pass",
        detail: `Checking $${cycle.checkingBalance.toFixed(2)} = Required Hold $${expectedHold.toFixed(2)} + Safe-to-Spend $${expectedSafe.toFixed(2)}. Engine matches raw DB.`,
      });
    }
  } catch (err) {
    checks.push({
      checkNumber: 11,
      description: "Cycle math invariant",
      status: "fail",
      detail: `Could not verify invariant: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Check 12: Variable spending burn pace.
  // Compares actual variable_spend MTD vs the prorated cap for today's day-of-month.
  // Pace = actual / (cap * dayOfMonth/daysInMonth). Warn >110%, fail >150%.
  // This is the playbook's primary discretionary discipline signal.
  try {
    const [varCap2] = await db
      .select()
      .from(assumptions)
      .where(eq(assumptions.key, "variable_spend_cap"));
    const cap = varCap2 ? parseFloat(varCap2.value) : 600;
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const dayOfMonth = today.getDate();
    const daysInMonth = monthEnd.getDate();
    const allVs = await db.select().from(variableSpend);
    const actual = allVs
      .filter((v) => {
        const d = new Date(v.weekOf);
        return d >= monthStart && d <= today;
      })
      .reduce((s, v) => s + parseFloat(v.amount), 0);
    const expectedByNow = (cap * dayOfMonth) / daysInMonth;
    const pace = expectedByNow > 0 ? actual / expectedByNow : 0;
    const pacePct = Math.round(pace * 100);
    if (pace > 1.5) {
      checks.push({
        checkNumber: 12,
        description: "Variable burn pace",
        status: "fail",
        detail: `Burning at ${pacePct}% of pace. Spent $${actual.toFixed(2)} MTD vs $${expectedByNow.toFixed(2)} expected by day ${dayOfMonth}/${daysInMonth}. Cap will blow.`,
      });
    } else if (pace > 1.1) {
      checks.push({
        checkNumber: 12,
        description: "Variable burn pace",
        status: "warn",
        detail: `Burning at ${pacePct}% of pace. Spent $${actual.toFixed(2)} MTD vs $${expectedByNow.toFixed(2)} expected by day ${dayOfMonth}/${daysInMonth}. Pull back.`,
      });
    } else {
      checks.push({
        checkNumber: 12,
        description: "Variable burn pace",
        status: "pass",
        detail: `On pace at ${pacePct}%. Spent $${actual.toFixed(2)} MTD of $${cap.toFixed(2)}/mo cap (day ${dayOfMonth}/${daysInMonth}).`,
      });
    }
  } catch (err) {
    checks.push({
      checkNumber: 12,
      description: "Variable burn pace",
      status: "skip",
      detail: `Could not compute pace: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Check 13: Fixed obligations as % of net income.
  // Playbook discipline target: fixed bills ≤ 50% of net income (warn >50%, fail >65%).
  // High fixed ratio = brittle cycle, no slack to absorb commission misses.
  try {
    const [incRow2] = await db
      .select()
      .from(assumptions)
      .where(eq(assumptions.key, "base_net_income"));
    const netIncome = incRow2 ? parseFloat(incRow2.value) : 0;
    const monthBills = await billsThisMonth(today);
    const fixedTotal = monthBills.reduce((s, b) => s + b.amount, 0);
    if (netIncome <= 0) {
      checks.push({
        checkNumber: 13,
        description: "Fixed-to-income ratio",
        status: "skip",
        detail: "Net income not configured; cannot compute ratio.",
      });
    } else {
      const ratio = fixedTotal / netIncome;
      const pct = Math.round(ratio * 100);
      if (ratio > 0.65) {
        checks.push({
          checkNumber: 13,
          description: "Fixed-to-income ratio",
          status: "fail",
          detail: `Fixed obligations ${pct}% of net income ($${fixedTotal.toFixed(2)} of $${netIncome.toFixed(2)}). Target ≤50%. Cycle is brittle.`,
        });
      } else if (ratio > 0.5) {
        checks.push({
          checkNumber: 13,
          description: "Fixed-to-income ratio",
          status: "warn",
          detail: `Fixed obligations ${pct}% of net income ($${fixedTotal.toFixed(2)} of $${netIncome.toFixed(2)}). Above 50% target.`,
        });
      } else {
        checks.push({
          checkNumber: 13,
          description: "Fixed-to-income ratio",
          status: "pass",
          detail: `Fixed obligations ${pct}% of net income ($${fixedTotal.toFixed(2)} of $${netIncome.toFixed(2)}). Within 50% target.`,
        });
      }
    }
  } catch (err) {
    checks.push({
      checkNumber: 13,
      description: "Fixed-to-income ratio",
      status: "skip",
      detail: `Could not compute ratio: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return checks;
}

export async function runIntegrityAndPersist(
  trigger: string,
): Promise<IntegrityRunResult> {
  const checks = await runChecks();
  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;

  let overallStatus: "pass" | "fail" | "warn" = "pass";
  if (failCount > 0) overallStatus = "fail";
  else if (warnCount > 0) overallStatus = "warn";

  const notes = `${failCount} failures, ${warnCount} warnings (trigger: ${trigger})`;

  const [logged] = await db
    .insert(integrityLog)
    .values({ overallStatus, checksJson: checks, notes })
    .returning();

  return {
    id: logged?.id ?? 0,
    runAt: logged?.runAt ?? new Date(),
    overallStatus,
    checks,
    notes,
  };
}

export async function getLatestIntegrityResult(): Promise<IntegrityRunResult | null> {
  const [row] = await db
    .select()
    .from(integrityLog)
    .orderBy(desc(integrityLog.runAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    runAt: row.runAt,
    overallStatus: row.overallStatus as "pass" | "fail" | "warn",
    checks: row.checksJson as IntegrityCheck[],
    notes: row.notes ?? "",
  };
}

/** Fire-and-forget revalidation. Never throws to caller. */
export function scheduleIntegrityRevalidation(trigger: string): void {
  setImmediate(() => {
    runIntegrityAndPersist(trigger).catch((err) => {
      logger.warn(
        { err, trigger },
        "Background integrity revalidation failed",
      );
    });
  });
}
