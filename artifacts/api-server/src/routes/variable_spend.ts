import { Router, type IRouter } from "express";
import { db, variableSpend } from "@workspace/db";
import { eq, desc, and, isNull } from "drizzle-orm";
import {
  GetVariableSpendResponse,
  GetVariableSpendQueryParams,
  CreateVariableSpendEntryBody,
  UpdateVariableSpendEntryParams,
  UpdateVariableSpendEntryBody,
  UpdateVariableSpendEntryResponse,
  DeleteVariableSpendEntryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/variable-spend", async (req, res): Promise<void> => {
  const qp = GetVariableSpendQueryParams.safeParse(req.query);
  const weeks = qp.success ? qp.data.weeks : undefined;

  let rows = await db.select().from(variableSpend).orderBy(desc(variableSpend.weekOf));

  if (weeks) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const cutoffStr = cutoff.toISOString().split("T")[0];
    rows = rows.filter((r) => r.weekOf >= cutoffStr);
  }

  const mapped = rows.map((r) => ({ ...r, amount: parseFloat(r.amount) }));
  res.json(GetVariableSpendResponse.parse(mapped));
});

router.post("/variable-spend", async (req, res): Promise<void> => {
  const parsed = CreateVariableSpendEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(variableSpend).values(parsed.data as never).returning();
  if (!row) {
    res.status(500).json({ error: "Failed to create entry" });
    return;
  }
  res.status(201).json({ ...row, amount: parseFloat(row.amount) });
});

// v8.0 Final Fix — bulk-settle every unpaid QuickSilver row. This drops the
// rows out of the cycle's quicksilverOwed hold so the dollar (already counted
// once as consumption) is not counted a second time as settlement.
router.post("/variable-spend/quicksilver/mark-paid", async (_req, res): Promise<void> => {
  const settled = await db
    .update(variableSpend)
    .set({ paidOffAt: new Date() })
    .where(and(eq(variableSpend.quicksilver, true), isNull(variableSpend.paidOffAt)))
    .returning();
  const settledAmount = settled.reduce((s, r) => s + parseFloat(r.amount), 0);
  res.json({ settledCount: settled.length, settledAmount });
});

router.patch("/variable-spend/:id", async (req, res): Promise<void> => {
  const params = UpdateVariableSpendEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateVariableSpendEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(variableSpend)
    .set(parsed.data as never)
    .where(eq(variableSpend.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  res.json(UpdateVariableSpendEntryResponse.parse({ ...row, amount: parseFloat(row.amount) }));
});

router.delete("/variable-spend/:id", async (req, res): Promise<void> => {
  const params = DeleteVariableSpendEntryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(variableSpend).where(eq(variableSpend.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Entry not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
