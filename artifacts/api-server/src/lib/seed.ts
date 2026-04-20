import { db, assumptions, bills, commissions, wealthSnapshots, balances, retirementPlan, debt, creditScores } from "@workspace/db";
import { eq } from "drizzle-orm";

async function upsertAssumption(key: string, value: string) {
  const [existing] = await db.select().from(assumptions).where(eq(assumptions.key, key));
  if (!existing) {
    await db.insert(assumptions).values({ key, value });
    console.log(`  Seeded assumption: ${key} = ${value}`);
  }
}

async function seed() {
  console.log("Seeding default data...");

  // Default assumptions (from brief)
  const today = new Date();
  const nextPayday = today.getDate() <= 7
    ? new Date(today.getFullYear(), today.getMonth(), 22)
    : today.getDate() <= 22
      ? new Date(today.getFullYear(), today.getMonth(), 22)
      : new Date(today.getFullYear(), today.getMonth() + 1, 7);

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

  // Seed checking balance from Part B: $2,140
  const [existingChecking] = await db.select().from(balances).where(eq(balances.accountType, "checking"));
  if (!existingChecking) {
    await db.insert(balances).values({
      accountType: "checking",
      amount: "2140.00",
      asOfDate: new Date("2025-04-01"),
      source: "seed",
      notes: "Initial seed balance from Part B",
    });
    console.log("  Seeded checking balance: $2,140");
  }

  // HYSA $12,600
  const [existingHysa] = await db.select().from(balances).where(eq(balances.accountType, "hysa"));
  if (!existingHysa) {
    await db.insert(balances).values({
      accountType: "hysa",
      amount: "12600.00",
      asOfDate: new Date("2025-04-01"),
      source: "seed",
      notes: "Initial seed balance from Part B",
    });
    console.log("  Seeded HYSA balance: $12,600");
  }

  // Brokerage $36,000
  const [existingBrokerage] = await db.select().from(balances).where(eq(balances.accountType, "brokerage"));
  if (!existingBrokerage) {
    await db.insert(balances).values({
      accountType: "brokerage",
      amount: "36000.00",
      asOfDate: new Date("2025-04-01"),
      source: "seed",
      notes: "Initial seed balance from Part B",
    });
    console.log("  Seeded brokerage balance: $36,000");
  }

  // 401k $1,550
  const [existing401k] = await db.select().from(balances).where(eq(balances.accountType, "401k"));
  if (!existing401k) {
    await db.insert(balances).values({
      accountType: "401k",
      amount: "1550.00",
      asOfDate: new Date("2025-04-01"),
      source: "seed",
      notes: "Initial seed balance from Part B",
    });
    console.log("  Seeded 401k balance: $1,550");
  }

  // Seed bills from Part B
  const [existingBills] = await db.select().from(bills);
  if (!existingBills) {
    const billsData = [
      { name: "Rent", amount: "1125.00", dueDay: 1, category: "essential", includeInCycle: true },
      { name: "Planet Fitness", amount: "25.00", dueDay: 1, category: "essential", includeInCycle: true },
      { name: "Netflix", amount: "15.49", dueDay: 8, category: "discretionary", includeInCycle: true },
      { name: "Hulu", amount: "7.99", dueDay: 8, category: "discretionary", includeInCycle: true },
      { name: "Spotify", amount: "10.99", dueDay: 6, category: "discretionary", includeInCycle: true },
      { name: "iCloud", amount: "2.99", dueDay: 15, category: "discretionary", includeInCycle: true },
      { name: "Student Loans", amount: "0.00", dueDay: 1, category: "debt", includeInCycle: false, notes: "Not in repayment yet" },
      { name: "Car Insurance", amount: "182.00", dueDay: 9, category: "essential", includeInCycle: true },
      { name: "Renters Insurance", amount: "10.00", dueDay: 1, category: "essential", includeInCycle: true },
      { name: "Internet", amount: "60.00", dueDay: 15, category: "essential", includeInCycle: true },
      { name: "Phone", amount: "45.00", dueDay: 20, category: "essential", includeInCycle: true },
    ];

    for (const b of billsData) {
      await db.insert(bills).values({
        ...b,
        frequency: "monthly",
        autopay: false,
      });
    }
    console.log("  Seeded 11 bills");
  }

  // Seed commissions from Part B
  const [existingComm] = await db.select().from(commissions);
  if (!existingComm) {
    await db.insert(commissions).values([
      {
        salesMonth: "2026-01-01",
        mrrAchieved: "890.00",
        nrrAchieved: "0.00",
        mrrPayout: "368.50",
        nrrPayout: "0.00",
        grossTotal: "368.50",
        takeHome: "208.20",
        payoutDate: "2026-02-22",
        status: "paid",
        notes: "Jan 2026 commission",
      },
      {
        salesMonth: "2026-02-01",
        mrrAchieved: "245.00",
        nrrAchieved: "0.00",
        mrrPayout: "46.25",
        nrrPayout: "0.00",
        grossTotal: "46.25",
        takeHome: "26.13",
        payoutDate: "2026-03-22",
        status: "paid",
        notes: "Feb 2026 commission",
      },
    ]);
    console.log("  Seeded 2 commission records");
  }

  // Seed wealth snapshot
  const [existingSnapshot] = await db.select().from(wealthSnapshots);
  if (!existingSnapshot) {
    await db.insert(wealthSnapshots).values({
      snapshotDate: "2025-04-01",
      hysa: "12600.00",
      brokerage: "36000.00",
      retirement401k: "1550.00",
      otherAssets: "2140.00",
      totalAssets: "52290.00",
      carLoan: "0.00",
      studentLoans: "30000.00",
      otherLiabilities: "0.00",
      totalLiabilities: "30000.00",
      netWorth: "22290.00",
      changeVsPrior: null,
      notes: "Initial snapshot from Part B seed data",
    });
    console.log("  Seeded initial wealth snapshot");
  }

  // Seed student loan debt
  const [existingDebt] = await db.select().from(debt);
  if (!existingDebt) {
    await db.insert(debt).values({
      name: "Federal Student Loans",
      balance: "30000.00",
      interestRate: "0.0000",
      loanType: "federal",
      minimumPayment: "0.00",
      status: "deferral",
      notes: "Estimated balance, not in repayment. Rate unknown — verify with FSA.",
    });
    console.log("  Seeded student loan debt");
  }

  // Seed credit scores
  const [existingCS] = await db.select().from(creditScores);
  if (!existingCS) {
    await db.insert(creditScores).values({
      asOfDate: "2026-01-01",
      experian: 756,
      equifax: 754,
      transunion: 736,
      notes: "January 2026 credit scores from Part B",
    });
    console.log("  Seeded credit scores");
  }

  // Seed retirement plan
  const [existingRet] = await db.select().from(retirementPlan);
  if (!existingRet) {
    await db.insert(retirementPlan).values({
      grossSalary: "54000.00",
      contributionRate: "0.03",
      employerMatchRate: "0.04",
      employerMatchCap: "0.04",
      currentBalance: "1550.00",
      currentAge: 30,
      targetAge: 65,
      returnAssumption: "0.07",
    });
    console.log("  Seeded retirement plan");
  }

  console.log("Seed complete.");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
