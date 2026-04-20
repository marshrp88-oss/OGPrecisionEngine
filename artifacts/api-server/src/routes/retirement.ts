import { Router, type IRouter } from "express";
import { db, retirementPlan } from "@workspace/db";
import {
  GetRetirementResponse,
  UpsertRetirementBody,
  UpsertRetirementResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeRetirement(row: typeof retirementPlan.$inferSelect) {
  return {
    ...row,
    grossSalary: parseFloat(row.grossSalary),
    contributionRate: parseFloat(row.contributionRate),
    employerMatchRate: parseFloat(row.employerMatchRate),
    employerMatchCap: parseFloat(row.employerMatchCap),
    currentBalance: parseFloat(row.currentBalance),
    returnAssumption: parseFloat(row.returnAssumption),
  };
}

router.get("/retirement", async (_req, res): Promise<void> => {
  const [row] = await db.select().from(retirementPlan).limit(1);
  if (!row) {
    // Return defaults
    res.json(
      GetRetirementResponse.parse({
        id: 0,
        grossSalary: 54000,
        contributionRate: 0.03,
        employerMatchRate: 0.04,
        employerMatchCap: 0.04,
        currentBalance: 1550,
        currentAge: 30,
        targetAge: 65,
        returnAssumption: 0.07,
        updatedAt: new Date().toISOString(),
      })
    );
    return;
  }
  res.json(GetRetirementResponse.parse(serializeRetirement(row)));
});

router.put("/retirement", async (req, res): Promise<void> => {
  const parsed = UpsertRetirementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(retirementPlan).limit(1);
  let row;
  if (existing) {
    [row] = await db
      .update(retirementPlan)
      .set({ ...parsed.data, updatedAt: new Date() })
      .returning();
  } else {
    [row] = await db.insert(retirementPlan).values(parsed.data).returning();
  }

  if (!row) {
    res.status(500).json({ error: "Failed to update retirement plan" });
    return;
  }
  res.json(UpsertRetirementResponse.parse(serializeRetirement(row)));
});

export default router;
