import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  // Pass core schema through Zod for guarantees, then attach the advisor flag
  // as an additive field. The codegen client only consumes `status`; the
  // advisor page raw-fetches this endpoint to read `advisor_enabled` (T13).
  const base = HealthCheckResponse.parse({ status: "ok" });
  res.json({
    ...base,
    advisor_enabled: Boolean(process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY),
  });
});

export default router;
