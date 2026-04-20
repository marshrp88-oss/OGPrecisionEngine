import { Router, type IRouter } from "express";
import { db, scenarios } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  GetScenariosResponse,
  CreateScenarioBody,
  GetScenarioParams,
  GetScenarioResponse,
  UpdateScenarioParams,
  UpdateScenarioBody,
  UpdateScenarioResponse,
  DeleteScenarioParams,
} from "@workspace/api-zod";
import { computeScenarioOutputs } from "../lib/financeEngine";

const router: IRouter = Router();

router.get("/scenarios", async (_req, res): Promise<void> => {
  const rows = await db.select().from(scenarios).orderBy(desc(scenarios.createdAt));
  res.json(GetScenariosResponse.parse(rows));
});

router.post("/scenarios", async (req, res): Promise<void> => {
  const parsed = CreateScenarioBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const outputsJson = computeScenarioOutputs(parsed.data.type, parsed.data.inputsJson as Record<string, unknown>);

  const [row] = await db
    .insert(scenarios)
    .values({
      ...parsed.data,
      outputsJson,
      saved: parsed.data.saved ?? false,
    })
    .returning();

  if (!row) {
    res.status(500).json({ error: "Failed to create scenario" });
    return;
  }
  res.status(201).json(row);
});

router.get("/scenarios/:id", async (req, res): Promise<void> => {
  const params = GetScenarioParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.select().from(scenarios).where(eq(scenarios.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Scenario not found" });
    return;
  }
  res.json(GetScenarioResponse.parse(row));
});

router.patch("/scenarios/:id", async (req, res): Promise<void> => {
  const params = UpdateScenarioParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateScenarioBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let updates: Partial<typeof scenarios.$inferSelect> = { ...parsed.data, updatedAt: new Date() };

  if (parsed.data.inputsJson) {
    const [existing] = await db.select().from(scenarios).where(eq(scenarios.id, params.data.id));
    if (existing) {
      const outputsJson = computeScenarioOutputs(existing.type, parsed.data.inputsJson as Record<string, unknown>);
      updates.outputsJson = outputsJson;
    }
  }

  const [row] = await db
    .update(scenarios)
    .set(updates)
    .where(eq(scenarios.id, params.data.id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Scenario not found" });
    return;
  }
  res.json(UpdateScenarioResponse.parse(row));
});

router.delete("/scenarios/:id", async (req, res): Promise<void> => {
  const params = DeleteScenarioParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(scenarios).where(eq(scenarios.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Scenario not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
