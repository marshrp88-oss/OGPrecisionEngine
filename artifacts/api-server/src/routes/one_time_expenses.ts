import { Router, type IRouter } from "express";
import { db, oneTimeExpenses, assumptions } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetOneTimeExpensesResponse,
  CreateOneTimeExpenseBody,
  UpdateOneTimeExpenseParams,
  UpdateOneTimeExpenseBody,
  UpdateOneTimeExpenseResponse,
  DeleteOneTimeExpenseParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function enrichExpense(ote: typeof oneTimeExpenses.$inferSelect) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [payRow] = await db.select().from(assumptions).where(eq(assumptions.key, "next_payday_date"));
  const nextPayday = payRow ? new Date(payRow.value) : null;

  let countsThisCycle = false;
  if (ote.dueDate && !ote.paid) {
    const dueDate = new Date(ote.dueDate);
    const amount = parseFloat(ote.amount);
    countsThisCycle =
      amount > 0 &&
      dueDate >= today &&
      nextPayday !== null &&
      dueDate <= nextPayday;
  }

  return { ...ote, amount: parseFloat(ote.amount), countsThisCycle };
}

router.get("/one-time-expenses", async (_req, res): Promise<void> => {
  const rows = await db.select().from(oneTimeExpenses).orderBy(oneTimeExpenses.dueDate);
  const enriched = await Promise.all(rows.map(enrichExpense));
  res.json(GetOneTimeExpensesResponse.parse(enriched));
});

router.post("/one-time-expenses", async (req, res): Promise<void> => {
  const parsed = CreateOneTimeExpenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(oneTimeExpenses).values(parsed.data).returning();
  if (!row) {
    res.status(500).json({ error: "Failed to create expense" });
    return;
  }
  res.status(201).json(await enrichExpense(row));
});

router.patch("/one-time-expenses/:id", async (req, res): Promise<void> => {
  const params = UpdateOneTimeExpenseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateOneTimeExpenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(oneTimeExpenses)
    .set(parsed.data)
    .where(eq(oneTimeExpenses.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Expense not found" });
    return;
  }
  res.json(UpdateOneTimeExpenseResponse.parse(await enrichExpense(row)));
});

router.delete("/one-time-expenses/:id", async (req, res): Promise<void> => {
  const params = DeleteOneTimeExpenseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(oneTimeExpenses).where(eq(oneTimeExpenses.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Expense not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
