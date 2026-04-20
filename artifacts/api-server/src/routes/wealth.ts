import { Router, type IRouter } from "express";
import { db, wealthSnapshots, creditScores } from "@workspace/db";
import { eq, desc, asc } from "drizzle-orm";
import {
  GetWealthSnapshotsResponse,
  CreateWealthSnapshotBody,
  UpdateWealthSnapshotParams,
  UpdateWealthSnapshotBody,
  UpdateWealthSnapshotResponse,
  DeleteWealthSnapshotParams,
  GetCreditScoresResponse,
  CreateCreditScoreBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeSnapshot(row: typeof wealthSnapshots.$inferSelect) {
  return {
    ...row,
    hysa: parseFloat(row.hysa),
    brokerage: parseFloat(row.brokerage),
    retirement401k: parseFloat(row.retirement401k),
    otherAssets: parseFloat(row.otherAssets),
    totalAssets: parseFloat(row.totalAssets),
    carLoan: parseFloat(row.carLoan),
    studentLoans: parseFloat(row.studentLoans),
    otherLiabilities: parseFloat(row.otherLiabilities),
    totalLiabilities: parseFloat(row.totalLiabilities),
    netWorth: parseFloat(row.netWorth),
    changeVsPrior: row.changeVsPrior != null ? parseFloat(row.changeVsPrior) : null,
  };
}

function computeSnapshotTotals(data: {
  hysa: number; brokerage: number; retirement401k: number; otherAssets: number;
  carLoan: number; studentLoans: number; otherLiabilities: number;
}) {
  const totalAssets = data.hysa + data.brokerage + data.retirement401k + data.otherAssets;
  const totalLiabilities = data.carLoan + data.studentLoans + data.otherLiabilities;
  const netWorth = totalAssets - totalLiabilities;
  return { totalAssets, totalLiabilities, netWorth };
}

router.get("/wealth/snapshots", async (_req, res): Promise<void> => {
  const rows = await db.select().from(wealthSnapshots).orderBy(desc(wealthSnapshots.snapshotDate));
  res.json(GetWealthSnapshotsResponse.parse(rows.map(serializeSnapshot)));
});

router.post("/wealth/snapshots", async (req, res): Promise<void> => {
  const parsed = CreateWealthSnapshotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { totalAssets, totalLiabilities, netWorth } = computeSnapshotTotals({
    hysa: parsed.data.hysa,
    brokerage: parsed.data.brokerage,
    retirement401k: parsed.data.retirement401k,
    otherAssets: parsed.data.otherAssets,
    carLoan: parsed.data.carLoan,
    studentLoans: parsed.data.studentLoans,
    otherLiabilities: parsed.data.otherLiabilities,
  });

  // Compute changeVsPrior
  const [prev] = await db.select().from(wealthSnapshots).orderBy(desc(wealthSnapshots.snapshotDate)).limit(1);
  const prevNetWorth = prev ? parseFloat(prev.netWorth) : null;
  const changeVsPrior = prevNetWorth != null ? netWorth - prevNetWorth : null;

  const [row] = await db
    .insert(wealthSnapshots)
    .values({
      ...parsed.data,
      totalAssets: totalAssets.toString(),
      totalLiabilities: totalLiabilities.toString(),
      netWorth: netWorth.toString(),
      changeVsPrior: changeVsPrior != null ? changeVsPrior.toString() : null,
    })
    .returning();

  if (!row) {
    res.status(500).json({ error: "Failed to create snapshot" });
    return;
  }
  res.status(201).json(serializeSnapshot(row));
});

router.patch("/wealth/snapshots/:id", async (req, res): Promise<void> => {
  const params = UpdateWealthSnapshotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateWealthSnapshotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(wealthSnapshots).where(eq(wealthSnapshots.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }

  const merged = {
    hysa: parsed.data.hysa ?? parseFloat(existing.hysa),
    brokerage: parsed.data.brokerage ?? parseFloat(existing.brokerage),
    retirement401k: parsed.data.retirement401k ?? parseFloat(existing.retirement401k),
    otherAssets: parsed.data.otherAssets ?? parseFloat(existing.otherAssets),
    carLoan: parsed.data.carLoan ?? parseFloat(existing.carLoan),
    studentLoans: parsed.data.studentLoans ?? parseFloat(existing.studentLoans),
    otherLiabilities: parsed.data.otherLiabilities ?? parseFloat(existing.otherLiabilities),
  };

  const { totalAssets, totalLiabilities, netWorth } = computeSnapshotTotals(merged);

  const [row] = await db
    .update(wealthSnapshots)
    .set({
      ...parsed.data,
      totalAssets: totalAssets.toString(),
      totalLiabilities: totalLiabilities.toString(),
      netWorth: netWorth.toString(),
    })
    .where(eq(wealthSnapshots.id, params.data.id))
    .returning();

  if (!row) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }
  res.json(UpdateWealthSnapshotResponse.parse(serializeSnapshot(row)));
});

router.delete("/wealth/snapshots/:id", async (req, res): Promise<void> => {
  const params = DeleteWealthSnapshotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(wealthSnapshots).where(eq(wealthSnapshots.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }
  res.sendStatus(204);
});

router.get("/wealth/credit-scores", async (_req, res): Promise<void> => {
  const rows = await db.select().from(creditScores).orderBy(desc(creditScores.asOfDate));
  res.json(GetCreditScoresResponse.parse(rows));
});

router.post("/wealth/credit-scores", async (req, res): Promise<void> => {
  const parsed = CreateCreditScoreBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(creditScores).values(parsed.data).returning();
  if (!row) {
    res.status(500).json({ error: "Failed to create credit score" });
    return;
  }
  res.status(201).json(row);
});

export default router;
