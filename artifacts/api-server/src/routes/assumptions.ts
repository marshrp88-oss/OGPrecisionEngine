import { Router, type IRouter } from "express";
import { db, assumptions } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetAssumptionsResponse,
  UpdateAssumptionParams,
  UpdateAssumptionBody,
  UpdateAssumptionResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/assumptions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(assumptions).orderBy(assumptions.key);
  res.json(GetAssumptionsResponse.parse(rows));
});

router.put("/assumptions/:key", async (req, res): Promise<void> => {
  const params = UpdateAssumptionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = UpdateAssumptionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(assumptions).where(eq(assumptions.key, params.data.key));

  let row;
  if (existing) {
    [row] = await db
      .update(assumptions)
      .set({ value: body.data.value, updatedAt: new Date() })
      .where(eq(assumptions.key, params.data.key))
      .returning();
  } else {
    [row] = await db
      .insert(assumptions)
      .values({ key: params.data.key, value: body.data.value })
      .returning();
  }

  if (!row) {
    res.status(404).json({ error: "Assumption not found" });
    return;
  }

  res.json(UpdateAssumptionResponse.parse(row));
});

export default router;
