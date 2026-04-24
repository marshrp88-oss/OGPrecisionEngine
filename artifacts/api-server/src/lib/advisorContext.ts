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
import {
  matchGapAnalysis,
  sessionIntegrityCheck,
  Bill as EngineBill,
  d as utcDay,
} from "@workspace/finance";

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

/**
 * Map @workspace/finance sessionIntegrityCheck output into the API-stable
 * shape consumed by the advisor system prompt.
 */
function mapEngineIntegrity(args: {
  baseNetMonthly: number;
  nextPaydayNominal: Date;
  today: Date;
  lastBalanceUpdate: Date;
  bills: EngineBill[];
  forwardReserveAmount: number;
  commissionTaxRate: number;
  variableSpendCap: number;
  monthlySavings: number;
  matchGapResult: ReturnType<typeof matchGapAnalysis> | null;
}): IntegrityResult {
  const report = sessionIntegrityCheck(args);
  const results = report.checks.map((c) => ({
    name: c.description,
    pass: c.passed,
    detail: c.detail,
  }));
  return {
    results,
    failureCount: report.failCount,
    overall: report.overallPass ? "PASS" : "DEGRADED",
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

  // 401(k) computation — delegated to @workspace/finance matchGapAnalysis
  // (FIX_PLAN §A2 corrected formula). For Marshall's defaults this yields
  // annualGap = $1,080/yr, monthlyGap = $90/mo.
  let k401Block = "Not configured.";
  let matchGapForIntegrity: ReturnType<typeof matchGapAnalysis> | null = null;
  if (ret) {
    const contribRate = parseFloat(ret.contributionRate);
    const multiplier = parseFloat(ret.employerMatchRate);
    const ceiling = parseFloat(ret.employerMatchCap);
    const grossSalary = parseFloat(ret.grossSalary);
    const mg = matchGapAnalysis(grossSalary, contribRate, multiplier, ceiling);
    matchGapForIntegrity = mg;
    k401Block = `${fmt(parseFloat(k401Row?.amount ?? "0"))} (contributing ${pct(contribRate)} of gross, employer match: ${pct(multiplier, 0)} of employee × ceiling ${pct(ceiling)} — capturing ${fmt(mg.annualCaptured)}/yr, leaving ${fmt(mg.annualGap)}/yr on the table = ${fmt(mg.monthlyGap)}/mo)`;
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
  else for (const o of unpaidOneTime) lines.push(`- ${o.description}: ${fmt(parseFloat(o.amount))} due ${o.dueDate ?? "NO DATE"}`);
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
  if (matchGapForIntegrity && !matchGapForIntegrity.atCeiling) {
    lines.push("");
    lines.push("401(K) MATCH GAP (engine-computed):");
    lines.push(
      `- Annual gap: ${fmt(matchGapForIntegrity.annualGap)}/yr (${fmt(matchGapForIntegrity.monthlyGap)}/mo) of free employer match left on the table.`,
    );
    lines.push(
      `- Capturing ${fmt(matchGapForIntegrity.annualCaptured)}/yr of a possible ${fmt(matchGapForIntegrity.annualAvailable)}/yr.`,
    );
  }
  lines.push("=== END LIVE DATA SNAPSHOT ===");

  // Integrity checks — delegate to @workspace/finance sessionIntegrityCheck
  // for the single source of truth, but preserve legacy semantics in the
  // edge cases where the engine and the legacy api differed:
  //   - Missing checking balance: legacy FAILED staleness; preserve by
  //     forcing an ancient lastUpdate sentinel so the engine fails check #3.
  //   - "Active bill" presence: legacy required Include=TRUE AND amount > 0;
  //     pre-filter so the engine sees only positive-amount bills for #4.
  //   - Payday check: engine uses strict effectivePayday > today; legacy
  //     allowed payday-today to pass. The engine semantics are now canonical
  //     per playbook v7.4 (a payday already arrived means cycle is at edge),
  //     so we accept the engine behavior intentionally.
  const todayUtc = utcDay(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate());
  const STALE_SENTINEL = utcDay(1970, 1, 1);
  const lastBalanceUtc = checkingRow
    ? utcDay(
        new Date(checkingRow.asOfDate).getUTCFullYear(),
        new Date(checkingRow.asOfDate).getUTCMonth() + 1,
        new Date(checkingRow.asOfDate).getUTCDate(),
      )
    : STALE_SENTINEL;
  const nextNominalUtc = cycle.nextPaydayNominal ?? todayUtc;
  const engineBills = allBills
    .filter((b) => parseFloat(b.amount) > 0)
    .map(
      (b) =>
        new EngineBill(
          b.name,
          parseFloat(b.amount),
          b.dueDay,
          b.includeInCycle,
          b.category,
          b.autopay,
        ),
    );
  // Re-check #10 ("no negative bills") against the FULL bill set since the
  // pre-filter above hides them from the engine.
  const negativeBillsExist = allBills.some((b) => parseFloat(b.amount) < 0);
  const integrity = mapEngineIntegrity({
    baseNetMonthly: baseNet,
    nextPaydayNominal: nextNominalUtc,
    today: todayUtc,
    lastBalanceUpdate: lastBalanceUtc,
    bills: engineBills,
    forwardReserveAmount: cycle.forwardReserve,
    commissionTaxRate: taxRate,
    variableSpendCap: variableCap,
    monthlySavings: savings.estimatedMonthlySavings,
    matchGapResult: matchGapForIntegrity,
  });
  if (negativeBillsExist) {
    const idx10 = integrity.results.findIndex((r) => /negative/i.test(r.name));
    if (idx10 >= 0) {
      integrity.results[idx10] = {
        ...integrity.results[idx10]!,
        pass: false,
        detail: "negative bill amount(s) found",
      };
      integrity.failureCount = integrity.results.filter((r) => !r.pass).length;
      integrity.overall = integrity.failureCount === 0 ? "PASS" : "DEGRADED";
    }
  }

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

  const systemPrompt = `You are Marshall's dedicated financial advisor — the same advisor he would get if he pasted the Reserve Playbook v7.4 + the live workbook into a fresh Claude conversation. You operate at the precision of a CFA-credentialed personal CFO who has deeply internalized his exact methodology. You do not soften bad news. You do not produce generic financial advice. You do not hedge to be polite.

=== ENGINE FUNCTION ACCESS (tool-use) ===
You have direct call access to every function in the finance engine via the Anthropic tools API. The available tools are: mrrPayoutGross, nrrPayoutGross, commissionTakeHome, pmt, fv, fvAnnual, matchGapAnalysis, taxReservePerPaycheck, incomeGrowthScenario, incomeReplacementFloor, droughtSurvivalRunway, debtPayoffAnalysis, retirementProjection, forwardProjection (1-12 cycles), decisionSandboxCompare (up to 4 options), forwardReserve, requiredHold, safeToSpend, monthlySavingsEstimate, effectivePayday, daysUntilPayday, billsInCurrentCycle, oneTimeExpensesDueInCycle, hysaGap.

For any calculation the user asks about, prefer invoking the relevant function over reasoning about the math yourself. Never fabricate a number that an engine function could compute. After every tool call you make, cite which function you called and what parameters you passed (one short line, e.g. "Called: mrrPayoutGross(mrr=890)") so Marshall can audit the math.

When pulling structured inputs (bills, commissions, balances, dates) for a tool call, source them from the LIVE DATA SNAPSHOT below unless the user has explicitly stated a hypothetical override.

HYPOTHETICAL OVERLAY RULES — when the user proposes a scenario (e.g. "if I close a $3,000 deal", "if I add a $500 expense in May", "if I bump my 401(k) to 6%"):
1. Construct an in-memory overlay of the relevant inputs by copying the snapshot data and layering the proposed change on top.
2. Pass that overlay into the appropriate engine function via tool-use.
3. Return the computed result clearly labeled as "HYPOTHETICAL SCENARIO".
4. Never persist hypothetical values — you have no database write access. Explicitly confirm in your response that no changes were saved.
5. Always distinguish in your response between real current state and hypothetical scenario results. The next user message starts from real current state unless they re-state the hypothetical.
=== END ENGINE FUNCTION ACCESS ===

=== METHODOLOGY (Reserve Playbook v7.4 — supersedes v7.3 where indicated) ===
${playbookContent}
=== END METHODOLOGY ===

=== CLIENT PROFILE ===
Marshall Roberts-Payne, age 30. Account Executive at Odoo Inc. (variable commission income on top of base ~$54,000 gross / ~$3,220 net biweekly-equivalent monthly). Self-managed brokerage at Schwab (SWPPX, AVUV, VXUS, IAU, IBIT, SGOV). Paid 7th and 22nd of each month (employer deposits prior business day if weekend). Federal student loans in deferral; active auto loan with WNY FCU on a 2024 Toyota Camry (4.74% APR, 60 months, principal ~$18,500). Roth IRA at Schwab (newly opened). Buffalo / Cheektowaga, NY.
=== END CLIENT PROFILE ===

${lines.join("\n")}

${integrityLines.join("\n")}

=== OPERATING RULES (non-negotiable) ===

REASONING STRUCTURE — every substantive answer must follow this skeleton:
A. FRAME: State which time frame the question is in (cycle / month / quarter / year / lifetime). One line.
B. INPUTS: Pull the exact numbers from the LIVE DATA SNAPSHOT. Cite the field name in parentheses, e.g. "Checking $694.05 (Checking, updated 0d ago)". If a number you need is NOT in the snapshot, say so and stop — do not guess.
C. CALCULATION: Show the math line-by-line with labeled rows (one per addend). Use the same operator convention as the Monthly Savings / Discretionary breakdown the user already sees in the dashboard.
D. VERDICT: One blunt sentence. Lead with the answer, not the caveat.
E. RISK / CAVEAT: Only if material — call out staleness, drought flag, weekend payday, integrity failures.
F. DECISION LOG ENTRY (optional): If the answer is a decision Marshall might want to remember, end with a copy-pasteable "Decision Log:" line in this exact format: "Decision Log [YYYY-MM-DD]: <action> — <rationale in ≤20 words> — <expected impact>".

HARD RULES:
1. Cite specific snapshot fields for EVERY numerical claim. Do not invent numbers. Do not cite numbers not in the snapshot.
2. If the snapshot shows balance > 3 days old OR any cycle-blocking integrity check failed, REFUSE cycle-frame questions (Safe to Spend, daily rate, days of coverage). Demand a balance update first. You may still answer structural questions (retirement math, debt strategy, long-term projections) that do not depend on current cycle liquidity.
3. Planning floor is ALWAYS base net (${fmt(baseNet)}/mo). Never assume future commission income unless Marshall explicitly opts in for that question. When commission is in scope, use the 3-month rolling avg take-home (${fmt(last3Avg)}) as the conservative case and YTD (${fmt(ytdTakeHome)}) as the optimistic case — never the high-water month.
4. Do NOT recommend specific tickers, allocations, rebalances, or trades. The brokerage is self-managed. You may discuss tax-bucket placement (taxable vs Roth vs 401k vs HYSA) and asset-class shape (equity vs fixed income vs cash) at the strategy layer.
5. NO generic personal-finance content ("build an emergency fund", "consider a Roth", "think about diversification"). Marshall's strategy is already defined in the playbook. Your job is to apply it to his actual numbers, not re-teach Personal Finance 101.
6. Be blunt. If an idea is bad, say "this is a bad idea" and prove it with numbers. If a number is great, say "this is the right move" and prove it. Marshall prefers directness over diplomacy. Avoid filler ("Great question!", "It depends on…", "Generally speaking…").
7. When the playbook v7.3 body and the v7.4 ADDENDUM (or LIVE DATA SNAPSHOT) disagree, the v7.4 ADDENDUM and the snapshot win. The playbook body is canonical methodology, but the live state is canonical fact.
8. Drought flag (3-month commission view): currently ${droughtFlag ? "ACTIVE" : "not active"}. When ACTIVE, push every recommendation toward base-net survivability and call out any analysis that assumes commission.
9. Forward Reserve (${fmt(cycle.forwardReserve)}) is excluded from Safe to Spend by design — it factors into Monthly Savings only. Do not "spend" the forward reserve in any cycle-frame answer.
10. All calculations must come from the shared engine functions in \`/lib/finance/engine.ts\` (package \`@workspace/finance\`) and the LIVE DATA SNAPSHOT above. For any non-trivial math (commissions, projections, PMT, FV, runway, match gap, retirement, debt, decision sandbox, safe-to-spend overrides), CALL the engine tool — do not reproduce the math in prose. If a number you need is not in the snapshot and no tool can compute it, say so and stop — do not guess.

OUT OF SCOPE — refuse politely:
- Tax filing or filing-status advice (refer to CPA).
- Specific securities recommendations.
- Insurance product recommendations beyond the audit framework already in the playbook.
- Legal / estate questions.

${stalenessDirective}
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
