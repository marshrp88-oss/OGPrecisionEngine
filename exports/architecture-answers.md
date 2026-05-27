# Reserve — Architecture Decisions
## Answers to the Five Load-Bearing Questions

These are answered from the perspective of the engineer who built the current code, with full visibility into `lib/finance/engine.ts`, `cycleBillEngine.ts`, `financeEngine.ts`, and the schema. Where the answer is mine to give, I give it. Where it requires Marshall's product call or his mother/friend's mental model, I say so explicitly and recommend a path.

---

## Q1 — The income event abstraction: what's the right primitive?

**Answer: one `IncomeEvent` type with two enums that compose. Not multiple types.**

```ts
type IncomeEvent = {
  id: string;
  userId: string;
  date: Date;                  // when the cash moves (or is expected to)
  amount: number;              // signed: positive=deposit, negative=withdrawal
  source: string;              // free-text label ("Odoo commission", "SS", "Job: Smith roof")
  kind: IncomeKind;            // semantic category (drives UI grouping)
  confidence: Confidence;      // drives ENGINE behavior — see below
  anchorsCycle: boolean;       // derived from confidence, can be overridden
  // optional projections
  estimatedRange?: { low: number; high: number };
  parentRuleId?: string;       // points to a recurring rule that generated it
};

enum IncomeKind {
  Salary, Commission, GigJob, SocialSecurity, Pension,
  InvestmentWithdrawal, RentalIncome, OneTime, Other,
}

enum Confidence {
  Confirmed,    // money already in account or scheduled by payer (SS, salary, pension, paid commission)
  Promised,     // known by counterparty, not yet received (Odoo's "this is your March payout" before the 22nd)
  Projected,    // rule-based estimate ("commissions average $208/mo over last 6 mo")
  Discretionary // user-initiated (mother's $X withdrawal from brokerage) — NEVER anchors a cycle
}
```

**Why one type, not many:** every "kind" of income reduces to the same three engine questions — *when does the cash move*, *how sure are we*, and *is it pulling cash in or pushing cash out*. The current engine has only one of these (commissions vs. base salary) and it's already showing strain in the `confirmedCommissionThisMonth` logic, which is really `Confidence === Confirmed` with the type fixed. A `confidence` field generalizes it cleanly.

**Why `confidence` is the load-bearing field (not `kind`):** the rule that matters for the cycle math is: **only `Confirmed` and `Promised` events can move the forward cycle boundary.** `Projected` informs the dashboard's "expected month income" total but cannot create a payday — otherwise the engine would tell a user "Safe to Spend = $300" because a projected event 6 days out invented a boundary. `Discretionary` is recorded for cash-flow accuracy but explicitly **never** anchors anything — Mom can decide to withdraw $0 next month.

**Withdrawals as negative income events, not a separate concept:** this is the cleaner choice. It collapses the cash-flow ledger to one stream, makes the dashboard's "next 30 days projected ending balance" a single sum, and avoids a second join in every query.

**What this changes in your existing engine:**
- `nextNominalPayday()` becomes `nextAnchoringEvent(events, today)` — returns the next event where `anchorsCycle === true`.
- `confirmedCommissionThisMonth()` becomes `sumEvents(events, { month, confidence: Confirmed })` — a one-liner.
- `safeToSpend` signature stays the same; only the boundary derivation changes.
- The `commissions` table stays as a *generator* of `IncomeEvent` rows (it owns the Odoo-tier math); it doesn't disappear.

---

## Q2 — Unit of cycle ownership with multiple deposits

**Answer: pooled-monthly *accounting*, sequential forward-boundary *safety check*. Both, not either.**

The dashboard math and the safety math answer different questions and should use different models.

**Pooled-monthly for "am I on track for the month":**
- All confirmed + promised income for the calendar month is summed.
- All bills + variable + one-times for the month are summed.
- Discretionary = pool_in − pool_out − end-of-month cushion.
- This is what your mother actually wants to see, and it's how she thinks. It's also what your existing `computeMonthlySavings` essentially does, just with one deposit.

**Sequential for "will I clear the next bill":**
- `Safe to Spend` keeps its current meaning: cash on hand minus everything I owe before the next anchoring deposit.
- "Next anchoring deposit" = the next `Confirmed` or `Promised` event after today.
- This catches the case the pooled view can't: SS hits the 3rd Wednesday, rent is due the 5th, pension hits the 1st — the pool says "fine for the month," but on the morning of the 4th there isn't enough cash because SS hasn't landed. The sequential check would flag this even though the monthly pool is positive.

**Why not "obligation-first" (assign each bill to a deposit):** it forces a setup step every user will get wrong, and it doesn't survive reality. Bills get paid out of whatever's in the account when they hit. The engine should *describe* what happens, not *prescribe* which deposit pays for what.

**Your friend's mental model is fine with this:** "do I have enough until the next job" is exactly the sequential check — his confirmed event count is just 0 or 1, and Safe to Spend treats his next promised job as the anchoring event.

**What this changes:**
- `billsInCurrentCycle` keeps its name and its strict `< nextAnchoringEvent` window.
- Add a `monthlyCashFlow` view (you essentially have this already as `MonthlySavingsState`).
- The dashboard headline shifts from "Safe to Spend" alone to *two* numbers stacked: "Safe until next deposit: $X" (sequential) and "On track for month: ±$Y" (pooled). Both visible, hierarchy depends on the user (see Q3).

---

## Q3 — Decumulation headline metric

**This one I have to defer in part — I don't know what your mother looks at first thing in the morning.** What I can do is narrow it to the right shape.

**My recommendation pending your call:**

The headline for a decumulation user is **"Is this month on track?"** — a signed dollar number, green/amber/red, with a sub-line "(at this pace, portfolio lasts until 20XX)." Reasoning:

1. The monthly question is the actionable one — she can change spending today.
2. The lifetime question is non-actionable on any given morning and *should not* be the first thing she sees, but it *must* be one tap away.
3. The yearly/4% question is a planning-tool question, not a daily-app question — it belongs on the Retirement / Plan page, not the dashboard.

**Concrete proposal for the decumulation dashboard:**

```
┌──────────────────────────────────────────┐
│  THIS MONTH                              │
│  +$340 on track                          │  ← headline (pooled monthly)
│  At this pace, plan lasts until 2041     │  ← sub-line, computed but quiet
├──────────────────────────────────────────┤
│  Safe to spend before next deposit       │
│  $1,210 (pension lands in 6 days)        │  ← sequential, secondary
├──────────────────────────────────────────┤
│  [Trajectory] [Spending] [Accounts]      │  ← drill-downs, including the
│                                          │     "will I run out" projection
└──────────────────────────────────────────┘
```

The sub-line is the trick: it makes the long-term question always visible without making it the source of daily anxiety. If the trajectory crosses a threshold (plan-lasts-until drops by more than 2 years month-over-month), the sub-line becomes the headline for that day with an explicit alert. Otherwise it's quiet text.

**What I need from you to finalize:** does she actually wake up worried about *this month* or *next year*? If the latter, swap the hierarchy. I genuinely cannot answer this without you asking her or showing her two mockups.

---

## Q4 — How much personalization survives, and where does it live?

**Answer: three layers, not two. Patterns generalize, defaults are per-user-archetype, instances are per-user.**

```
┌──── Layer 3: User instance ──────────────────────────┐
│  Marshall's bills, balances, his 43.5% rate,         │
│  his "alert when commission < $50 for 2 months"      │
└──────────────────────────────────────────────────────┘
            ▲
┌──── Layer 2: Archetype config (a "Playbook") ────────┐
│  "Variable-income earner" defaults:                  │
│    - default tax rate: 30%                           │
│    - drought alert: 2 months below 50% of avg        │
│    - YTD-vs-3mo-rolling display: ON                  │
│  "Fixed-income retiree" defaults:                    │
│    - default tax rate: 0% (already net)              │
│    - sustainable draw alert: ON                      │
│    - YTD display: OFF                                │
└──────────────────────────────────────────────────────┘
            ▲
┌──── Layer 1: Universal engine ───────────────────────┐
│  • consecutivePeriodsBelow(metric, threshold, n)     │ ← generic rule
│  • forwardProjection(events, bills, ...)             │
│  • cycleStatus(...)                                  │
│  • IncomeEvent semantics                             │
│  No defaults, no archetypes, pure math.              │
└──────────────────────────────────────────────────────┘
```

**Critical distinction the first option in your question collapses:**

The *pattern* "alert when N consecutive periods are below threshold T of metric M" is universal — it's a primitive that lives in Layer 1. Marshall's drought flag (`commission`, `$50`, `2 months`), a retiree's overspend flag (`monthly_burn`, `1.2 × average`, `3 months`), and a contractor's slow-period flag (`weekly_invoices`, `$X`, `3 weeks`) are all the **same primitive with different parameters**.

The *parameters* are Layer 2 (archetype defaults — "variable-income earner" gets a sensible drought default) or Layer 3 (user override — Marshall changes 2 months to 3).

**This means:**
- The 43.5% commission tax → Layer 3 (Marshall's setting; default to a state lookup in Layer 2).
- Drought flag → Layer 1 primitive + Layer 2 default + Layer 3 override.
- YTD-vs-3mo-rolling display → Layer 2 archetype toggle.
- Odoo quotas in the advisor system prompt → Layer 3 (Marshall's playbook).
- Decision-log format → Layer 1 (universal interaction pattern).

**The hard call you posed (config surface vs. playbook layer) is a false binary** — you want both. The playbook layer becomes a *bundle* of Layer 3 settings, distributable as a single artifact ("import Marshall's Odoo AE playbook") but composed of generic Layer 1 primitives. That gets you reusability without sacrificing your exact OG experience: Marshall's playbook is the default-loaded playbook on the OG instance, and it stays untouched.

---

## Q5 — Relationship between OG Reserve and Reserve going forward

**Answer: Reserve becomes canonical. OG becomes "Reserve with Marshall's playbook + UI locked to current shape." Write the doc that way.**

**Why:**

1. **Two engines is a maintenance bomb.** Every bug fix you find in Reserve's multi-deposit math is a candidate fix for OG, and the engines will drift. Six months in you will not remember which engine has which fix. You wrote `lib/finance/engine.ts` as a sealed package precisely because you'd already felt the pain of duplicated math — extending that principle, there should be exactly one engine in the company.

2. **The improvements you listed (multi-deposit cycle window, withholding liability account, mode-based headline) are not just generalizations — they are corrections.** Your current Forward Reserve math, even after the v9 fix making it a label, would be more honest if it could see actual upcoming deposits instead of inferring from `dueDay 1–7`. OG benefits from the migration.

3. **OG-as-preset is a real product, not a downgrade.** "Reserve, preconfigured for an Odoo AE with variable commission" is sellable. "Reserve, but actually a different codebase under the hood that we forgot to retire" is technical debt.

**What the migration looks like (one sentence, for the doc):**

> OG remains the production deployment for Marshall during the migration. The Reserve engine ships behind a feature flag; once dashboard parity is verified against three reference cycles (the audit cycles from the v8.2/v9 closures), OG cuts over and the legacy engine module is deleted.

**What this means for the spec:**

- Write it as "the engine, with OG as the reference deployment that proves backward compatibility." Not "a parallel engine that shares a library."
- Section the doc as: (1) the universal model, (2) the migration plan for OG, (3) the new archetypes (decumulation, gig). In that order.
- The acceptance criterion for the new engine includes "produces byte-identical cycle output for Marshall's last 3 months of data when given Marshall's playbook as input." This is your guardrail against silent regression.

---

## Summary of what I gave you vs. what I deferred

| Q | Answered | Deferred |
|---|----------|----------|
| 1 | Full recommendation: one type, `confidence` is load-bearing | — |
| 2 | Full recommendation: pooled monthly + sequential safety check | — |
| 3 | Shape and proposed layout | **Hierarchy depends on your mother's actual morning question — please ask or A/B mock** |
| 4 | Full architecture: 3 layers, pattern/default/instance split | — |
| 5 | Full recommendation: Reserve canonical, OG = preset | — |

The only genuine open question is the Q3 hierarchy. Every other answer is mine to give and is given.
