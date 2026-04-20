import { Router, type IRouter } from "express";
import { db, debt } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetDebtResponse,
  CreateDebtBody,
  UpdateDebtParams,
  UpdateDebtBody,
  UpdateDebtResponse,
  DeleteDebtParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeDebt(row: typeof debt.$inferSelect) {
  return {
    ...row,
    balance: parseFloat(row.balance),
    interestRate: parseFloat(row.interestRate),
    minimumPayment: row.minimumPayment != null ? parseFloat(row.minimumPayment) : null,
  };
}

router.get("/debt", async (_req, res): Promise<void> => {
  const rows = await db.select().from(debt);
  res.json(GetDebtResponse.parse(rows.map(serializeDebt)));
});

router.post("/debt", async (req, res): Promise<void> => {
  const parsed = CreateDebtBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(debt).values(parsed.data).returning();
  if (!row) {
    res.status(500).json({ error: "Failed to create debt entry" });
    return;
  }
  res.status(201).json(serializeDebt(row));
});

router.patch("/debt/:id", async (req, res): Promise<void> => {
  const params = UpdateDebtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateDebtBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(debt)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(debt.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Debt entry not found" });
    return;
  }
  res.json(UpdateDebtResponse.parse(serializeDebt(row)));
});

router.delete("/debt/:id", async (req, res): Promise<void> => {
  const params = DeleteDebtParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(debt).where(eq(debt.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Debt entry not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
