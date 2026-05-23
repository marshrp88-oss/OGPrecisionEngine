import { Router, type IRouter } from "express";
import { db, integrityLog } from "@workspace/db";
import { desc } from "drizzle-orm";
import {
  RunIntegrityCheckResponse,
  GetIntegrityHistoryResponse,
} from "@workspace/api-zod";
import {
  runIntegrityAndPersist,
  getLatestIntegrityResult,
} from "../lib/integrity";

const router: IRouter = Router();

router.post("/integrity/check", async (_req, res): Promise<void> => {
  const result = await runIntegrityAndPersist("manual");
  res.json(RunIntegrityCheckResponse.parse(result));
});

router.get("/integrity/status", async (_req, res): Promise<void> => {
  // v9 Fix 3 — always run fresh. Returning the last persisted row let stale
  // failures (e.g. an old "Next payday in the past" entry from before the
  // dynamic payday derivation landed) hang around in the banner forever even
  // after the underlying issue was fixed. Integrity is cheap to recompute and
  // the client polls infrequently — recompute on every read.
  const result = await runIntegrityAndPersist("status-read");
  void getLatestIntegrityResult; // kept for back-compat imports elsewhere
  res.json(RunIntegrityCheckResponse.parse(result));
});

router.get("/integrity/history", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(integrityLog)
    .orderBy(desc(integrityLog.runAt))
    .limit(20);
  const parsed = rows.map((r) => ({
    id: r.id,
    runAt: r.runAt,
    overallStatus: r.overallStatus as "pass" | "fail" | "warn",
    checks: r.checksJson as unknown[],
    notes: r.notes,
  }));
  res.json(GetIntegrityHistoryResponse.parse(parsed));
});

export default router;
