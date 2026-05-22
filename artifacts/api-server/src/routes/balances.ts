import { Router, type IRouter } from "express";
import { db, balances, bills } from "@workspace/db";
import { eq, desc, gte, and } from "drizzle-orm";
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
  res.json(GetBalancesResponse.parse(latest.map((b) => ({ ...b, amount: parseFloat(b.amount as unknown as string) }))));
});

router.post("/balances", async (req, res): Promise<void> => {
  const parsed = CreateBalanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(balances)
    // Drizzle's numeric() insert type is `string`; pg accepts numbers and
    // coerces. We pass numbers (from zod) for ergonomics — see lib/db notes.
    .values({
      ...parsed.data,
      asOfDate: new Date(parsed.data.asOfDate),
    } as never)
    .returning();
  res.status(201).json(row);
});

/**
 * v8.2 — POST /balances/reconcile-suggestions
 *
 * Closes audit gap C3. Given a proposed new checking balance, looks at the
 * bills currently in `paid_pending_clear` state (the user clicked "paid" but
 * the debit hasn't shown up in checking yet) and tells the caller which
 * subset, if any, plausibly matches the drop in balance.
 *
 * Heuristic: if |delta + sum(subset)| < $5 for some subset of pending bills,
 * we return that subset with confidence="exact" (single bill matching alone)
 * or "close" (multi-bill sum match within tolerance). Otherwise confidence=
 * "none" and the caller proceeds without auto-clearing anything.
 *
 * NOTE: This is read-only — it does NOT mutate state. The UI is expected to
 * present the suggestion to the user, then call POST /bills/:id/mark-cleared
 * for each accepted suggestion. This keeps the side-effects explicit.
 */
router.post("/balances/reconcile-suggestions", async (req, res): Promise<void> => {
  const newAmount = typeof req.body?.newAmount === "number" ? req.body.newAmount : NaN;
  if (!Number.isFinite(newAmount)) {
    res.status(400).json({ error: "newAmount (number) is required" });
    return;
  }

  const [latest] = await db
    .select()
    .from(balances)
    .where(eq(balances.accountType, "checking"))
    .orderBy(desc(balances.asOfDate))
    .limit(1);
  const currentAmount = latest ? parseFloat(latest.amount as unknown as string) : 0;
  const delta = newAmount - currentAmount; // negative = balance dropped

  const pendingRows = await db
    .select()
    .from(bills)
    .where(and(eq(bills.paymentState, "paid_pending_clear"), eq(bills.includeInCycle, true)));
  const pending = pendingRows.map((b) => ({
    id: b.id,
    name: b.name,
    amount: parseFloat(b.amount as unknown as string),
  }));

  const TOL = 5; // $5 tolerance — accounts for rounding & small variances

  // Search for the best subset whose sum matches |delta|. With ~12 pending
  // bills max in practice (one cycle), brute-force 2^N is fine (N<=20 cap).
  let best: { ids: number[]; sum: number; exact: boolean } | null = null;
  if (delta < 0 && pending.length > 0 && pending.length <= 20) {
    const target = -delta;
    const N = pending.length;
    for (let mask = 1; mask < 1 << N; mask++) {
      let sum = 0;
      const ids: number[] = [];
      for (let i = 0; i < N; i++) {
        if (mask & (1 << i)) {
          sum += pending[i].amount;
          ids.push(pending[i].id);
        }
      }
      const diff = Math.abs(sum - target);
      if (diff < TOL) {
        if (!best || diff < Math.abs(best.sum - target) || (diff === Math.abs(best.sum - target) && ids.length < best.ids.length)) {
          best = { ids, sum, exact: diff < 0.01 };
        }
      }
    }
  }

  const suggestedIds = best?.ids ?? [];
  const suggested = pending.filter((p) => suggestedIds.includes(p.id));
  const confidence: "exact" | "close" | "none" = !best
    ? "none"
    : best.exact
      ? "exact"
      : "close";

  res.json({
    currentAmount,
    newAmount,
    delta,
    pendingBills: pending,
    suggestedClearIds: suggestedIds,
    suggestedBills: suggested,
    suggestedSum: best?.sum ?? 0,
    confidence,
    tolerance: TOL,
  });
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

  res.json(GetBalanceHistoryResponse.parse(filtered.map((b) => ({ ...b, amount: parseFloat(b.amount as unknown as string) }))));
});

export default router;
