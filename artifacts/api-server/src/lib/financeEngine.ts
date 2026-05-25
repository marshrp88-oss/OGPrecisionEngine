s = engineOneTimes.filter((o) => !o.paid).reduce((s, o) => s + o.amount, 0);

// QuickSilver accrual = sum of QS-tagged variable_spend log entries this
// month. Per Playbook §2.1 B60, this is subtracted from Monthly Savings
// Estimate as already-spent credit-card liability that must be paid from
// checking — distinct from B58 (forward variable budget through payday).
// The two are separate buckets and intentionally non-overlapping.
const vsEntries = await db.select().from(variableSpend);
let quicksilverAccrual = 0;
for (const vs of vsEntries) {
  if (vs.quicksilver) quicksilverAccrual += parseFloat(vs.amount);
}
const quicksilverBalanceOwed = await getAssumption(
  "quicksilver_balance_owed",
  0,
);

// Days-to-payday × cap / month-length, ROUND(_, 2). Engine handles internally
// when called via monthlySavingsEstimate.
const daysToPayday = engineDaysUntilPayday(today, nextPaydayNominal);
const remainingVariableSpendProrated = Math.max(
  0,
  Math.round((daysToPayday / monthLengthDays) * variableSpendCap * 100) / 100,
);

// v9 — match dashboard engine: Forward Reserve = sum of include=TRUE
// bills with dueDay 1..7 of next calendar month. No buffer. No window.
void engineForwardReserve; // legacy helper, intentionally bypassed
void allActiveEngineBills;
const forwardReserveAmount = enriched
  .filter(
    (b) =>
      b.isActivePeriod &&
      b.includeInCycle &&
      b.amount > 0 &&
      b.dueDay >= 1 &&
      b.dueDay <= 7 &&
      b.paymentState !== "skipped_cycle",
  )
  .reduce((s, b) => s + b.amount, 0);

// PLACEHOLDER (per user direction 2026-04-24): Monthly Savings Estimate is
// expressed as Discretionary minus a fixed $100 buffer. Rationale: Monthly
// Savings must always be ≤ Discretionary (both end at the same payday
// boundary), and the $100 offset keeps it conservative. The full Playbook
// §2.1 B62 formula is preserved in `monthlySavingsEstimate()` for tests
// and tooling, but we don't wire it to the dashboard headline until the
// income/instance accounting is reconciled.
const [latestChecking] = await db
  .select()
  .from(balances)
  .where(eq(balances.accountType, "checking"))
  .orderBy(desc(balances.asOfDate))
  .limit(1);
const checking = latestChecking
  ? parseFloat(latestChecking.amount as unknown as string)
  : 0;

// Bills remaining in the current calendar month (Include=TRUE, due day in
// [today, month_end]).
const monthEndDay = new Date(
  today.getUTCFullYear(),
  today.getUTCMonth() + 1,
  0,
).getUTCDate();
const todayDay = today.getUTCDate();
const billsRemainingThisMonth = includedEngineBills
  .filter((b) => b.dueDay >= todayDay && b.dueDay <= monthEndDay)
  .reduce((s, b) => s + b.amount, 0);

// Unpaid one-time expenses dated through month-end.
const monthEndDate = new Date(
  Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), monthEndDay),
);
const oneTimeDatedThisMonth = engineOneTimes
  .filter(
    (o) =>
      !o.paid &&
      o.dueDate !== null &&
      o.dueDate.getTime() >= today.getTime() &&
      o.dueDate.getTime() <= monthEndDate.getTime(),
  )
  .reduce((s, o) => s + o.amount, 0);

const discretionary = engineDiscretionaryThisMonth(
  checking,
  billsRemainingThisMonth,
  oneTimeDatedThisMonth,
  quicksilverBalanceOwed,
  includedEngineBills,
  today,
  variableSpendCap,
  monthLengthDays,
);
const estimatedMonthlySavings = Math.max(0, discretionary - 100);

const totalMonthIncome = baseNetIncome + confirmedCommission;

// 401(k) match gap — delegate to engine (FIX_PLAN §A2 corrected formula).
const [ret] = await db.select().from(retirementPlan).limit(1);
let matchGapActive = false;
let monthlyMatchGapCost = 0;
if (ret) {
  const mg = matchGapAnalysis(
    parseFloat(ret.grossSalary),
    parseFloat(ret.contributionRate),
    parseFloat(ret.employerMatchRate),
    parseFloat(ret.employerMatchCap),
  );
  matchGapActive = mg.annualGap > 0.01;
  monthlyMatchGapCost = Math.round(mg.monthlyGap * 100) / 100;
}

const savingsAfterMatchBump = Math.max(
  0,
  estimatedMonthlySavings - monthlyMatchGapCost,
);
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
  forwardReserve: forwardReserveAmount,
  estimatedMonthlySavings,
  matchGapActive,
  monthlyMatchGapCost,
  savingsAfterMatchBump,
  canAffordMatchBump,
};

// ---------------------------------------------------------------------------
// Commission tier helpers — re-export engine versions but keep API compatible
// (rounded to cents) since DB stores rounded values.
// ---------------------------------------------------------------------------

export function computeMrrPayout(mrrAchieved: number, mrrTarget = 700): number {
  return Math.round(mrrPayoutGross(mrrAchieved, mrrTarget) * 100) / 100;
}

export function computeNrrPayout(
  nrrAchieved: number,
  nrrTarget = 6000,
): number {
  return Math.round(nrrPayoutGross(nrrAchieved, nrrTarget) * 100) / 100;
}

export function computeTakeHome(grossPayout: number, taxRate = 0.435): number {
  return Math.round(grossPayout * (1 - taxRate) * 100) / 100;
}

export function computePayoutDate(
  salesMonthStr: string,
  payoutDay = 22,
): string {
  // Use the engine's commissionPayoutDate which handles December rollover.
  const sales = utcStartOfDay(new Date(salesMonthStr));
  const pd = commissionPayoutDate(sales, payoutDay);
  return pd.toISOString().split("T")[0]!;
}

// ---------------------------------------------------------------------------
// Scenario outputs — delegate to engine functions.
// ---------------------------------------------------------------------------

export function computeScenarioOutputs(
  type: string,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "vehicle") {
    const sticker = Number(inputs.sticker) || 0;
    const downPayment = Number(inputs.downPayment) || 0;
    const rate = Number(inputs.rate) || 0;
    const months = Number(inputs.months) || 60;
    const insurance = Number(inputs.insurance) || 0;
    const principal = sticker - downPayment;
    let monthly = 0;
    if (principal > 0 && months > 0) {
      monthly = rate > 0 ? pmt(rate, months, principal) : principal / months;
    }
    const totalCost = monthly * months + downPayment;
    const totalInterest = totalCost - sticker;
    const newMonthlyBurn = monthly + insurance;
    return {
      monthlyPayment: Math.round(monthly * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalInterest: Math.round(totalInterest * 100) / 100,
      newMonthlyBurn: Math.round(newMonthlyBurn * 100) / 100,
    };
  }

  if (type === "drought_survival") {
    const checking = Number(inputs.checking) || 0;
    const hysa = Number(inputs.hysa) || 0;
    const monthlyBurn = Number(inputs.monthlyBurn) || 0;
    // Engine droughtSurvivalRunway expects bills + cap + base; we have the
    // pre-computed burn. Compute runway directly using the engine's formula
    // shape so callers get totalLiquid + months + label.
    const r = droughtSurvivalRunway(checking, hysa, monthlyBurn, 0, 0);
    const runwayMonths = r.indefinite ? 0 : (r.runway_months ?? 0);
    return {
      totalLiquid: r.totalLiquid,
      runwayMonths,
      runwayLabel: `${Math.floor(runwayMonths)} months ${Math.round((runwayMonths % 1) * 30)} days`,
    };
  }

  if (type === "income_floor") {
    const targetSavings = Number(inputs.targetSavings) || 0;
    const fixedMonthly = Number(inputs.fixedMonthly) || 0;
    const variableCap = Number(inputs.variableCap) || 0;
    const taxRate = Number(inputs.taxRate) || 0.22;
    const [annualFloor] = incomeReplacementFloor(
      targetSavings,
      fixedMonthly,
      variableCap,
      taxRate,
    );
    const minMonthlyNet = targetSavings + fixedMonthly + variableCap;
    return {
      requiredMonthlyNet: Math.round(minMonthlyNet * 100) / 100,
      requiredAnnualGross: Math.round(annualFloor * 100) / 100,
    };
  }

  if (type === "income_change") {
    const currentBase = Number(inputs.currentBase) || 0;
    const newBase = Number(inputs.newBase) || 0;
    const taxRate = Number(inputs.taxRate) || 0.22;
    const r = incomeGrowthScenario(currentBase, newBase, taxRate, 0, 0, 0);
    const currentNet = (currentBase / 12) * (1 - taxRate);
    const newNet = (newBase / 12) * (1 - taxRate);
    return {
      currentMonthlyNet: Math.round(currentNet * 100) / 100,
      newMonthlyNet: Math.round(newNet * 100) / 100,
      monthlyIncrease: Math.round(r.monthly_net_increase * 100) / 100,
      annualIncrease:
        Math.round((newBase - currentBase) * (1 - taxRate) * 100) / 100,
    };
  }

  if (type === "purchase_compare") {
    const opts = Array.isArray(inputs.options)
      ? (inputs.options as Array<Record<string, unknown>>)
      : [];
    const purchaseOpts = opts.map(
      (o) =>
        new PurchaseOption(
          String(o.name ?? ""),
          Number(o.totalPrice ?? 0),
          Number(o.downPayment ?? 0),
          Number(o.annualRate ?? 0),
          Number(o.termMonths ?? 60),
          Number(o.monthlyAddons ?? 0),
          Number(o.oneTimeCost ?? 0),
        ),
    );
    return {
      results: decisionSandboxCompare(
        purchaseOpts,
        Number(inputs.currentDailySafeSpend) || 0,
        Number(inputs.monthlyFixedBills) || 0,
        Number(inputs.variableCap) || 600,
        Number(inputs.baseNetMonthly) || 3220,
        Number(inputs.hysaBalance) || 0,
      ),
    };
  }

  return {};
}

// Re-export engine commission helpers under their aliases so callers can switch
// to the central versions piecemeal.
export {
  mrrPayoutGross as computeMrrPayoutRaw,
  nrrPayoutGross as computeNrrPayoutRaw,
  commissionTakeHome as commissionTakeHomeRaw,
};
