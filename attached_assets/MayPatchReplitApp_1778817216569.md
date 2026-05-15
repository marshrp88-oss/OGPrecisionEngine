# RESERVE — Revised Master Plan (April 30 Session)

**Authority:** This document supersedes `APRIL_30_PLAN.md`, `FIX_PLAN.md`, and `FIX_PLAN_PART_K.md` for the April 30 session. Where any of them conflict, this one wins. The earlier documents remain as reference but should not be executed directly.

**Audience:** Replit Agent 4, executed when credits restore.

**Why this plan exists:** Two cumulative reviews — one by Claude (the engineering thread), one by the financial advisor thread — surfaced overlapping but differently-framed issue lists. Critically, both surfaced that the app's primary output ("Discretionary") does not match how the user actually thinks about money. That is a structural mismatch, not a bug. This plan resolves the structural question first and only then proceeds to defects.

**Three principles that override everything else:**

1. **Match the user's mental model.** The app is anchored to calendar months in the user's head. Anywhere the app uses cycle-anchored math as the primary frame, it is wrong — even when the math is "correct." Re-anchor to monthly. Cycle math stays available where it answers a real question (liquidity, payday boundary) but is never the headline.

2. **Editability is a right, not a feature.** Every user-owned value is editable from the UI where it lives. No exception. No "ask the AI agent to update this" workaround.

3. **The session-start ritual prevents staleness.** A guided 30-second checklist on app open does more than fixing 10 individual staleness symptoms. Build the ritual; then symptoms fade.

---

## PART 0 — Architectural Decisions (resolve before any code)

### 0.1 Resolve Monthly vs Cycle Anchoring

**Decision:** The Dashboard's primary numeric output is the **Monthly Discretionary** figure, anchored to the calendar month. The cycle-anchored "Safe to Spend" remains a secondary co-equal output for liquidity decisions, but Monthly is the bigger, more prominent figure.

**Rationale:** The user's Excel workbook frames savings around the calendar month. End-of-month is when he asks "what did this month produce that I can move to HYSA / Roth / brokerage?" The cycle frame (paycheck-to-paycheck) is a defensive liquidity frame, useful for "will I miss a bill before payday" but not for "what can I save this month." Two different questions, two different unit boundaries.

**What this means in code:** Add a new function `discretionaryThisMonth(ctx)` from scratch. Do not patch the existing `discretionaryThisCycle`. The cycle version continues to exist (for the Safe to Spend math) but is no longer the headline displayed value.

### 0.2 Define the Three Core Outputs Clearly

Three numbers, three questions, three placements:

| Output | Anchor | Question Answered | Dashboard Placement |
|---|---|---|---|
| **Discretionary This Month** | Calendar month | "What is this month producing that I could save or invest?" | **Primary card, largest, top-left** |
| **Safe to Spend** | Paycheck boundary | "Can I spend today without missing a bill before next payday?" | Secondary card, top-right |
| **Monthly Savings Estimate** | Forward-looking, paycheck-anchored | "What will this paycheck-boundary cycle leave behind at next payday?" | Tertiary, below or expandable |

All three remain visible. The headline is Monthly. Safe to Spend is the daily-decision number. Monthly Savings is the forward-paycheck-boundary number that already exists.

### 0.3 Confirm Session-Start Workflow

**Decision:** Build a session-start checklist that fires once per day on first app open. Five items, each with a quick path to complete or dismiss. The checklist is the single highest-leverage workflow improvement in this plan — it addresses staleness, payday drift, commission tracking, and overdue items in one ritual instead of as separate band-aids.

Details in Part 1.

---

## PART 1 — Critical Foundations (P0)

### 1.1 Session-Start Checklist

**Priority:** P0 (highest leverage item in the plan)

**Why first:** Addresses the root cause of half the defects on the list. Variable spend going stale, payday not advancing, commission pipeline empty, overdue items ignored — all are symptoms of "user has no daily ritual to keep data fresh." A 30-second checklist closes most of these without per-symptom fixes.

**Implementation:**

A modal that fires on the first session of each calendar day (track via localStorage or a `last_session_date` field). Cannot be skipped permanently — can be dismissed for the day but reappears tomorrow. Visually unobtrusive but present.

Five items:

1. **Confirm checking balance.** Display current balance + as-of date. Two buttons: "Still accurate" or "Update now." Update opens balance modal.

2. **Log variable spend since last session.** Display "Last variable spend log entry: {date} — {N days ago}." Two options: "Nothing new to log" or "Log spend now" (opens quick-log).

3. **Review overdue and upcoming one-time expenses.** Display any one-time expenses overdue or due in next 14 days. Mark paid / update / dismiss per item.

4. **Update commission pipeline.** Display "Last commission entry / pipeline update: {date}." Prompt: any new deals to log, status changes, or closed-won this week? Options: "No changes" or "Update pipeline."

5. **Confirm next payday.** Display detected next payday based on today's date and the 7th/22nd schedule (auto-advanced — see 1.4). Confirm or override.

After all five are confirmed or dismissed, the modal closes and the Dashboard loads with fresh state. A "Last session start: {timestamp}" indicator appears somewhere subtle on the Dashboard so the user can see when ritual last ran.

**Verification:**
- Open app for first time on a given day: checklist appears
- Run through all five items: closes successfully, doesn't reappear that day
- Reopen app later same day: no checklist (already done)
- Open app next day: checklist reappears
- Skip an item: it still tracks in Integrity Check as a warning until addressed

---

### 1.2 Discretionary This Month — Rewrite from Scratch

**Priority:** P0

**Why critical:** This is the number the user uses to make decisions. Currently broken because (a) it's cycle-anchored not month-anchored, (b) it doesn't include remaining-month paychecks as income, (c) variable spend pro-rata projection is the wrong model — it should subtract actual logged spend from cap, not project pace.

**Formula:**

```typescript
function discretionaryThisMonth(ctx: FinanceContext): MonthlyDiscretionaryResult {
  const monthStart = startOfMonth(ctx.today);
  const monthEnd = endOfMonth(ctx.today);
  
  // === INCOME ===
  
  // Paychecks already received this month
  const paychecksReceivedThisMonth = ctx.paychecks
    .filter(p => p.depositDate >= monthStart && p.depositDate <= ctx.today)
    .reduce((s, p) => s + p.netAmount, 0);
  
  // Paychecks still expected this month (effective payday in this month, after today)
  const remainingPaydaysThisMonth = computePaydaysInMonth(ctx.today, monthEnd)
    .filter(d => d > ctx.today);
  const expectedRemainingPaychecks = remainingPaydaysThisMonth.length * ctx.baseNetPerPaycheck;
  
  // Commission paid this month (already in checking)
  const commissionPaidThisMonth = ctx.commissions
    .filter(c => c.payoutDate >= monthStart && c.payoutDate <= ctx.today)
    .filter(c => c.status === 'paid')
    .reduce((s, c) => s + commissionTakeHome(c.mrr, c.nrr, ctx.mrrTarget, ctx.nrrTarget, ctx.taxRate), 0);
  
  // Commission still pending this month (confirmed payout date is this month, after today)
  const commissionPendingThisMonth = ctx.commissions
    .filter(c => c.payoutDate > ctx.today && c.payoutDate <= monthEnd)
    .filter(c => c.status === 'pending')
    .reduce((s, c) => s + commissionTakeHome(c.mrr, c.nrr, ctx.mrrTarget, ctx.nrrTarget, ctx.taxRate), 0);
  
  const totalMonthIncome = paychecksReceivedThisMonth 
    + expectedRemainingPaychecks 
    + commissionPaidThisMonth 
    + commissionPendingThisMonth;
  
  // === OUTGO ===
  
  // All bills with this month's due date (include=true)
  const billsThisMonth = ctx.bills
    .filter(b => b.include === true)
    .filter(b => billDueDateInMonth(b, ctx.today))
    .reduce((s, b) => s + b.amount, 0);
  
  // Variable spend already logged this month (actual)
  const variableLoggedThisMonth = ctx.variableSpendLog
    .filter(e => e.weekStartDate >= monthStart && e.weekStartDate <= monthEnd)
    .reduce((s, e) => s + e.amount, 0);
  
  // Expected variable spend remaining this month
  // Two modes:
  //   Mode A (default): remaining cap = MAX(0, monthly_cap - logged_this_month)
  //   Mode B (user opt-in): explicit planned remaining variable amount
  const variableCapRemaining = Math.max(0, ctx.variableSpendCap - variableLoggedThisMonth);
  const expectedVariableRemaining = ctx.plannedVariableRemainingOverride ?? variableCapRemaining;
  
  // One-time expenses (all unpaid this month, regardless of date)
  const oneTimeThisMonth = ctx.oneTimeExpenses
    .filter(e => e.paid === false)
    .filter(e => e.dueDate === null || e.dueDate <= monthEnd)
    .reduce((s, e) => s + e.amount, 0);
  
  // QuickSilver real balance owed (from card accrual not yet paid off)
  const quicksilverOwed = ctx.quicksilverBalanceOwed ?? 0;
  
  const totalMonthOutgo = billsThisMonth 
    + variableLoggedThisMonth 
    + expectedVariableRemaining 
    + oneTimeThisMonth 
    + quicksilverOwed;
  
  // === RESULT ===
  
  const discretionary = totalMonthIncome - totalMonthOutgo;
  
  return {
    discretionary,
    income: {
      paychecksReceived: paychecksReceivedThisMonth,
      expectedRemaining: expectedRemainingPaychecks,
      commissionPaid: commissionPaidThisMonth,
      commissionPending: commissionPendingThisMonth,
      total: totalMonthIncome,
    },
    outgo: {
      bills: billsThisMonth,
      variableLogged: variableLoggedThisMonth,
      variableExpected: expectedVariableRemaining,
      oneTime: oneTimeThisMonth,
      quicksilverOwed,
      total: totalMonthOutgo,
    },
  };
}
```

**Important behaviors:**

- Discretionary CAN go negative. When it does, display the negative number prominently — that's the truth. Negative discretionary means this month is consuming reserves to cover obligations.
- Updates in real-time as user logs spend, marks bills paid, confirms commission, etc.
- Recomputes when crossing month boundary. On the 1st, all month-anchored math rolls.

**UI:**

Primary card on Dashboard, largest, top of grid. Labeled "Discretionary This Month — May 2026" (the month name updates).

The card shows:
- Current month value (e.g., "$343.50")
- Subtitle: "What this month produces that you can save or invest"
- Always-visible "Show breakdown" expandable — when open shows the full income/outgo waterfall:
  ```
  INCOME THIS MONTH
    Paychecks received                $X
    + Expected remaining paychecks    $X
    + Commission paid                 $X
    + Commission pending              $X
    = Total Income                    $X
  
  OUTGO THIS MONTH
    - Bills (all month due dates)     ($X)
    - Variable spend logged           ($X)
    - Variable expected remaining     ($X)
    - One-time expenses               ($X)
    - QuickSilver balance owed        ($X)
    = Total Outgo                     ($X)
  
  = DISCRETIONARY THIS MONTH          $X
  ```

**Verification:**

Test case 1: May 14, 2026, checking $767, $0 commission, $0 variable logged for May yet:
- Income: 0 received + 1 remaining paycheck (May 22, ~$1,610) + 0 commission = $1,610
- Wait — this only includes May 22. The May 7 paycheck already happened. Need to include it.
- Recompute income: $1,610 (May 7 received) + $1,610 (May 22 expected) + $0 = $3,220
- Outgo: Bills $1,833.95 + Variable logged $0 + Variable expected $600 + One-time $0 + QS $0 = $2,433.95
- Discretionary = $3,220 - $2,433.95 = $786.05

This matches the user's Excel mental model exactly: "Total income this month, minus everything that leaves the account this month, equals what's left to save."

Test case 2: same date but commission of $500 confirmed for May 22:
- Total income = $3,220 + $500 = $3,720
- Discretionary = $3,720 - $2,433.95 = $1,286.05

Test case 3: same date, $250 variable already logged this month:
- Total income = $3,220
- Outgo = $1,833.95 + $250 logged + ($600-$250)=$350 expected + $0 + $0 = $2,433.95
- Discretionary = $786.05 (unchanged — variable cap still consumed at same total)

This is the correct behavior: logging doesn't change the discretionary number, it just shifts the variable from "expected" to "actual." The cap is the planning floor.

Test case 4: same date, $250 variable logged AND user manually overrides remaining variable to $200 (lighter spending plan):
- Total income = $3,220
- Outgo = $1,833.95 + $250 + $200 + $0 + $0 = $2,283.95
- Discretionary = $936.05

This lets the user model "I'll spend lighter this month" and see the savings impact immediately.

---

### 1.3 UI Editability Sweep

**Priority:** P0

**Status:** Forwarded from prior April 30 plan. The complete editability matrix and implementation patterns remain unchanged. See `APRIL_30_PLAN.md` §P0-2 for the matrix. Re-listed here in summary:

Every user-owned value must be editable from the UI where it lives, without involving the AI agent. The implementation patterns: inline edit (double-click → input → Enter), modal edit (click row → modal pre-filled), edit/delete icons on hover.

**Specific pages and what must be editable (full matrix in prior doc):**
- Dashboard: checking balance inline, pending holds, minimum cushion, posting cushion, variable spend remaining override
- Bills Engine: full CRUD with all fields exposed
- Commissions: edit existing rows freely, edit MRR/NRR/sales_month/status
- Decision Sandbox: save scenarios feature
- Wealth: edit historical snapshots, credit scores, individual account balances, vehicle asset value
- Debt Strategy: edit existing entries (rate, balance, status), assumptions
- Retirement: verify all parameters save
- AI Advisor: rename, delete, export conversations
- Settings: confirm all 12 params editable, add commission tier rate editability

**Verification:** Walk every page, confirm every user-owned value has a no-AI-agent edit path.

---

### 1.4 Next Payday Auto-Advance

**Priority:** P0

**Defect:** When today's date passes the stored payday, the system doesn't roll forward automatically. The Dashboard keeps showing the past payday until manually updated.

**Engineering:** The function `nextNominalPayday()` already exists in the engine but isn't invoked on session load. Either invoke it on session load, or compute it dynamically every time the Dashboard renders.

**Recommended fix:** Compute `nextNominalPayday` and `nextEffectivePayday` as derived values on every render, never store them. Eliminates the staleness possibility entirely.

```typescript
function computeNextNominalPayday(today: Date): Date {
  const dayOfMonth = today.getDate();
  
  if (dayOfMonth < 7) {
    // Next payday is the 7th of this month
    return new Date(today.getFullYear(), today.getMonth(), 7);
  } else if (dayOfMonth < 22) {
    // Next payday is the 22nd of this month
    return new Date(today.getFullYear(), today.getMonth(), 22);
  } else {
    // Next payday is the 7th of next month
    return new Date(today.getFullYear(), today.getMonth() + 1, 7);
  }
}

function computeNextEffectivePayday(today: Date): Date {
  return effectivePayday(computeNextNominalPayday(today));
}
```

Use these everywhere. Delete any stored `nextPaydayDate` field. Delete the related Settings field if it exists. The user can never override the payday — it's deterministic from the 7th/22nd schedule.

**Verification:** Change system date forward by a week. Reload Dashboard. Next Payday displays the correct upcoming date without any user intervention.

---

### 1.5 Variable Spend Staleness Warning

**Priority:** P0

**Defect:** Variable spend log silently goes stale. The Dashboard happily computes Monthly Savings and Discretionary as if no spending happened, when in reality the user has been buying gas and groceries for two weeks unlogged.

**Fix:** New Session Integrity Check (becomes #13 in the integrity panel):

> **Check 13:** Variable Spend Log has entry within last 7 days. If not, status WARN with message: "Last variable spend logged {N} days ago. Monthly Savings and Discretionary are unreliable until logged."

The check fires the staleness banner on the Dashboard prominently (yellow/amber) with a "Log Now" button that opens the quick-log widget (see 5.1).

Also surface in the Session-Start Checklist (1.1) as item 2.

**Verification:** Don't log variable spend for 8 days. Check 13 fails. Banner appears on Dashboard.

---

### 1.6 Car as Asset (Data Correction)

**Priority:** P0

**Status:** Forwarded from prior April 30 plan §P0-4. Implementation unchanged.

Add `Vehicle (2024 Camry)` to `accounts` table at $25,000. Add `other_assets: 25000` to April monthly_net_worth row. Verify Net Worth shows ~$29,200 not $4,200.

---

### 1.7 Bills Page "In Cycle Hold" Badge Bug

**Priority:** P0

**Status:** Forwarded from prior April 30 plan §P0-5. Implementation unchanged.

Bills page is using a different cycle anchor than the Dashboard. Unify so both pages use the same `nextEffectivePayday` from shared `FinanceContext`. Apply strict less-than rule consistently.

---

### 1.8 Anthropic Model String Fix

**Priority:** P0

**Status:** Forwarded from prior April 30 plan §P0-6. Implementation unchanged.

Change `claude-opus-4-5` to `claude-opus-4-7`.

---

## PART 2 — Math Engine Corrections (P0/P1)

### 2.1 Forward Reserve Double-Count Audit

**Priority:** P0

**Issue (per advisor thread):** The fix that excluded current-cycle bills from Forward Reserve may have correctly fixed Monthly Savings Estimate but wrongly propagated to the new Discretionary calculation, where the original full Forward Reserve might be the right input.

**Action:** Audit, do not patch on speculation. Steps:

1. Find every function that references `forwardReserve` in `lib/finance/financeEngine.ts`
2. For each, document: what does this function output? What question does it answer? Does Forward Reserve belong as a subtraction here, and in what form?
3. Compare against BUILD_SPEC.md §4.3: "Forward Reserve feeds Monthly Savings (B62) but NOT current-cycle Safe to Spend (B19/B16)."
4. Verify the new `discretionaryThisMonth` from 1.2 uses Forward Reserve correctly. Looking at the formula: Discretionary This Month uses calendar-month outgo, which already includes May 1-7 bills as part of "Bills this month" and June 1-7 bills are NOT in this month. So Forward Reserve as a concept doesn't apply to monthly Discretionary — it would double-count. Good. No Forward Reserve subtraction in `discretionaryThisMonth`.
5. Verify `monthlySavingsEstimate` still uses Forward Reserve correctly per spec.
6. Verify `safeToSpend` does NOT subtract Forward Reserve.

**Output of this task:** A short audit document `FORWARD_RESERVE_AUDIT.md` in the repo listing every reference, every use case, every conclusion. Then any required code fixes.

**Verification:** Audit document complete, unit tests passing for all three (Safe to Spend, Monthly Savings, Discretionary).

---

### 2.2 Monthly Savings Card on Dashboard

**Status:** Forwarded from prior April 30 plan §P1-1. Tertiary card on Dashboard. The math is already correct from previous session.

---

### 2.3 One-Time Expenses Feature (Full Implementation)

**Status:** Forwarded from `FIX_PLAN_PART_K.md` §K2. No changes to scope.

Critical because Discretionary This Month (1.2) depends on one-time expenses being represented in the data model with full CRUD.

---

### 2.4 Variable Spend Log + QuickSilver Blind Spot

**Priority:** P0 (upgraded from P1 — this is critical for Discretionary correctness)

**Status:** Forwarded from `FIX_PLAN_PART_K.md` §K3 with modifications:

**Modifications based on user feedback:**

1. **Simplify the data model.** Instead of weekly rows with date + category + QS portion, use a per-entry model:
   - Each entry is a single transaction (or batched daily) with: date, amount, category (Fuel / Groceries / Dining / Household / Other), payment_method (QuickSilver / Cash / Debit), notes
   - This matches what's currently being captured per the screenshot
2. **Quick-log widget on Dashboard** (see 5.1) for friction-free entry
3. **QuickSilver Balance Owed** is the sum of `amount` where `payment_method = QuickSilver` AND month = current month AND not yet paid off. When the user marks the QuickSilver bill paid (in Bills or via a dedicated "QS Paid" button), all entries from prior months get their `qs_paid_off` flag set.

**Display:**
- Dashboard widget shows MTD logged total, breakdown by category, QuickSilver balance owed
- Variable cap progress: "X of $600 used this month (Y% of cap)"
- If a user is over cap: prominent red indicator and the breakdown shows where the overage came from

**Integration:**
- Feeds `variableLoggedThisMonth` in Discretionary calculation
- Feeds `quicksilverBalanceOwed` in Discretionary calculation
- Triggers Check 13 (staleness) when last entry > 7 days old

---

### 2.5 QuickSilver Bill Row

**Status:** Forwarded from `FIX_PLAN_PART_K.md` §K1.

Add a QuickSilver bill row with Include=FALSE so it's visible in Bills list but excluded from cycle math. Amount is variable (driven by `quicksilverBalanceOwed` from 2.4). Notes: "Variable CC — tracked via Variable Spend Log."

---

### 2.6 QS Blind Spot vs CC Balance Owed Naming Unification

**Priority:** P1

**Issue (per advisor thread):** Two fields displaying the same underlying concept with different values and labels. Visible in the Image 1 screenshot — "Discretionary This Month" card shows "CC balance owed $0" while elsewhere the term "QS Blind Spot" is used.

**Fix:** Pick one canonical name and one canonical computation. Recommendation: **"QuickSilver Owed"** (clearest user-facing term). Definition: sum of variable spend log entries with payment_method=QuickSilver for the current month that haven't been paid off via QS bill payment.

Remove "CC balance owed" and "QS Blind Spot" as separate labels. Use "QuickSilver Owed" universally.

---

### 2.7 Drought Flag Logic Alignment

**Priority:** P1

**Issue (per advisor thread):** Display says "X of last 3 below threshold" but engine uses different logic (consecutive months, not last 3).

**Fix:** Make them match. Pick one definition.

**Recommendation:** Use consecutive-months logic (more conservative — a drought is a streak, not a percentage). Update display to: "{N} consecutive months below threshold" where threshold is e.g. $200 take-home. When N >= 2, drought is active.

Update both the engine logic and the display string. Add a small explanation tooltip on the drought flag describing the threshold and logic.

---

### 2.8 Seasonal Utility Model Restoration

**Priority:** P1

**Issue (per advisor thread):** Seasonal utility model dropped in port. Bills are flat amounts; the workbook had INDEX/MATCH for National Grid/Fuel variance by month.

**Fix:** Extend the `bills` schema to support seasonal amounts:

Add a `seasonal_amounts` JSONB column (nullable) to `bills`. When present, it's a map of month-number → amount, e.g.:

```json
{
  "1": 220,
  "2": 215,
  "3": 195,
  "4": 175,
  "5": 130,
  "6": 95,
  "7": 80,
  "8": 80,
  "9": 95,
  "10": 130,
  "11": 175,
  "12": 210
}
```

When seasonal_amounts is present, the bill's effective amount for any computation is `seasonal_amounts[currentMonth] ?? amount` (falls back to flat amount).

Update National Grid and National Fuel rows with seasonal patterns. Ask user for actual historical values from last winter's bills.

**UI:** Bills edit modal gets a "Seasonal" toggle. When on, shows 12 month-amount inputs.

---

## PART 3 — Hidden Engine Features Surfaced (P1)

### 3.1 Forward Projection View

**Issue:** Engine has `forwardProjection()` but no UI.

**Fix:** Add a "Projection" tab to the Wealth page (or a new top-level Projection page). Display:
- Next 6 months: predicted net worth, predicted savings, predicted commission (probabilistic)
- Assumptions panel showing what's being projected forward
- Toggle: "with commission pipeline" vs "base income only"

---

### 3.2 Tax Planning Module UI

**Issue:** Tax Planning calculations exist in engine but no UI surface.

**Fix:** Add a "Tax" page or tab. Show:
- Per-paycheck federal withholding estimate
- Per-paycheck state withholding estimate  
- Estimated quarterly liability if any
- Commission tax accrual (43.5% set-aside)
- YTD effective rate calculation
- 1099 reminder for commission earnings if applicable
- Suggested W-4 adjustments based on YTD trajectory

---

### 3.3 Commission Pipeline Workflow

**Issue:** Engine supports pipeline data but Commissions tab shows zeros / no active deals entered.

**Fix:** Add a "Pipeline" section to the Commissions page. Lets user enter active deals:
- Deal name (account)
- Expected MRR / NRR contribution
- Close probability (% slider)
- Expected close month
- Notes

Computed output:
- Probability-weighted commission projection for next 3 months
- Risk-adjusted Discretionary projection (per Forward Projection)
- Funnel view of pipeline value at each probability tier

---

### 3.4 Multi-Cycle Projection View

**Issue:** Engine has `forwardProjection()` but the user has no way to see "what does the next 3 months look like."

**Fix:** Could be folded into 3.1 (Forward Projection view) — make sure that view shows cycle-level granularity, not just monthly.

---

## PART 4 — Advisor Completeness (P1)

### 4.1 Data Context Expandable on Every Message

**Status:** Forwarded from prior April 30 plan §P1-2. Implementation unchanged.

Every advisor message has an expandable showing the Live Data Snapshot that was in the system prompt for that turn.

---

### 4.2 Advisor Persistent Memory — Honest Documentation + Foundation

**Issue (per advisor thread):** "Uncertain if advisor has persistent memory across sessions or starts fresh each time."

**Reality:** It doesn't have persistent memory. Each conversation starts fresh with the system prompt assembling from current data, but it doesn't see prior conversations.

**Fix has two parts:**

1. **Honest documentation in the UI.** Add a small note in the Advisor sidebar: "Each session starts with full current data but does not remember prior conversations. Save important decisions to the Decisions Log to preserve them."

2. **Foundation for future persistence.** Create an `advisor_memories` table:
   ```
   advisor_memories (
     id, owner_id, content, category, importance (1-5),
     created_at, updated_at, source_conversation_id
   )
   ```
   The advisor's system prompt can be extended (future feature) to include high-importance memories from this table. For now, just create the table and a simple Settings page to view/edit memories manually. Full feature can ship later.

---

### 4.3 Save-as-Decision Flow

**Status:** Forwarded from prior April 30 plan §P3-2.

When the advisor offers a recommendation, the user can click "Save as Decision" to log it. Decisions appear in a Dashboard widget and a dedicated Decisions log page.

---

## PART 5 — Dashboard & UI Improvements (P1)

### 5.1 Quick-Log Affordance on Dashboard

**Priority:** P0 (upgraded — this is critical for the staleness fix)

**Issue:** Logging variable spend currently requires navigating to the right tab and filling a form. Friction = no logging = data is wrong.

**Fix:** Add a prominent "Log Spend" button on the Dashboard (already visible in screenshot — verify it works). Clicking opens a minimal modal:
- Amount (auto-focused input)
- Category (default: last used)
- Payment method (default: QuickSilver)
- Date (default: today)
- Notes (optional)

One enter key → saved → modal closes. Whole flow should take <10 seconds.

Make this the same button used by the Session-Start Checklist (1.1) item 2.

---

### 5.2 Dashboard Staleness Banner

**Status:** Forwarded from prior April 30 plan §P1-5. Banner fires when balance is >3 days old.

---

### 5.3 Dashboard Integrity Banner

**Status:** Forwarded from prior April 30 plan §P1-6. Banner fires when any of the 13 integrity checks fail.

Visible in screenshot — "Engine attention needed · 1 warning" banner. Expand should show details. Already partially built; verify it shows what's failing and offers a quick fix path.

---

### 5.4 Active Bills in Cycle List

**Status:** Forwarded from prior April 30 plan §P1-7. Visible in screenshot already implemented.

Verify it correctly excludes EZ-Pass on payday using strict less-than rule (see 1.7 for the badge fix).

---

### 5.5 Overdue One-Time Items Escalation

**Issue (per advisor thread):** Overdue one-time expenses stay flagged "Overdue" but no escalating warning or action push.

**Fix:**
- 0-7 days overdue: yellow badge, listed in normal one-time view
- 8-30 days overdue: red badge, appears at top of Dashboard as a "Stale One-Time Items" widget
- 30+ days overdue: critical banner at top of Dashboard, blocks dismissal of session-start checklist until addressed (mark paid or update date)

The session-start checklist (1.1) item 3 catches overdue items in the daily ritual.

---

### 5.6 "Variable Remaining X of $600" Label Fix

**Issue:** Currently misleading — shows monthly cap remaining as if all available in current cycle.

**Fix:** Change label to "Variable Cap This Month: $X used of $600" with sub-text showing current month spending pace vs target pace.

Example: On May 14 with $200 logged: "Variable: $200 of $600 used (33% — under pace; target is 45% by day 15)"

This frames variable as a monthly budget with intra-month pace tracking, not a misleading cycle figure.

---

### 5.7 Mobile Responsiveness Verification

**Action item:** Pull up live URL on phone. Walk through every page. List specific failures.

Common breakage patterns to verify:
- Sidebar navigation collapses to hamburger
- Modals fit screen and don't clip
- Tables scroll horizontally when wider than screen
- Inputs are touch-friendly (44px tap targets)
- Charts render at small viewport widths

If any pages fail, file specific bugs. Don't add "fix all mobile" to the queue — file precise issues.

---

## PART 6 — Deferred Features (P2)

These are all forwarded from `APRIL_30_PLAN.md` §P2-1 through §P2-6. Refer to that document for details. Listed here for completeness:

- 6.1 Debt Strategy Full Framework
- 6.2 Save Scenarios to DB
- 6.3 Wealth Page Completions (savings rate, FV projections, allocation)
- 6.4 Bills: Skip-This-Cycle Override
- 6.5 Bills: Timeline View
- 6.6 Bills: Health Summary

Status check: Some of these may already be partially or fully built per the screenshots (Bills page shows category breakdown, autopay audit, upcoming timeline already). Verify what's done and skip those. The Bills page in particular appears substantially complete in the May screenshot.

---

## PART 7 — Quality & Polish (P3)

- 7.1 Unit Test Suite (G1-G10 from FIX_PLAN.md + new tests for `discretionaryThisMonth`)
- 7.2 Polish pass (date formats, pluralization, currency, zeros, negatives, percentages)
- 7.3 Keyboard shortcut (Cmd+K command palette)

---

## PART 8 — Session Plan / Batching

Suggested execution sequence for the April 30 session. Honors dependency order and groups efficient work.

**Batch 1 — Architectural decisions confirmed** (no code, 5 minutes):
- 0.1, 0.2, 0.3 acknowledged

**Batch 2 — Quick data and config fixes** (30 minutes):
- 1.6 (Car asset)
- 1.7 (Bills badge bug)
- 1.8 (Model string)
- 2.5 (QuickSilver bill row)

**Batch 3 — Engine corrections** (1 hour):
- 1.4 (Next Payday auto-advance)
- 2.1 (Forward Reserve audit)
- 2.4 (Variable Spend Log redesign + QS Owed calculation)
- 2.6 (Naming unification)
- 2.7 (Drought flag)
- 2.8 (Seasonal utilities)

**Batch 4 — Discretionary rewrite** (1-1.5 hours):
- 1.2 (Discretionary This Month, new function from scratch)
- 5.6 (Label fix on variable cap display)

This batch is the headline. Do not let the Agent merge it with other tasks. The function, the Dashboard card, the breakdown expandable, and the unit tests must all land together.

**Batch 5 — Session-start checklist** (1 hour):
- 1.1 (Session-Start Checklist modal)
- 5.1 (Quick-Log Affordance)
- 1.5 (Variable Spend staleness — Check 13)
- 5.5 (Overdue items escalation)

These four are tightly coupled. Build together.

**Batch 6 — Editability sweep** (1.5-2 hours):
- 1.3 (UI Editability) — biggest standalone item

**Batch 7 — Dashboard completeness** (45 min):
- 2.2 (Monthly Savings card)
- 5.2 (Staleness banner — verify)
- 5.3 (Integrity banner — verify)
- 5.4 (Active Bills list — verify)

**Batch 8 — One-Time Expenses** (1 hour):
- 2.3 (Full feature)

**Batch 9 — Advisor completeness** (45 min):
- 4.1 (Data Context expandable)
- 4.2 (Memory documentation + foundation)
- 4.3 (Save-as-Decision)

**Batch 10 — Hidden features surfaced** (1-1.5 hours):
- 3.1 (Forward Projection view)
- 3.2 (Tax Planning UI)
- 3.3 (Commission Pipeline workflow)

**Batch 11 — Verification + polish** (remaining time):
- 5.7 (Mobile verification)
- 6.x (Skip if already done; verify Bills completeness)
- 7.1 (Unit tests)
- 7.2 (Polish)

**Stopping rule:** If credits hit 20% remaining, stop starting new batches. Run verification on what's done. Leave repo in compilable state.

---

## PART 9 — Verification Criteria

After each batch, verify before proceeding. After all batches, run this acceptance suite:

1. **Discretionary This Month** displays prominently on Dashboard, anchored to calendar month, includes remaining-month paychecks as expected income. Breakdown expandable shows full income/outgo waterfall.

2. **Session-Start Checklist** fires on first session each day. Runs through balance, variable spend, one-time expenses, pipeline, payday. Cannot be permanently dismissed.

3. **Every user-owned value is editable from the UI without involving the AI agent.** Walk every page, tick the editability matrix.

4. **Next Payday** auto-advances. Change system date forward by a week, reload, payday displays correctly without intervention.

5. **Variable Spend Staleness** warning fires after 7 days. Banner visible on Dashboard with "Log Now" button.

6. **Car asset** visible in Wealth, Net Worth ~$29,200 not $4,200.

7. **Bills page** in-cycle badges match Dashboard expectations, strict less-than rule applied.

8. **Advisor** can answer "What's my Discretionary this month?" with cited data points and a Data Context expandable on the response.

9. **Forward Reserve audit document** exists in repo. All three functions (Safe to Spend, Monthly Savings, Discretionary) use Forward Reserve correctly per spec.

10. **Naming consistency:** "QuickSilver Owed" used universally, no stale "CC Balance Owed" or "QS Blind Spot" labels.

11. **Drought flag** display string matches engine logic.

12. **Seasonal utilities** working: National Grid and National Fuel show monthly amounts that vary.

13. **Forward Projection / Tax Planning / Pipeline** views all reachable from sidebar or page tabs.

14. **All 13 Session Integrity Checks** pass on a freshly-loaded app with current data.

15. **Mobile** verified — list of specific failures filed if any.

---

## PART 10 — Starter Prompt for Replit Agent 4

Paste into Plan Mode with these files in repo root:
- `MASTER_PLAN_APRIL_30.md` (this document)
- `BUILD_SPEC.md` (architectural reference)
- `FIX_PLAN.md` (prior reference)
- `FIX_PLAN_PART_K.md` (one-time + variable log details)
- `APRIL_30_PLAN.md` (prior April 30 plan, superseded but useful reference for editability matrix)

```
Read MASTER_PLAN_APRIL_30.md in full before planning. It supersedes all other 
plan documents for this session. The earlier docs are reference material only.

This session has three governing principles, in order:
  1. Match the user's mental model — monthly anchoring, not cycle anchoring
  2. Editability is a right — every user-owned value editable from UI
  3. Session-start ritual prevents staleness — build the ritual, symptoms fade

Generate a task plan following the exact batching in Part 8. Do not reorder 
across batches. Within a batch, parallelize where files don't collide.

The single most important task in this entire plan is Batch 4: the Discretionary 
This Month rewrite. This is a from-scratch new function, not a patch to the 
existing discretionaryThisCycle function. The user thinks in calendar months. 
The function must too. Do not let other work delay or interfere with Batch 4.

The single most leveraged workflow improvement is Batch 5: the Session-Start 
Checklist. It addresses staleness, payday drift, commission tracking, and 
overdue items as one ritual instead of 10 separate band-aids. Ship Batch 5 
even if other items are skipped.

When the plan is ready, show me the task list before executing. Show me your 
proposed approach for Batch 4 (Discretionary rewrite) specifically before any 
code is written for it — I want to verify the formula matches my mental model 
before implementation.

Do not seed placeholder data. Do not skip verification steps. Do not merge 
batches.

Stop and ask if anything in the plan conflicts with what you see in the current 
codebase.
```

---

## PART 11 — What Is NOT In This Plan (Phase 2)

Explicitly out of scope for April 30:

- **Plaid / Teller integration.** Manual balance entry remains the norm. Documented in advisor list as "indefinitely deferred" — keep it deferred until manual entry is genuinely painful, then revisit cost-benefit.
- **Push notifications / SMS alerts.** Could be added Phase 2.
- **Mobile artifact (native app).** Use the responsive web app on mobile. Native is Phase 2 or 3.
- **Goal tracking with progress UI** (HYSA target, 401k bump, student loan payoff) — could add Phase 2 if useful.
- **Multi-user sharing / partner access.** Not a need.
- **Receipt OCR / transaction tagging.** Heavy lift; Plaid is the better path to this.
- **Auto-categorization rules.** Same.
- **Year-end summary / annual report.** Build when first January rolls around.

---

## Appendix A — Why the Monthly Anchor Matters

A note for the Agent and any future reader.

The user has used an Excel-based personal finance system for years. The Excel system computes a single end-of-month value: "what did this month produce that I can save or invest?" This is the user's primary decision-making number. He uses it to:
- Decide how much to move to HYSA at month end
- Decide whether to fund the Roth this month
- Decide whether a large discretionary purchase is feasible
- Decide whether to bump 401(k) contribution
- Decide whether to accelerate debt paydown
- Determine if a month is "good," "average," or "below floor"

The cycle frame (paycheck-to-paycheck, 7th-22nd-7th) is mechanically correct for liquidity questions but is the wrong unit for these decisions. Cycles don't align with months. Cycles cross months. The user doesn't think "I saved $300 in the April 22 - May 7 cycle." He thinks "May produced $X in discretionary."

This is why every cycle-anchored "Discretionary" the app has shown has felt wrong to him. The math is fine, the unit is wrong.

`discretionaryThisMonth()` answers the right question. It is the headline. Every other output supports it.

---

## Appendix B — Data Integrity Notes

Three known data gaps as of May 14, 2026:

1. **Variable Spend Log:** No entries logged for May. Need to log ~30 days of spending or accept that May data is incomplete and the displayed Discretionary will be an over-estimate until logged.

2. **Commission March 2026:** Confirmed $0. Verified in seed.

3. **Vehicle value:** $25,000 placeholder. Should review/update from KBB annually (April recurring reminder).

These don't block the session but should be addressed by the user before relying on Discretionary for major decisions.

---

*End of Master Plan. Execute on April 30 when credits restore. Do not modify this document without explicit user approval.*
