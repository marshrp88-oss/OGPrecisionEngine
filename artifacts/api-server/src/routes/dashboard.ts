import { Router, type IRouter } from "express";
import {
  GetDashboardCycleResponse,
  GetMonthlySavingsResponse,
} from "@workspace/api-zod";
import { computeCycleState, computeMonthlySavings } from "../lib/financeEngine";

const router: IRouter = Router();

router.get("/dashboard/cycle", async (_req, res): Promise<void> => {
  const cycle = await computeCycleState();
  res.json(
    GetDashboardCycleResponse.parse({
      ...cycle,
      lastBalanceUpdate: cycle.lastBalanceUpdate?.toISOString() ?? null,
      nextPayday: cycle.nextPayday?.toISOString().split("T")[0] ?? null,
    })
  );
});

router.get("/dashboard/monthly-savings", async (_req, res): Promise<void> => {
  const savings = await computeMonthlySavings();
  res.json(GetMonthlySavingsResponse.parse(savings));
});

export default router;
