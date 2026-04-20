import { Router, type IRouter } from "express";
import { db, balances } from "@workspace/db";
import { eq, desc, gte } from "drizzle-orm";
import {
  GetBalancesResponse,
  CreateBalanceBody,
  GetBalanceHistoryResponse,
  GetBalanceHistoryQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/balances", async (_req, res): Promise<void> => {
  // Return latest balance per account type
  const all = await db.select().from(balances).orderBy(desc(balances.asOfDate));
  const seen = new Set<string>();
  const latest: typeof all = [];
  for (const row of all) {
    if (!seen.has(row.accountType)) {
      seen.add(row.accountType);
      latest.push(row);
    }
  }
  res.json(GetBalancesResponse.parse(latest));
});

router.post("/balances", async (req, res): Promise<void> => {
  const parsed = CreateBalanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(balances)
    .values({
      ...parsed.data,
      asOfDate: new Date(parsed.data.asOfDate),
    })
    .returning();
  res.status(201).json(row);
});

router.get("/balances/history", async (req, res): Promise<void> => {
  const queryParams = GetBalanceHistoryQueryParams.safeParse(req.query);
  const accountType = queryParams.success ? queryParams.data.account_type : undefined;
  const days = queryParams.success ? queryParams.data.days : undefined;

  let query = db.select().from(balances).orderBy(desc(balances.asOfDate));

  const rows = await query;
  let filtered = rows;

  if (accountType) {
    filtered = filtered.filter((r) => r.accountType === accountType);
  }
  if (days) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    filtered = filtered.filter((r) => new Date(r.asOfDate) >= cutoff);
  }

  res.json(GetBalanceHistoryResponse.parse(filtered));
});

export default router;
