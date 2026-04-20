import { Router, type IRouter } from "express";
import { db, commissions, assumptions } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  GetCommissionsResponse,
  CreateCommissionBody,
  UpdateCommissionParams,
  UpdateCommissionBody,
  UpdateCommissionResponse,
  DeleteCommissionParams,
  GetCommissionSummaryResponse,
} from "@workspace/api-zod";
import {
  computeMrrPayout,
  computeNrrPayout,
  computeTakeHome,
  computePayoutDate,
} from "../lib/financeEngine";

const router: IRouter = Router();

async function calcCommission(mrrAchieved: number, nrrAchieved: number) {
  const [mrrTargetRow] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "mrr_target"));
  const [nrrTargetRow] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "nrr_target"));
  const [taxRateRow] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "commission_tax_rate"));

  const mrrTarget = mrrTargetRow ? parseFloat(mrrTargetRow.value) : 700;
  const nrrTarget = nrrTargetRow ? parseFloat(nrrTargetRow.value) : 6000;
  const taxRate = taxRateRow ? parseFloat(taxRateRow.value) : 0.435;

  const mrrPayout = computeMrrPayout(mrrAchieved, mrrTarget);
  const nrrPayout = computeNrrPayout(nrrAchieved, nrrTarget);
  const grossTotal = mrrPayout + nrrPayout;
  const takeHome = computeTakeHome(grossTotal, taxRate);

  return { mrrPayout, nrrPayout, grossTotal, takeHome };
}

function serializeCommission(row: typeof commissions.$inferSelect) {
  return {
    ...row,
    mrrAchieved: parseFloat(row.mrrAchieved),
    nrrAchieved: parseFloat(row.nrrAchieved),
    mrrPayout: parseFloat(row.mrrPayout),
    nrrPayout: parseFloat(row.nrrPayout),
    grossTotal: parseFloat(row.grossTotal),
    takeHome: parseFloat(row.takeHome),
  };
}

router.get("/commissions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(commissions).orderBy(desc(commissions.salesMonth));
  res.json(GetCommissionsResponse.parse(rows.map(serializeCommission)));
});

router.post("/commissions", async (req, res): Promise<void> => {
  const parsed = CreateCommissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { mrrPayout, nrrPayout, grossTotal, takeHome } = await calcCommission(
    parsed.data.mrrAchieved,
    parsed.data.nrrAchieved
  );

  const payoutDate = computePayoutDate(parsed.data.salesMonth);

  const [row] = await db
    .insert(commissions)
    .values({
      ...parsed.data,
      mrrPayout: mrrPayout.toString(),
      nrrPayout: nrrPayout.toString(),
      grossTotal: grossTotal.toString(),
      takeHome: takeHome.toString(),
      payoutDate,
    })
    .returning();

  if (!row) {
    res.status(500).json({ error: "Failed to create commission" });
    return;
  }
  res.status(201).json(serializeCommission(row));
});

router.patch("/commissions/:id", async (req, res): Promise<void> => {
  const params = UpdateCommissionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateCommissionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(commissions).where(eq(commissions.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Commission not found" });
    return;
  }

  const mrrAchieved = parsed.data.mrrAchieved ?? parseFloat(existing.mrrAchieved);
  const nrrAchieved = parsed.data.nrrAchieved ?? parseFloat(existing.nrrAchieved);
  const { mrrPayout, nrrPayout, grossTotal, takeHome } = await calcCommission(mrrAchieved, nrrAchieved);

  const salesMonth = parsed.data.salesMonth ?? existing.salesMonth;
  const payoutDate = computePayoutDate(salesMonth);

  const [row] = await db
    .update(commissions)
    .set({
      ...parsed.data,
      mrrPayout: mrrPayout.toString(),
      nrrPayout: nrrPayout.toString(),
      grossTotal: grossTotal.toString(),
      takeHome: takeHome.toString(),
      payoutDate,
      updatedAt: new Date(),
    })
    .where(eq(commissions.id, params.data.id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Commission not found" });
    return;
  }
  res.json(UpdateCommissionResponse.parse(serializeCommission(row)));
});

router.delete("/commissions/:id", async (req, res): Promise<void> => {
  const params = DeleteCommissionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(commissions).where(eq(commissions.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Commission not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/commissions/summary", async (_req, res): Promise<void> => {
  const rows = await db.select().from(commissions).orderBy(desc(commissions.salesMonth));

  const now = new Date();
  const ytdStart = `${now.getFullYear()}-01-01`;
  const ytdRows = rows.filter((r) => r.salesMonth >= ytdStart);
  const ytdTakeHome = ytdRows.reduce((sum, r) => sum + parseFloat(r.takeHome), 0);

  const last3 = rows.slice(0, 3);
  const last3Avg = last3.length > 0
    ? last3.reduce((sum, r) => sum + parseFloat(r.takeHome), 0) / last3.length
    : 0;

  const droughtThreshold = 50;
  const droughtMonths = rows.filter((r) => parseFloat(r.takeHome) < droughtThreshold).length;
  const droughtFlag = droughtMonths > 0;

  // Current month confirmed commission
  const payoutDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-22`;
  const confirmed = rows.find((r) => r.payoutDate === payoutDateStr && r.status === "confirmed");
  const currentMonthConfirmed = confirmed ? parseFloat(confirmed.takeHome) : 0;

  res.json(
    GetCommissionSummaryResponse.parse({
      ytdTakeHome: Math.round(ytdTakeHome * 100) / 100,
      last3MonthsAvg: Math.round(last3Avg * 100) / 100,
      droughtFlag,
      droughtMonths,
      currentMonthConfirmed,
    })
  );
});

export default router;
