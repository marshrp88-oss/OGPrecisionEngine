import { Router, type IRouter } from "express";
import { db, bills, assumptions, commissions } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetBillsResponse,
  CreateBillBody,
  GetBillParams,
  GetBillResponse,
  UpdateBillParams,
  UpdateBillBody,
  UpdateBillResponse,
  DeleteBillParams,
} from "@workspace/api-zod";
import { enumerateBills, type EnrichedBill } from "../lib/cycleBillEngine";
import { deriveNextPayday } from "../lib/financeEngine";
import {
  BASE_NET_INCOME,
  MONTH_LENGTH_DAYS,
  VARIABLE_SPEND_CAP,
  Bill as EngineBill,
  forwardReserve as engineForwardReserve,
} from "@workspace/finance";

const router: IRouter = Router();

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function toApi(b: EnrichedBill) {
  return {
    id: b.id,
    name: b.name,
    amount: b.amount,
    dueDay: b.dueDay,
    frequency: b.frequency,
    category: b.category,
    autopay: b.autopay,
    notes: b.notes,
    includeInCycle: b.includeInCycle,
    activeFrom: b.activeFrom ? isoDate(b.activeFrom) : null,
    activeUntil: b.activeUntil ? isoDate(b.activeUntil) : null,
    countsThisCycle: b.countsThisCycle,
    nextDueDate: isoDate(b.nextDueDate),
    daysUntilDue: b.daysUntilDue,
    isActivePeriod: b.isActivePeriod,
  };
}

async function enrichBillRow(bill: typeof bills.$inferSelect) {
  const all = await enumerateBills();
  const found = all.find((x) => x.id === bill.id);
  if (!found) {
    return {
      ...bill,
      amount: parseFloat(bill.amount),
      countsThisCycle: false,
      nextDueDate: isoDate(new Date()),
    };
  }
  return toApi(found);
}

router.get("/bills", async (_req, res): Promise<void> => {
  const all = await enumerateBills();
  res.json(GetBillsResponse.parse(all.map(toApi)));
});

/**
 * Bills summary: rich aggregates for the Bills page.
 * Single round-trip — no client-side rollup math required.
 */
router.get("/bills/summary", async (_req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const all = await enumerateBills(today);
  const nextPayday = deriveNextPayday(today);

  // ----- Income context -----
  const allAssumps = await db.select().from(assumptions);
  const A = (k: string, dflt = 0) => {
    const r = allAssumps.find((a) => a.key === k);
    return r ? parseFloat(r.value) : dflt;
  };
  const baseNetIncome = A("base_net_income", BASE_NET_INCOME);
  const variableCap = A("variable_spend_cap", VARIABLE_SPEND_CAP);
  const monthLengthDays = A("month_length_days", MONTH_LENGTH_DAYS);

  // Confirmed commission expected this calendar month (paid OR scheduled)
  const allCommissions = await db.select().from(commissions);
  let commissionThisMonth = 0;
  for (const c of allCommissions) {
    if (!c.payoutDate) continue;
    const pd = new Date(c.payoutDate);
    if (pd.getFullYear() === today.getFullYear() && pd.getMonth() === today.getMonth()) {
      if (c.status === "paid" || c.status === "confirmed") {
        commissionThisMonth += parseFloat(c.takeHome);
      }
    }
  }
  const totalMonthIncome = baseNetIncome + commissionThisMonth;

  // ----- Totals -----
  const includedBills = all.filter((b) => b.countsThisMonth);
  const excludedBills = all.filter((b) => !b.includeInCycle || b.amount <= 0);
  const monthlyIncluded = includedBills.reduce((s, b) => s + b.amount, 0);
  const monthlyAll = all.reduce((s, b) => s + b.amount, 0);
  const annualIncluded = monthlyIncluded * 12;
  const percentOfNetIncome =
    totalMonthIncome > 0 ? (monthlyIncluded / totalMonthIncome) * 100 : 0;

  // ----- Category breakdown (Include=TRUE only) -----
  const categories = Array.from(new Set(includedBills.map((b) => b.category)));
  const categoryBreakdown = categories.map((cat) => {
    const items = includedBills.filter((b) => b.category === cat);
    const monthly = items.reduce((s, b) => s + b.amount, 0);
    return {
      category: cat,
      count: items.length,
      monthly: Math.round(monthly * 100) / 100,
      annual: Math.round(monthly * 12 * 100) / 100,
      percentOfBills: monthlyIncluded > 0 ? (monthly / monthlyIncluded) * 100 : 0,
      percentOfIncome: totalMonthIncome > 0 ? (monthly / totalMonthIncome) * 100 : 0,
    };
  });

  // ----- Autopay audit -----
  const autopayBills = includedBills.filter((b) => b.autopay);
  const manualBills = includedBills.filter((b) => !b.autopay);
  const autopayMonthly = autopayBills.reduce((s, b) => s + b.amount, 0);
  const manualMonthly = manualBills.reduce((s, b) => s + b.amount, 0);
  const upcomingManual = manualBills
    .filter((b) => b.daysUntilDue >= 0 && b.daysUntilDue <= 14)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  // ----- Upcoming timeline (next 14 days, all included bills) -----
  const upcomingTimeline = includedBills
    .filter((b) => b.daysUntilDue >= 0 && b.daysUntilDue <= 14)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue)
    .map((b) => ({
      id: b.id,
      name: b.name,
      amount: Math.round(b.amount * 100) / 100,
      category: b.category,
      autopay: b.autopay,
      dueDay: b.dueDay,
      nextDueDate: isoDate(b.nextDueDate),
      daysUntilDue: b.daysUntilDue,
      inCycle: b.countsThisCycle,
      risk: b.daysUntilDue <= 3 ? "high" : b.daysUntilDue <= 7 ? "medium" : "low",
    }));

  // ----- Income vs obligations -----
  // Forward Reserve via engine `forwardReserve` so the page reads the same
  // figure the dashboard does.
  const includedAsEngineBills: EngineBill[] = includedBills.map(
    (b) => new EngineBill(b.name, b.amount, b.dueDay, true, b.category, b.autopay),
  );
  const fwdReserve = engineForwardReserve(includedAsEngineBills, variableCap, monthLengthDays);
  const fixedBills = monthlyIncluded;
  const residualAfterFixed = totalMonthIncome - fixedBills;
  const residualAfterVariable = residualAfterFixed - variableCap;
  const residualPct = totalMonthIncome > 0 ? (residualAfterVariable / totalMonthIncome) * 100 : 0;

  res.json({
    asOf: isoDate(today),
    nextPayday: isoDate(nextPayday),
    totals: {
      monthlyIncluded: Math.round(monthlyIncluded * 100) / 100,
      monthlyAll: Math.round(monthlyAll * 100) / 100,
      annualIncluded: Math.round(annualIncluded * 100) / 100,
      activeCount: includedBills.length,
      excludedCount: excludedBills.length,
      percentOfNetIncome: Math.round(percentOfNetIncome * 10) / 10,
    },
    income: {
      baseNetIncome,
      commissionThisMonth: Math.round(commissionThisMonth * 100) / 100,
      totalMonthIncome: Math.round(totalMonthIncome * 100) / 100,
    },
    categoryBreakdown: categoryBreakdown.map((c) => ({
      ...c,
      percentOfBills: Math.round(c.percentOfBills * 10) / 10,
      percentOfIncome: Math.round(c.percentOfIncome * 10) / 10,
    })),
    autopayAudit: {
      autopayCount: autopayBills.length,
      autopayMonthly: Math.round(autopayMonthly * 100) / 100,
      manualCount: manualBills.length,
      manualMonthly: Math.round(manualMonthly * 100) / 100,
      manualPct: monthlyIncluded > 0 ? Math.round((manualMonthly / monthlyIncluded) * 1000) / 10 : 0,
      upcomingManual: upcomingManual.map((b) => ({
        id: b.id,
        name: b.name,
        amount: Math.round(b.amount * 100) / 100,
        nextDueDate: isoDate(b.nextDueDate),
        daysUntilDue: b.daysUntilDue,
      })),
    },
    upcomingTimeline,
    incomeVsObligations: {
      totalMonthIncome: Math.round(totalMonthIncome * 100) / 100,
      fixedBills: Math.round(fixedBills * 100) / 100,
      variableCap,
      residualAfterFixed: Math.round(residualAfterFixed * 100) / 100,
      residualAfterAll: Math.round(residualAfterVariable * 100) / 100,
      residualPct: Math.round(residualPct * 10) / 10,
      forwardReserve: Math.round(fwdReserve * 100) / 100,
    },
  });
});

router.post("/bills", async (req, res): Promise<void> => {
  const parsed = CreateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(bills).values(parsed.data).returning();
  if (!row) {
    res.status(500).json({ error: "Failed to create bill" });
    return;
  }
  const enriched = await enrichBillRow(row);
  res.status(201).json(enriched);
});

router.get("/bills/:id", async (req, res): Promise<void> => {
  const params = GetBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.select().from(bills).where(eq(bills.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.json(GetBillResponse.parse(await enrichBillRow(row)));
});

router.patch("/bills/:id", async (req, res): Promise<void> => {
  const params = UpdateBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateBillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(bills)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(bills.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.json(UpdateBillResponse.parse(await enrichBillRow(row)));
});

router.delete("/bills/:id", async (req, res): Promise<void> => {
  const params = DeleteBillParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(bills).where(eq(bills.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Bill not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
