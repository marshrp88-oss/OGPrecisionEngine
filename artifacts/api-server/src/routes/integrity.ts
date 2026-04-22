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
  const latest = await getLatestIntegrityResult();
  if (!latest) {
    // No prior run — synthesize an initial run so the client always has state.
    const result = await runIntegrityAndPersist("status-bootstrap");
    res.json(RunIntegrityCheckResponse.parse(result));
    return;
  }
  res.json(RunIntegrityCheckResponse.parse(latest));
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
