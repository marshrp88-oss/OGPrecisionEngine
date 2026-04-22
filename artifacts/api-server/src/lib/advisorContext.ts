import { db } from "@workspace/db";
import {
  assumptions,
  bills,
  balances,
  commissions,
  oneTimeExpenses,
  variableSpend,
  retirementPlan,
  debt,
  creditScores,
  wealthSnapshots,
  playbookVersions,
} from "@workspace/db";
import { desc, asc } from "drizzle-orm";
import { computeCycleState, computeMonthlySavings, effectivePayday, computeMrrPayout, computeNrrPayout, computeTakeHome } from "./financeEngine";

function fmt(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pct(n: number, d = 1): string {
  return `${(n * 100).toFixed(d)}%`;
}
function ymd(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().split("T")[0];
}

export interface IntegrityResult {
  results: { name: string; pass: boolean; detail: string }[];
  failureCount: number;
  overall: "PASS" | "DEGRADED";
}

async function runIntegrityChecks(ctx: {
  baseNetIncome: number;
  daysSinceUpdate: number | null;
  daysUntilPayday: number | null;
  hasIncludedBill: boolean;
  forwardReserve: number;
  taxRate: number;
  variableCap: number;
  monthlySavings: number;
  matchGapNumber: boolean;
  noNegativeBills: boolean;
}): Promise<IntegrityResult> {
  const results = [
    { name: "Base net income set", pass: ctx.baseNetIncome > 0, detail: fmt(ctx.baseNetIncome) },
    { name: "Next payday is in future", pass: ctx.daysUntilPayday !== null && ctx.daysUntilPayday >= 0, detail: `${ctx.daysUntilPayday ?? "?"} days` },
    {
      name: "Last balance update ≤ 3 days old",
      pass: ctx.daysSinceUpdate !== null && ctx.daysSinceUpdate <= 3,
      detail: `${ctx.daysSinceUpdate ?? "?"} days`,
    },
    { name: "At least one bill Include=TRUE", pass: ctx.hasIncludedBill, detail: ctx.hasIncludedBill ? "yes" : "no" },
    { name: "Forward reserve computes non-negative", pass: ctx.forwardReserve >= 0, detail: fmt(ctx.forwardReserve) },
    { name: "Commission tax rate set", pass: ctx.taxRate > 0 && ctx.taxRate < 1, detail: pct(ctx.taxRate) },
    { name: "Variable spend cap set", pass: ctx.variableCap > 0, detail: fmt(ctx.variableCap) },
    { name: "Monthly Savings is a valid number", pass: !isNaN(ctx.monthlySavings), detail: fmt(ctx.monthlySavings) },
    { name: "401(k) match gap returns a number", pass: ctx.matchGapNumber, detail: ctx.matchGapNumber ? "ok" : "NaN" },
    { name: "No bill has negative amount", pass: ctx.noNegativeBills, detail: ctx.noNegativeBills ? "ok" : "negative found" },
  ];
  const failureCount = results.filter((r) => !r.pass).length;
  return {
    results,
    failureCount,
    overall: failureCount === 0 ? "PASS" : "DEGRADED",
  };
}

export async function buildAdvisorContext(): Promise<{
  systemPrompt: string;
  snapshot: Record<string, unknown>;
  integrity: IntegrityResult;
}> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cycle = await computeCycleState();
  const savings = await computeMonthlySavings();

  // Load assumptions
  const allAssumps = await db.select().from(assumptions);
  const lookup: Record<string, string> = {};
  for (const a of allAssumps) lookup[a.key] = a.value;
  const variableCap = parseFloat(lookup["variable_spend_cap"] ?? "600");
  const taxRate = parseFloat(lookup["commission_tax_rate"] ?? "0.435");
  const baseNet = parseFloat(lookup["base_net_income"] ?? "3220");
  const hysaTarget = parseFloat(lookup["hysa_target"] ?? "15000");
  const monthLength = parseFloat(lookup["month_length_days"] ?? "30.4");
  const alertThreshold = parseFloat(lookup["alert_threshold"] ?? "400");
  const minimumCushion = parseFloat(lookup["minimum_cushion"] ?? "0");
  const mrrTarget = parseFloat(lookup["mrr_target"] ?? "700");
  const nrrTarget = parseFloat(lookup["nrr_target"] ?? "6000");

  const allBalances = await db.select().from(balances).orderBy(desc(balances.asOfDate));
  const byType = new Map<string, typeof allBalances[number]>();
  for (const b of allBalances) {
    if (!byType.has(b.accountType)) byType.set(b.accountType, b);
  }
  const checkingRow = byType.get("checking");
  const hysaRow = byType.get("hysa");
  const brokerageRow = byType.get("brokerage");
  const k401Row = byType.get("401k");
  const rothRow = byType.get("roth_ira");

  const ret = (await db.select().from(retirementPlan).limit(1))[0];
  const debtRows = await db.select().from(debt);
  const carDebt = debtRows.find((d) => /car/i.test(d.name));
  const studentDebt = debtRows.find((d) => /student/i.test(d.name));

  const allBills = await db.select().from(bills).orderBy(asc(bills.dueDay));
  const includedBills = allBills.filter((b) => b.includeInCycle && parseFloat(b.amount) > 0);
  const fullMonthFixed = includedBills.reduce((s, b) => s + parseFloat(b.amount), 0);

  // Bills in current cycle hold
  const nextPayday = cycle.nextPayday;
  const billsInCycle: typeof allBills = [];
  for (const bill of includedBills) {
    let dueDate = new Date(today.getFullYear(), today.getMonth(), bill.dueDay);
    if (dueDate < today) dueDate = new Date(today.getFullYear(), today.getMonth() + 1, bill.dueDay);
    if (nextPayday && dueDate >= today && dueDate < nextPayday) billsInCycle.push(bill);
  }

  const allCommissions = await db.select().from(commissions).orderBy(desc(commissions.salesMonth));
  const last6 = allCommissions.slice(0, 6);
  const ytd = allCommissions.filter((c) => new Date(c.salesMonth).getFullYear() === today.getFullYear());
  const ytdTakeHome = ytd.reduce((s, c) => s + parseFloat(c.takeHome), 0);
  const last3 = allCommissions.slice(0, 3);
  const last3Avg = last3.length > 0 ? last3.reduce((s, c) => s + parseFloat(c.takeHome), 0) / last3.length : 0;
  const droughtMonths = allCommissions.slice(0, 3).filter((c) => parseFloat(c.takeHome) < 100).length;
  const droughtFlag = droughtMonths >= 2;

  const oneTimeRows = await db.select().from(oneTimeExpenses);
  const unpaidOneTime = oneTimeRows.filter((o) => !o.paid);

  const vsRows = await db.select().from(variableSpend).orderBy(desc(variableSpend.weekOf));
  const last4WeeksVs = vsRows.slice(0, 4);

  const credit = (await db.select().from(creditScores).orderBy(desc(creditScores.asOfDate)).limit(1))[0];
  const latestSnapshot = (await db.select().from(wealthSnapshots).orderBy(desc(wealthSnapshots.snapshotDate)).limit(1))[0];

  const playbook = (await db.select().from(playbookVersions).orderBy(desc(playbookVersions.effectiveFrom)).limit(1))[0];
  const playbookContent = playbook?.content ?? "(No playbook loaded.)";

  // 401(k) computation
  let k401Block = "Not configured.";
  if (ret) {
    const contribRate = parseFloat(ret.contributionRate);
    const multiplier = parseFloat(ret.employerMatchRate);
    const ceiling = parseFloat(ret.employerMatchCap);
    const grossSalary = parseFloat(ret.grossSalary);
    const eff = Math.min(contribRate, ceiling);
    const matchPct = eff * multiplier;
    const maxMatchPct = ceiling * multiplier;
    const annualCaptured = grossSalary * matchPct;
    const annualAvailable = grossSalary * maxMatchPct;
    const annualGap = annualAvailable - annualCaptured;
    k401Block = `${fmt(parseFloat(k401Row?.amount ?? "0"))} (contributing ${pct(contribRate)} of gross, employer match: ${pct(multiplier, 0)} of employee × ceiling ${pct(ceiling)} — capturing ${fmt(annualCaptured)}/yr, leaving ${fmt(annualGap)}/yr on the table)`;
  }

  // Compose live data snapshot string
  const checkingDays = checkingRow ? Math.floor((today.getTime() - new Date(checkingRow.asOfDate).getTime()) / 86400000) : null;
  const hysaBal = parseFloat(hysaRow?.amount ?? "0");
  const hysaGap = Math.max(0, hysaTarget - hysaBal);

  const lines: string[] = [];
  lines.push("=== LIVE DATA SNAPSHOT ===");
  lines.push(`Timestamp: ${new Date().toISOString()}`);
  lines.push(`Today's date: ${ymd(today)}`);
  lines.push(`Next nominal payday: ${ymd(cycle.nextPaydayNominal)}`);
  lines.push(`Next effective payday (weekend-adjusted): ${ymd(cycle.nextPayday)}`);
  lines.push(`Days until effective payday: ${cycle.daysUntilPayday}`);
  lines.push("");
  lines.push("ACCOUNTS:");
  lines.push(`- Checking: ${fmt(parseFloat(checkingRow?.amount ?? "0"))} (updated ${checkingDays} days ago)`);
  lines.push(`- HYSA: ${fmt(hysaBal)} / target ${fmt(hysaTarget)} (gap: ${fmt(hysaGap)}, ${hysaGap === 0 ? "MET" : "NOT MET"})`);
  lines.push(`- Brokerage: ${fmt(parseFloat(brokerageRow?.amount ?? "0"))}`);
  lines.push(`- 401(k): ${k401Block}`);
  lines.push(`- Roth IRA: ${fmt(parseFloat(rothRow?.amount ?? "0"))} (${parseFloat(rothRow?.amount ?? "0") > 0 ? "funded" : "unfunded"})`);
  if (carDebt) {
    lines.push(`- Debts: Car Loan ${fmt(parseFloat(carDebt.balance))} (${pct(parseFloat(carDebt.interestRate), 2)}, ${carDebt.status})${studentDebt ? `, Student Loans ${fmt(parseFloat(studentDebt.balance))} (${studentDebt.status})` : ""}`);
  }
  lines.push("");
  lines.push("ACTIVE BILLS (Include=TRUE only):");
  for (const b of includedBills) {
    lines.push(`- ${b.name}: ${fmt(parseFloat(b.amount))}, due day ${b.dueDay}, ${b.category}, autopay ${b.autopay ? "yes" : "no"}`);
  }
  lines.push(`Total monthly Include=TRUE: ${fmt(fullMonthFixed)}`);
  lines.push("");
  lines.push(`BILLS IN CURRENT CYCLE HOLD (due ${ymd(today)} → before ${ymd(cycle.nextPayday)}, strict <):`);
  if (billsInCycle.length === 0) {
    lines.push("- None (cycle hold is empty)");
  } else {
    for (const b of billsInCycle) lines.push(`- ${b.name}: ${fmt(parseFloat(b.amount))} (day ${b.dueDay})`);
  }
  lines.push(`Required Hold: ${fmt(cycle.totalRequiredHold)}`);
  lines.push(`Safe to Spend: ${fmt(cycle.safeToSpend)} (status ${cycle.status})`);
  lines.push(`Forward Reserve (next-month 1st-7th + 7d variable): ${fmt(cycle.forwardReserve)}`);
  lines.push(`Monthly Savings Estimate: ${fmt(savings.estimatedMonthlySavings)}`);
  lines.push("");
  lines.push("COMMISSION HISTORY (last 6):");
  for (const c of last6) {
    lines.push(`- ${c.salesMonth.toString().slice(0, 7)}: MRR ${fmt(parseFloat(c.mrrAchieved))}, NRR ${fmt(parseFloat(c.nrrAchieved))} → take-home ${fmt(parseFloat(c.takeHome))} (paid ${c.payoutDate ?? "?"}, ${c.status})`);
  }
  lines.push(`3-month rolling avg take-home: ${fmt(last3Avg)}`);
  lines.push(`YTD take-home: ${fmt(ytdTakeHome)}`);
  lines.push(`Drought flag: ${droughtFlag ? "ACTIVE" : "not active"} (${droughtMonths} of last 3 months below threshold)`);
  lines.push("");
  lines.push("ONE-TIME EXPENSES (unpaid):");
  if (unpaidOneTime.length === 0) lines.push("- None");
  else for (const o of unpaidOneTime) lines.push(`- ${o.name}: ${fmt(parseFloat(o.amount))} due ${o.dueDate ?? "NO DATE"}`);
  lines.push("");
  lines.push("VARIABLE SPEND LOG (last 4 entries):");
  if (last4WeeksVs.length === 0) lines.push("- No entries");
  else for (const v of last4WeeksVs) lines.push(`- ${v.weekOf} [${v.category}]: ${fmt(parseFloat(v.amount))}${v.quicksilver ? " (QuickSilver)" : ""}${v.notes ? ` — ${v.notes}` : ""}`);
  lines.push("");
  lines.push("CREDIT SCORES:");
  if (credit) {
    lines.push(`- Experian ${credit.experian}, Equifax ${credit.equifax}, TransUnion ${credit.transunion} (as of ${credit.asOfDate})`);
  }
  lines.push("");
  lines.push("LATEST WEALTH SNAPSHOT:");
  if (latestSnapshot) {
    lines.push(`- ${latestSnapshot.snapshotDate}: Net Worth ${fmt(parseFloat(latestSnapshot.netWorth))} (Assets ${fmt(parseFloat(latestSnapshot.totalAssets))}, Liabilities ${fmt(parseFloat(latestSnapshot.totalLiabilities))})`);
  }
  lines.push("");
  lines.push("CYCLE SETTINGS:");
  lines.push(`- Variable cap: ${fmt(variableCap)}/month (~${fmt(variableCap / monthLength)}/day)`);
  lines.push(`- YELLOW threshold: ${fmt(alertThreshold)}`);
  lines.push(`- Minimum cushion: ${fmt(minimumCushion)}`);
  lines.push(`- Month length: ${monthLength} days`);
  lines.push(`- Commission tax rate: ${pct(taxRate)}`);
  lines.push(`- MRR target: ${fmt(mrrTarget)}, NRR target: ${fmt(nrrTarget)}`);
  lines.push("=== END LIVE DATA SNAPSHOT ===");

  // Integrity checks
  const integrity = await runIntegrityChecks({
    baseNetIncome: baseNet,
    daysSinceUpdate: cycle.daysSinceUpdate,
    daysUntilPayday: cycle.daysUntilPayday,
    hasIncludedBill: includedBills.length > 0,
    forwardReserve: cycle.forwardReserve,
    taxRate,
    variableCap,
    monthlySavings: savings.estimatedMonthlySavings,
    matchGapNumber: !isNaN(savings.monthlyMatchGapCost),
    noNegativeBills: allBills.every((b) => parseFloat(b.amount) >= 0),
  });

  const integrityLines: string[] = ["=== SESSION INTEGRITY CHECK ==="];
  integrity.results.forEach((r, i) => {
    integrityLines.push(`${i + 1}. ${r.name}: ${r.pass ? "PASS" : "FAIL"} (${r.detail})`);
  });
  integrityLines.push(`Overall: ${integrity.overall}${integrity.failureCount > 0 ? ` (${integrity.failureCount} failures)` : ""}`);
  integrityLines.push("=== END INTEGRITY CHECK ===");

  const stalenessDirective =
    cycle.daysSinceUpdate !== null && cycle.daysSinceUpdate > 3
      ? `\n\nCRITICAL: The checking balance was last updated ${cycle.daysSinceUpdate} days ago. Do NOT perform any cycle-level analysis (Safe to Spend, daily rate, days of coverage, current cycle savings). Prompt Marshall to update the balance first. You may answer structural questions (retirement math, debt strategy, long-term projections) that do not depend on current cycle liquidity.`
      : "";

  const systemPrompt = `You are Marshall's dedicated financial advisor. You have full context on his financial system, methodology, and current data. You operate with precision, directness, and rigor. You do not soften bad news. You do not produce generic financial advice.

=== METHODOLOGY (Reserve Playbook v7.3) ===
${playbookContent}
=== END METHODOLOGY ===

=== CLIENT PROFILE ===
Marshall Roberts-Payne, age 30. Account Executive at Odoo Inc. with variable commission income on top of a base of ~$54,000 gross / ~$3,220 net biweekly-equivalent monthly. Self-managed brokerage at Schwab (SWPPX, AVUV, VXUS, IAU, IBIT, SGOV). Paid on the 7th and 22nd of each month. Federal student loans in deferral; auto loan with WNY FCU. Newly opened Roth IRA at Schwab.
=== END CLIENT PROFILE ===

${lines.join("\n")}

${integrityLines.join("\n")}

=== OPERATING RULES ===
1. Cite specific data points from the Live Data Snapshot for every numerical claim. Do not cite data not in the snapshot.
2. If the snapshot shows balance > 3 days old or any relevant integrity check has failed, refuse cycle-level questions and prompt Marshall to update first. Do not proceed with stale analysis.
3. Never assume commission income in forward-looking calculations unless Marshall explicitly opts in. Planning floor is always base net (${fmt(baseNet)}/mo).
4. Do not recommend specific investments, allocations, rebalances, or trades. The brokerage is self-managed.
5. Do not produce generic financial advice ("consider an emergency fund", "have you thought about a Roth?"). Marshall's strategy is already defined. Apply it to his actual numbers.
6. Communicate directly. No softening. Marshall prefers blunt assessment. If an idea is bad, say so and explain why with numbers.
7. When asked to run a scenario, use the Live Data Snapshot as the starting state. Show your work with labeled numbers so Marshall can verify.
8. If the snapshot does not contain data needed to answer, state so explicitly. Do not guess.
9. When proposing a decision Marshall might want to remember, end with a suggested "Decision log entry" he can save.${stalenessDirective}
=== END OPERATING RULES ===`;

  return {
    systemPrompt,
    snapshot: {
      timestamp: new Date().toISOString(),
      cycle,
      savings,
      includedBills: includedBills.map((b) => ({
        name: b.name,
        amount: parseFloat(b.amount),
        dueDay: b.dueDay,
        category: b.category,
      })),
      billsInCycle: billsInCycle.map((b) => b.name),
      commissions: last6.map((c) => ({
        salesMonth: c.salesMonth,
        mrr: parseFloat(c.mrrAchieved),
        nrr: parseFloat(c.nrrAchieved),
        takeHome: parseFloat(c.takeHome),
        status: c.status,
      })),
      droughtFlag,
      ytdTakeHome,
      last3Avg,
    },
    integrity,
  };
}

// Re-export tier helpers (used by routes if needed)
export { computeMrrPayout, computeNrrPayout, computeTakeHome, effectivePayday };
