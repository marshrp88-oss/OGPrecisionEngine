import { Router, type IRouter } from "express";
import { db, bills, assumptions } from "@workspace/db";
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

const router: IRouter = Router();

function computeNextDueDate(dueDay: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let d = new Date(today.getFullYear(), today.getMonth(), dueDay);
  if (d < today) {
    d = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
  }
  return d.toISOString().split("T")[0];
}

async function enrichBill(bill: typeof bills.$inferSelect) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const nextDueDateStr = computeNextDueDate(bill.dueDay);
  const nextDueDate = new Date(nextDueDateStr);

  // Get next payday from assumptions
  const [payRow] = await db.select().from(assumptions).where(eq(assumptions.key, "next_payday_date"));
  const nextPayday = payRow ? new Date(payRow.value) : null;

  // Check active_from/active_until
  let isActivePeriod = true;
  if (bill.activeFrom || bill.activeUntil) {
    const activeFrom = bill.activeFrom ? new Date(bill.activeFrom) : null;
    const activeUntil = bill.activeUntil ? new Date(bill.activeUntil) : null;
    if (activeFrom && today < activeFrom) isActivePeriod = false;
    if (activeUntil && today > activeUntil) isActivePeriod = false;
  }

  // Column H AND-gate: include=TRUE, amount>0, dueDate>=today, dueDate<nextPayday
  const amount = parseFloat(bill.amount);
  const countsThisCycle =
    bill.includeInCycle &&
    amount > 0 &&
    isActivePeriod &&
    nextDueDate >= today &&
    nextPayday !== null &&
    nextDueDate < nextPayday;

  return {
    ...bill,
    amount,
    countsThisCycle,
    nextDueDate: nextDueDateStr,
  };
}

router.get("/bills", async (_req, res): Promise<void> => {
  const rows = await db.select().from(bills).orderBy(bills.dueDay);
  const enriched = await Promise.all(rows.map(enrichBill));
  res.json(GetBillsResponse.parse(enriched));
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
  const enriched = await enrichBill(row);
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
  res.json(GetBillResponse.parse(await enrichBill(row)));
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
  res.json(UpdateBillResponse.parse(await enrichBill(row)));
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
