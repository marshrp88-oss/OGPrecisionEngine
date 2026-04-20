import { Router, type IRouter } from "express";
import healthRouter from "./health";
import assumptionsRouter from "./assumptions";
import balancesRouter from "./balances";
import billsRouter from "./bills";
import oneTimeExpensesRouter from "./one_time_expenses";
import variableSpendRouter from "./variable_spend";
import commissionsRouter from "./commissions";
import wealthRouter from "./wealth";
import debtRouter from "./debt";
import retirementRouter from "./retirement";
import scenariosRouter from "./scenarios";
import playbookRouter from "./playbook";
import integrityRouter from "./integrity";
import dashboardRouter from "./dashboard";
import anthropicRouter from "./anthropic";

const router: IRouter = Router();

router.use(healthRouter);
router.use(assumptionsRouter);
router.use(balancesRouter);
router.use(billsRouter);
router.use(oneTimeExpensesRouter);
router.use(variableSpendRouter);
router.use(commissionsRouter);
router.use(wealthRouter);
router.use(debtRouter);
router.use(retirementRouter);
router.use(scenariosRouter);
router.use(playbookRouter);
router.use(integrityRouter);
router.use(dashboardRouter);
router.use(anthropicRouter);

export default router;
