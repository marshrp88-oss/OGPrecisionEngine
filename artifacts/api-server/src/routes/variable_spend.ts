import { Router, type IRouter } from "express";
import { db, variableSpend } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
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
  const [row] = await db.insert(variableSpend).values(parsed.data).returning();
  if (!row) {
    res.status(500).json({ error: "Failed to create entry" });
    return;
  }
  res.status(201).json({ ...row, amount: parseFloat(row.amount) });
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
    .set(parsed.data)
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
