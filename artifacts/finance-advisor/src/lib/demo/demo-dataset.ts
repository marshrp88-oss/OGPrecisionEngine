/**
 * Demo Mode dataset — an obviously-fake, internally-consistent financial world.
 *
 * Everything here is intentionally cartoonish (Wayne Enterprises, Phoenix
 * Capital, Stark Industries) and uses clean round numbers so it can NEVER be
 * mistaken for the operator's real balances. The figures are hand-balanced so
 * the dashboard's cross-references tie out and the integrity layer reports a
 * clean PASS (see demo-mode.ts, which serves these payloads).
 *
 * Nothing in this file touches the API/DB. It is pure in-memory data consumed
 * by the window.fetch interceptor while demoMode is active.
 */

// ---------------------------------------------------------------------------
// Date helpers — demo data is always "fresh as of right now" so the balance
// freshness / payday integrity checks pass regardless of when it's opened.
// ---------------------------------------------------------------------------
const now = new Date();
const iso = (d: Date) => d.toISOString();
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const monthEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
const daysInMonth = monthEndDate.getDate();
const dayOfMonth = now.getDate();
const daysRemainingInMonth = Math.max(0, daysInMonth - dayOfMonth);
// Next "payday" on the dynamic 7th / 22nd schedule the engine uses.
const nextPayday = (() => {
  const d = new Date(now);
  if (dayOfMonth < 7) d.setDate(7);
  else if (dayOfMonth < 22) d.setDate(22);
  else {
    d.setMonth(d.getMonth() + 1);
    d.setDate(7);
  }
  return d;
})();
const daysUntilPayday = Math.max(
  0,
  Math.round((nextPayday.getTime() - now.getTime()) / 86400000),
);

export interface DemoStore {
  // Mutable collections (edits land here, never in the DB)
  bills: any[];
  oneTime: any[];
  variableSpend: any[];
  commissions: any[];
  balances: any[];
  debt: any[];
  wealthSnapshots: any[];
  creditScores: any[];
  scenarios: any[];
  assumptions: any[];
  retirement: any;
  // Static, pre-balanced read-only payloads
  cycle: any;
  discretionary: any;
  cashPosition: any;
  integritySummary: any;
  integrityStatus: any;
  commissionSummary: any;
  billsSummary: any;
  // Monotonic id source for created rows
  _nextId: number;
}

/**
 * Build a fresh demo world. Called every time demo mode is switched ON so the
 * sandbox resets cleanly and prior edits don't bleed across sessions.
 */
export function buildDemoStore(): DemoStore {
  const bills = [
    bill(101, "Wayne Enterprises HQ Lease", 2000, 1, "essential", true, "paid"),
    bill(102, "Stark Industries Cloud", 1000, 10, "essential", true, "paid"),
    bill(103, "Phoenix Capital Card", 500, 15, "debt", false, "scheduled"),
    bill(104, "Daily Planet Premium", 500, 22, "discretionary", false, "scheduled"),
  ];
  const BILLS_MONTHLY = 4000; // sum of includeInCycle bills

  const oneTime = [
    {
      id: 201,
      description: "Batmobile Detailing",
      amount: 1500,
      dueDate: null,
      paid: false,
      deferred: true,
      notes: "Deferred — advisory only",
      countsThisCycle: false,
    },
  ];

  const variableSpend = [
    vspend(301, 600, "Fuel & Tolls", true),
    vspend(302, 400, "Groceries", false),
  ];

  const commissions = [
    {
      id: 401,
      salesMonth: ymd(new Date(now.getFullYear(), now.getMonth(), 1)),
      mrrAchieved: 50000,
      nrrAchieved: 20000,
      mrrPayout: 10000,
      nrrPayout: 4000,
      grossTotal: 14000,
      takeHome: 8000,
      payoutDate: ymd(now),
      status: "confirmed",
      notes: "Demo commission",
    },
  ];

  const balances = [
    balance(501, "checking", 50000, "Phoenix Capital — Checking"),
    balance(502, "hysa", 100000, "Wayne Trust — HYSA"),
    balance(503, "brokerage", 250000, "Gotham Brokerage"),
    balance(504, "401k", 300000, "Stark 401(k)"),
  ];

  const debt = [
    {
      id: 601,
      name: "Wayne Manor Mortgage",
      balance: 400000,
      interestRate: 0.035,
      loanType: "mortgage",
      minimumPayment: 2000,
      status: "active",
      notes: null,
    },
    {
      id: 602,
      name: "Gotham U Student Loans",
      balance: 50000,
      interestRate: 0.045,
      loanType: "student_federal",
      minimumPayment: 500,
      status: "in_repayment",
      notes: null,
    },
  ];

  const wealthSnapshots = [
    {
      id: 701,
      snapshotDate: ymd(now),
      hysa: 100000,
      brokerage: 250000,
      retirement401k: 300000,
      otherAssets: 0,
      totalAssets: 650000,
      carLoan: 0,
      studentLoans: 50000,
      otherLiabilities: 400000,
      totalLiabilities: 450000,
      netWorth: 200000,
      changeVsPrior: 25000,
      notes: "Demo snapshot",
    },
  ];

  const creditScores = [
    { id: 801, asOfDate: ymd(now), experian: 800, equifax: 810, transunion: 805, notes: "Demo" },
  ];

  const retirement = {
    id: 901,
    grossSalary: 200000,
    contributionRate: 0.1,
    employerMatchRate: 0.5,
    employerMatchCap: 0.06,
    currentBalance: 300000,
    currentAge: 35,
    targetAge: 60,
    returnAssumption: 0.07,
    updatedAt: iso(now),
  };

  // NOTE: deliberately omit `sandbox_enabled` — demo mode must not influence
  // the real Scenarios toggle. Scenarios stays at its default (visible).
  const assumptions = [
    assumption("base_net_income", "12000"),
    assumption("variable_spend_until_payday", "1000"),
    assumption("quicksilver_balance_owed", "600"),
    assumption("month_length_days", "30.4"),
    assumption("minimum_cushion", "2000"),
    assumption("pending_holds_reserve", "0"),
    assumption("alert_threshold", "1000"),
    assumption("hysa_target", "100000"),
    assumption("variable_spend_cap", "2000"),
    assumption("mrr_target", "50000"),
    assumption("nrr_target", "20000"),
    assumption("commission_tax_rate", "0.435"),
  ];

  // --- Balanced dashboard ledgers ------------------------------------------
  // Income: 12,000/mo (two 6,000 paychecks; one already received).
  // Outgo : 4,000 bills + 2,000 variable obligation + 0 one-time = 6,000.
  // Savings: 12,000 − 6,000 = 6,000.
  const discretionary = {
    discretionaryThisMonth: 6000,
    monthlySavings: 6000,
    monthEnd: ymd(monthEndDate),
    nextEffectivePayday: ymd(nextPayday),
    forwardReserve: 0,
    proratedVariableRemainingThisMonth: 1000,
    daysRemainingInMonth,
    paychecksReceivedThisMonth: 6000,
    paychecksReceivedCount: 1,
    expectedRemainingPaychecks: 6000,
    paycheckBreakdown: [
      { paydayDate: ymd(new Date(now.getFullYear(), now.getMonth(), 7)), baseAmount: 6000, overrideAmount: null, appliedAmount: 6000, received: true },
      { paydayDate: ymd(new Date(now.getFullYear(), now.getMonth(), 22)), baseAmount: 6000, overrideAmount: null, appliedAmount: 6000, received: false },
    ],
    commissionPaidThisMonth: 0,
    commissionPendingThisMonth: 0,
    totalMonthIncome: 12000,
    billsThisMonth: BILLS_MONTHLY,
    billsPaidThisMonth: 3000,
    billsLateUnpaidThisMonth: 0,
    billsSkippedThisMonth: 0,
    variableLoggedThisMonth: 1000,
    variableExpectedRemaining: 1000,
    variableExpectedRemainingTrailing: 1000,
    variableCapRemaining: 1000,
    monthVariableObligation: 2000,
    trailingDailyRate: 100,
    plannedVariableRemainingOverride: null,
    oneTimeThisMonth: 0,
    oneTimeMonthObligated: 0,
    oneTimePaidThisMonth: 0,
    oneTimeDeferredTotal: 1500,
    oneTimeDetail: [],
    totalMonthOutgo: 6000,
    checking: 50000,
    remainingPaychecksThisMonth: 6000,
    paychecksRemainingCount: 1,
    baseNetIncome: 12000,
    confirmedCommissionUnreceived: 0,
    confirmedCommissionAlready: 0,
    totalInflowsAvailable: 12000,
    billsRemainingThisMonth: 1000,
    billsRemainingDetail: [
      { id: 103, name: "Phoenix Capital Card", amount: 500, dueDay: 15 },
      { id: 104, name: "Daily Planet Premium", amount: 500, dueDay: 22 },
    ],
    oneTimeDatedThisMonth: 0,
    oneTimeUndatedAdvisory: 0,
    variableCap: 2000,
    variableSpentThisMonth: 1000,
    variableRemainingThisMonth: 1000,
    quicksilverBalanceOwed: 600,
    quicksilverAccruedThisMonth: 600,
    minimumCushion: 2000,
    totalReservationsRequired: 2500,
    safeToSpend: 45000,
    cycleStatus: "GREEN",
    discipline: {
      fixedMonthlyTotal: 4000,
      fixedRatio: 0.333,
      fixedRatioStatus: "green",
      variableBurnPace: 0.5,
      variableBurnPaceStatus: "green",
      expectedVariableByNow: 1300,
      savingsRate: 0.5,
      savingsRateStatus: "green",
      dayOfMonth,
      daysInMonth,
    },
  };

  const cycle = {
    checkingBalance: 50000,
    lastBalanceUpdate: iso(now),
    nextPayday: ymd(nextPayday),
    daysSinceUpdate: 0,
    isStale: false,
    daysUntilPayday,
    billsDueBeforePayday: 500,
    pendingHoldsReserve: 0,
    minimumCushion: 2000,
    oneTimeDueBeforePayday: 0,
    totalRequiredHold: 2500,
    quicksilverOwed: 600,
    pendingBillsOwed: 0,
    forwardReserveBillsTotal: 0,
    safeToSpend: 45000,
    safeToSpendPreFloor: 47000,
    overCommittedBy: 0,
    dailyRateFromUpdate: 200,
    dailyRateRealTime: 200,
    daysOfCoverage: 90,
    variableSpendUntilPayday: 1000,
    remainingDiscretionary: 6000,
    status: "GREEN",
    paydayRisk: false,
    forwardReserve: 0,
    alertThreshold: 1000,
  };

  // Cash position (balance-flow view). projectedEndOfMonthChecking =
  // 50,000 + 6,000 − 2,000 − 1,000 − 0 = 53,000.
  const cashPosition = {
    asOf: ymd(now),
    monthEnd: ymd(monthEndDate),
    currentChecking: 50000,
    lastBalanceUpdate: iso(now),
    daysSinceUpdate: 0,
    incomeStillToReceive: 6000,
    paychecksStillExpected: [{ date: ymd(nextPayday), amount: 6000 }],
    pendingCommissionUnreceived: 0,
    billsAlreadyDebited: 2000,
    billsAlreadyDebitedDetail: [],
    billsNotYetDebited: 2000,
    billsNotYetDebitedDetail: [],
    variableExpectedRemaining: 1000,
    variableExpectedRemainingCash: 400,
    variableExpectedRemainingQs: 600,
    quicksilverAccruedRatio: 0.6,
    oneTimeStillToPay: 0,
    oneTimeStillToPayDetail: [],
    commitmentOutflowsRemaining: 3000,
    commitmentBalance: 47000,
    availableToInvest: 46000,
    totalCashOutflowsRemaining: 3000,
    projectedEndOfMonthChecking: 53000,
    isDeficit: false,
    isTight: false,
  };

  const summaryChecks = [
    { name: "Balance freshness", status: "pass", detail: "Updated 0 day(s) ago." },
    { name: "Next payday (derived)", status: "pass", detail: `Payday: ${ymd(nextPayday)} (dynamic 7th/22nd).` },
    { name: "Active bills", status: "pass", detail: "4 active bills." },
    { name: "Bill amounts non-negative", status: "pass", detail: "All bills ≥ 0." },
    { name: "Base net income", status: "pass", detail: "$12000.00/mo" },
  ];
  const integritySummary = { overall: "pass", failCount: 0, warnCount: 0, checks: summaryChecks };

  const integrityStatus = {
    id: 1,
    runAt: iso(now),
    overallStatus: "pass",
    notes: "Demo mode — synthetic balanced dataset. All checks pass.",
    checks: [
      { checkNumber: 1, description: "Balance data freshness", status: "pass", detail: "Balance updated 0 day(s) ago. OK." },
      { checkNumber: 2, description: "Next payday (derived)", status: "pass", detail: `Next payday: ${ymd(nextPayday)} (dynamic 7th/22nd).` },
      { checkNumber: 3, description: "Base net income configured", status: "pass", detail: "Base net income: $12000.00/mo." },
      { checkNumber: 4, description: "Active bills configured", status: "pass", detail: "4 bills marked Include=TRUE." },
      { checkNumber: 5, description: "Bill amounts non-negative", status: "pass", detail: "All bills ≥ 0." },
      { checkNumber: 6, description: "Income ≥ obligations", status: "pass", detail: "Income $12,000 ≥ outgo $6,000." },
      { checkNumber: 7, description: "Reservations reconcile", status: "pass", detail: "Hold $2,500 fully covered." },
    ],
  };

  const commissionSummary = {
    ytdTakeHome: 96000,
    last3MonthsAvg: 8000,
    droughtFlag: false,
    droughtMonths: 0,
    currentMonthConfirmed: 8000,
  };

  const billsSummary = {
    asOf: ymd(now),
    nextPayday: ymd(nextPayday),
    totals: { monthlyIncluded: 4000, monthlyAll: 4000, annualIncluded: 48000, activeCount: 4, excludedCount: 0, percentOfNetIncome: 33.3 },
    income: { baseNetIncome: 12000, commissionThisMonth: 8000, totalMonthIncome: 12000 },
    categoryBreakdown: [
      { category: "essential", count: 2, monthly: 3000, annual: 36000, percentOfBills: 75, percentOfIncome: 25 },
      { category: "debt", count: 1, monthly: 500, annual: 6000, percentOfBills: 12.5, percentOfIncome: 4.2 },
      { category: "discretionary", count: 1, monthly: 500, annual: 6000, percentOfBills: 12.5, percentOfIncome: 4.2 },
    ],
    autopayAudit: {
      autopayCount: 2,
      autopayMonthly: 3000,
      manualCount: 2,
      manualMonthly: 1000,
      manualPct: 50,
      upcomingManual: [
        { id: 103, name: "Phoenix Capital Card", amount: 500, nextDueDate: ymd(new Date(now.getFullYear(), now.getMonth(), 15)), daysUntilDue: Math.max(0, 15 - dayOfMonth) },
      ],
    },
    upcomingTimeline: [
      { id: 103, name: "Phoenix Capital Card", amount: 500, category: "debt", autopay: false, dueDay: 15, nextDueDate: ymd(new Date(now.getFullYear(), now.getMonth(), 15)), daysUntilDue: Math.max(0, 15 - dayOfMonth), inCycle: true, risk: "low" },
      { id: 104, name: "Daily Planet Premium", amount: 500, category: "discretionary", autopay: false, dueDay: 22, nextDueDate: ymd(new Date(now.getFullYear(), now.getMonth(), 22)), daysUntilDue: Math.max(0, 22 - dayOfMonth), inCycle: true, risk: "low" },
    ],
    incomeVsObligations: {
      totalMonthIncome: 12000,
      fixedBills: 4000,
      variableCap: 2000,
      residualAfterFixed: 8000,
      residualAfterAll: 6000,
      residualPct: 50,
    },
  };

  return {
    bills,
    oneTime,
    variableSpend,
    commissions,
    balances,
    debt,
    wealthSnapshots,
    creditScores,
    scenarios: [],
    assumptions,
    retirement,
    cycle,
    discretionary,
    cashPosition,
    integritySummary,
    integrityStatus,
    commissionSummary,
    billsSummary,
    _nextId: 100000,
  };
}

// ---------------------------------------------------------------------------
// Row factories (kept terse; only the fields the UI reads)
// ---------------------------------------------------------------------------
function bill(
  id: number,
  name: string,
  amount: number,
  dueDay: number,
  category: string,
  autopay: boolean,
  paymentState: string,
) {
  return {
    id,
    name,
    amount,
    dueDay,
    frequency: "monthly",
    includeInCycle: true,
    category,
    autopay,
    notes: null,
    activeFrom: null,
    activeUntil: null,
    countsThisCycle: true,
    nextDueDate: ymd(new Date(now.getFullYear(), now.getMonth(), Math.min(dueDay, daysInMonth))),
    paymentState,
    paidDate: paymentState === "paid" ? ymd(now) : null,
    clearedDate: null,
  };
}

function vspend(id: number, amount: number, category: string, quicksilver: boolean) {
  const weekOf = new Date(now);
  weekOf.setDate(now.getDate() - now.getDay());
  return { id, weekOf: ymd(weekOf), amount, category, quicksilver, notes: null };
}

function balance(id: number, accountType: string, amount: number, notes: string) {
  return { id, accountType, amount, asOfDate: ymd(now), source: "manual", notes };
}

function assumption(key: string, value: string) {
  return { key, value, updatedAt: iso(now) };
}
