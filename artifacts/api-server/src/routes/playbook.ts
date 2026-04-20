import { Router, type IRouter } from "express";
import { db, playbookVersions } from "@workspace/db";
import { desc } from "drizzle-orm";
import {
  GetPlaybookResponse,
  UpdatePlaybookBody,
  UpdatePlaybookResponse,
  GetPlaybookVersionsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const DEFAULT_PLAYBOOK_CONTENT = `# Personal Finance Advisor Playbook v7.3

## Core Methodology Rules (Non-Negotiable)

### Rule 1 — Paycheck Boundary Rule
All savings calculations use the paycheck boundary, never the calendar month-end. Bills due 1st–7th of a month must be reserved from the prior 22nd paycheck.

### Rule 2 — Commission-as-Zero Rule  
Baseline savings calculations assume $0 commission income unless there is a confirmed payout with a verified date. Never pre-count expected commission.

### Rule 3 — Column H AND-Gate
A bill counts against the current cycle only if: Include=TRUE, Amount>0, Due Date >= today, AND Due Date < next payday. Bills due ON payday are excluded.

### Rule 4 — Forward Reserve Exclusion
The forward reserve is subtracted from monthly savings but NOT from Safe to Spend. These answer different questions.

### Rule 5 — One-Time Cost Gating
A one-time expense is reserved only when it has both an amount AND a due date between today and next payday.

### Rule 6 — Stale Data Failure Mode
If the last balance update is more than 3 days old, all cycle outputs show a blocking warning. Refuse cycle analysis until the user updates.

### Rule 7 — Variable Spend Proration
Monthly variable cap ÷ 30.4 days = per-day variable budget. For partial periods, multiply by days remaining.

### Rule 8 — QuickSilver Accrual
Credit card variable spending is tracked separately and subtracted from monthly savings estimates.

### Rule 9 — Commission Tax Rate
Commission take-home is calculated at 43.5% effective tax rate.

### Rule 10 — YELLOW Status Threshold
Safe to Spend below $400 triggers YELLOW status. Recalibrate when the largest known irregular expense changes.

## What the Advisor Must NOT Do
- Calculate savings at calendar month-end (always use paycheck boundary)
- Include expected commission in baseline calculations
- Run cycle analysis on stale data (>3 days old)
- Give portfolio allocation advice (user self-manages brokerage)
- Recommend aggressive debt paydown without confirmed interest rate

## Financial Profile
- Name: Marshall Roberts-Payne
- Role: Account Executive, Odoo Inc.
- Base salary: $54,000/year
- Pay schedule: Semi-monthly, 7th and 22nd
- Commission: MRR + NRR tiered piecewise, paid 22nd of following month
- Commission tax rate: 43.5%
- Location: Buffalo, NY
- HYSA target: $15,000
- 401(k): Contributing 3% vs 4% match cap (gap active)
- Student loans: ~$30,000 federal, not in repayment, rates unconfirmed
`;

router.get("/playbook", async (_req, res): Promise<void> => {
  const [row] = await db.select().from(playbookVersions).orderBy(desc(playbookVersions.effectiveFrom)).limit(1);
  if (!row) {
    // Seed default playbook
    const [newRow] = await db
      .insert(playbookVersions)
      .values({
        version: "7.3",
        content: DEFAULT_PLAYBOOK_CONTENT,
        effectiveFrom: new Date(),
        notes: "Initial version seeded from brief",
      })
      .returning();
    res.json(GetPlaybookResponse.parse(newRow));
    return;
  }
  res.json(GetPlaybookResponse.parse(row));
});

router.put("/playbook", async (req, res): Promise<void> => {
  const parsed = UpdatePlaybookBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(playbookVersions)
    .values({
      version: parsed.data.version,
      content: parsed.data.content,
      effectiveFrom: new Date(),
      notes: parsed.data.notes ?? null,
    })
    .returning();
  if (!row) {
    res.status(500).json({ error: "Failed to update playbook" });
    return;
  }
  res.json(UpdatePlaybookResponse.parse(row));
});

router.get("/playbook/versions", async (_req, res): Promise<void> => {
  const rows = await db.select().from(playbookVersions).orderBy(desc(playbookVersions.effectiveFrom));
  res.json(GetPlaybookVersionsResponse.parse(rows));
});

export default router;
