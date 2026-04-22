import {
  db,
  assumptions,
  bills,
  commissions,
  wealthSnapshots,
  balances,
  retirementPlan,
  debt,
  creditScores,
  oneTimeExpenses,
  variableSpend,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeMrrPayout, computeNrrPayout, computeTakeHome, computePayoutDate } from "./financeEngine";

async function upsertAssumption(key: string, value: string) {
  const [existing] = await db.select().from(assumptions).where(eq(assumptions.key, key));
  if (!existing) {
    await db.insert(assumptions).values({ key, value });
  } else if (existing.value !== value) {
    await db.update(assumptions).set({ value, updatedAt: new Date() }).where(eq(assumptions.key, key));
  }
}

async function seed() {
  console.log("Seeding correct production data (Phase 1 Correction Plan)...");

  // === Assumptions ===
  // Pin date to current operating reality. nextPayday is the 22nd of current month.
  const today = new Date();
  let nextPayday: Date;
  const day = today.getDate();
  if (day < 7) {
    nextPayday = new Date(today.getFullYear(), today.getMonth(), 7);
  } else if (day < 22) {
    nextPayday = new Date(today.getFullYear(), today.getMonth(), 22);
  } else {
    nextPayday = new Date(today.getFullYear(), today.getMonth() + 1, 7);
  }
  const nextPaydayStr = nextPayday.toISOString().split("T")[0];

  await upsertAssumption("next_payday_date", nextPaydayStr);
  await upsertAssumption("base_net_income", "3220");
  await upsertAssumption("variable_spend_cap", "600");
  await upsertAssumption("alert_threshold", "400");
  await upsertAssumption("minimum_cushion", "0");
  await upsertAssumption("pending_holds_reserve", "0");
  await upsertAssumption("month_length_days", "30.4");
  await upsertAssumption("mrr_target", "700");
  await upsertAssumption("nrr_target", "6000");
  await upsertAssumption("commission_tax_rate", "0.435");
  await upsertAssumption("hysa_target", "15000");
  await upsertAssumption("variable_spend_until_payday", "0");
  await upsertAssumption("quicksilver_balance_owed", "0");
  console.log("  Assumptions upserted.");

  // === A1: Purge fake data ===
  await db.delete(bills);
  await db.delete(commissions);
  await db.delete(wealthSnapshots);
  await db.delete(oneTimeExpenses);
  await db.delete(variableSpend);
  await db.delete(balances);
  await db.delete(debt);
  console.log("  Purged stale data: bills, commissions, snapshots, one-time, balances, debt.");

  // === A5: Account balances (current reality, dated today) ===
  const asOf = today;
  await db.insert(balances).values([
    { accountType: "checking", amount: "694.05", asOfDate: asOf, source: "seed", notes: "Cycle-level liquidity" },
    { accountType: "hysa", amount: "15000.00", asOfDate: asOf, source: "seed", notes: "TARGET MET" },
    { accountType: "brokerage", amount: "35500.00", asOfDate: asOf, source: "seed", notes: "Schwab self-managed taxable" },
    { accountType: "401k", amount: "2200.00", asOfDate: asOf, source: "seed", notes: "Currently 4% contribution; planning bump to 8%" },
    { accountType: "roth_ira", amount: "0.00", asOfDate: asOf, source: "seed", notes: "Newly opened. Unfunded." },
    { accountType: "vehicle", amount: "25000.00", asOfDate: asOf, source: "seed", notes: "2024 Toyota Camry — current market value (other_asset class)" },
  ]);
  console.log("  Seeded 6 balances (current as of today, including Camry vehicle asset).");

  // === A3: Real bills ===
  // Car loan due day: confirmed by Marshall as the 1st of the month starting May.
  await db.insert(bills).values([
    { name: "Gym Membership", amount: "27.00", dueDay: 2, frequency: "monthly", category: "discretionary", autopay: true, includeInCycle: false, notes: "Prepaid through Jan 2027 via HealthEquity card. Re-enable Feb 1, 2027." },
    { name: "Phone (Verizon)", amount: "65.00", dueDay: 2, frequency: "monthly", category: "essential", autopay: true, includeInCycle: true },
    { name: "Claude Subscription", amount: "21.00", dueDay: 3, frequency: "monthly", category: "discretionary", autopay: true, includeInCycle: true },
    { name: "Rent", amount: "1000.00", dueDay: 4, frequency: "monthly", category: "essential", autopay: true, includeInCycle: true, notes: "Largest fixed obligation" },
    { name: "Car Loan (2024 Camry)", amount: "337.00", dueDay: 1, frequency: "monthly", category: "debt", autopay: true, includeInCycle: true, notes: "WNY FCU, 4.74% APR, 60 months. Principal ~$18,500." },
    { name: "Car Insurance", amount: "141.95", dueDay: 8, frequency: "monthly", category: "essential", autopay: true, includeInCycle: true, notes: "Expected reprice September 2026" },
    { name: "YouTube Premium", amount: "14.00", dueDay: 15, frequency: "monthly", category: "discretionary", autopay: true, includeInCycle: true },
    { name: "Electric", amount: "175.00", dueDay: 16, frequency: "monthly", category: "essential", autopay: false, includeInCycle: true, notes: "Manual pay" },
    { name: "Gas", amount: "70.00", dueDay: 19, frequency: "monthly", category: "essential", autopay: false, includeInCycle: true, notes: "Manual pay" },
    { name: "EZ-Pass", amount: "10.00", dueDay: 22, frequency: "monthly", category: "essential", autopay: true, includeInCycle: true },
    { name: "Capital One QuickSilver (variable)", amount: "0.00", dueDay: 25, frequency: "monthly", category: "variable", autopay: false, includeInCycle: false, notes: "Statement balance accrues from variable spend log; never auto-charged. Use Variable Spend Log to track." },
  ]);
  console.log("  Seeded 11 real bills (car loan due day = 1st; QuickSilver tracker as variable, Include=FALSE).");

  // === A4: Historical commissions (compute payout/take_home from formulas) ===
  const commissionRows = [
    { salesMonth: "2025-12-01", mrr: 890.0, nrr: 0.0, status: "paid" as const },
    { salesMonth: "2026-01-01", mrr: 0.0, nrr: 0.0, status: "paid" as const },
    { salesMonth: "2026-02-01", mrr: 0.0, nrr: 0.0, status: "paid" as const },
    { salesMonth: "2026-03-01", mrr: 0.0, nrr: 0.0, status: "paid" as const },
  ];
  for (const c of commissionRows) {
    const mrrPayout = computeMrrPayout(c.mrr, 700);
    const nrrPayout = computeNrrPayout(c.nrr, 6000);
    const gross = mrrPayout + nrrPayout;
    const takeHome = computeTakeHome(gross, 0.435);
    await db.insert(commissions).values({
      salesMonth: c.salesMonth,
      mrrAchieved: c.mrr.toFixed(2),
      nrrAchieved: c.nrr.toFixed(2),
      mrrPayout: mrrPayout.toFixed(2),
      nrrPayout: nrrPayout.toFixed(2),
      grossTotal: gross.toFixed(2),
      takeHome: takeHome.toFixed(2),
      payoutDate: computePayoutDate(c.salesMonth),
      status: c.status,
    });
  }
  console.log("  Seeded 4 commission rows (Dec 890 = $874.35 take-home; Jan/Feb/Mar = $0).");

  // === A6: Wealth snapshots (Jan-Apr 2026) ===
  const snapshots = [
    { month: "2026-01-01", hysa: 12500, brok: 36073.35, k401: 1550, other: 0, car: 0, student: 30000 },
    { month: "2026-02-01", hysa: 12500, brok: 36073.35, k401: 1750, other: 0, car: 0, student: 30000 },
    { month: "2026-03-01", hysa: 12600, brok: 33962.45, k401: 1850.45, other: 0, car: 0, student: 30000 },
    { month: "2026-04-01", hysa: 15000, brok: 35500, k401: 2200, other: 25000, car: 18500, student: 30000 },
  ];
  for (const s of snapshots) {
    const totalAssets = s.hysa + s.brok + s.k401 + s.other;
    const totalLiabilities = s.car + s.student;
    const netWorth = totalAssets - totalLiabilities;
    await db.insert(wealthSnapshots).values({
      snapshotDate: s.month,
      hysa: s.hysa.toFixed(2),
      brokerage: s.brok.toFixed(2),
      retirement401k: s.k401.toFixed(2),
      otherAssets: s.other.toFixed(2),
      totalAssets: totalAssets.toFixed(2),
      carLoan: s.car.toFixed(2),
      studentLoans: s.student.toFixed(2),
      otherLiabilities: "0.00",
      totalLiabilities: totalLiabilities.toFixed(2),
      netWorth: netWorth.toFixed(2),
    });
  }
  console.log("  Seeded 4 monthly net worth snapshots (Jan-Apr 2026).");

  // === Debt: car loan + student loans ===
  await db.insert(debt).values([
    {
      name: "Car Loan (2024 Camry)",
      balance: "18500.00",
      interestRate: "0.0474",
      loanType: "auto",
      minimumPayment: "337.00",
      status: "active",
      notes: "WNY FCU, 4.74% APR, 60 months",
    },
    {
      name: "Federal Student Loans",
      balance: "30000.00",
      interestRate: "0.0000",
      loanType: "federal",
      minimumPayment: "0.00",
      status: "deferral",
      notes: "Estimated balance, not in repayment. Rate unknown — verify with FSA.",
    },
  ]);
  console.log("  Seeded 2 debt rows (car loan + student loans).");

  // === Credit scores ===
  const [existingCS] = await db.select().from(creditScores);
  if (!existingCS) {
    await db.insert(creditScores).values({
      asOfDate: "2026-01-01",
      experian: 756,
      equifax: 754,
      transunion: 736,
      notes: "January 2026 credit scores",
    });
    console.log("  Seeded credit scores.");
  }

  // === Variable spend log: seed a few sample QuickSilver entries for current month ===
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const week1 = new Date(monthStart); week1.setDate(monthStart.getDate() + 6);
  const week2 = new Date(monthStart); week2.setDate(monthStart.getDate() + 13);
  await db.insert(variableSpend).values([
    { weekOf: week1.toISOString().split("T")[0], amount: "112.45", category: "groceries", quicksilver: true, notes: "Wegmans + Aldi" },
    { weekOf: week1.toISOString().split("T")[0], amount: "38.20", category: "dining", quicksilver: true, notes: "Two takeout dinners" },
    { weekOf: week2.toISOString().split("T")[0], amount: "65.00", category: "fuel", quicksilver: true, notes: "Shell pump 2 fills" },
    { weekOf: week2.toISOString().split("T")[0], amount: "21.99", category: "household", quicksilver: false, notes: "Target run — debit, not on card" },
  ]);
  console.log("  Seeded 4 variable spend entries (3 QuickSilver + 1 debit).");

  // === A2: Retirement plan (new 401(k) match structure) ===
  // employerMatchRate field repurposed as matchMultiplier (0.50)
  // employerMatchCap field repurposed as employeeContributionCeiling (0.08)
  const [existingRet] = await db.select().from(retirementPlan).limit(1);
  const retirementValues = {
    grossSalary: "54000.00",
    contributionRate: "0.0400",         // 4% employee
    employerMatchRate: "0.5000",        // = match multiplier (50% of employee %)
    employerMatchCap: "0.0800",         // = employee contribution ceiling (8% of gross)
    currentBalance: "2200.00",
    currentAge: 30,
    targetAge: 65,
    returnAssumption: "0.0700",
  };
  if (existingRet) {
    await db.update(retirementPlan).set({ ...retirementValues, updatedAt: new Date() }).where(eq(retirementPlan.id, existingRet.id));
    console.log("  Updated retirement plan (4% contrib, 50% multiplier, 8% ceiling, $2,200 balance).");
  } else {
    await db.insert(retirementPlan).values(retirementValues);
    console.log("  Seeded retirement plan.");
  }

  console.log("Seed complete.");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
