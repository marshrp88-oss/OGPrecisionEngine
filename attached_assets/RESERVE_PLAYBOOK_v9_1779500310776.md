# RESERVE — Final Playbook v9.0

**Date:** May 23, 2026
**Status:** Definitive completion plan. Supersedes all prior documents.
**Goal:** Take Reserve from "engine that mostly works but fails its own invariant" to a deployed, trustworthy, standalone daily/monthly financial system. Long-term (HYSA/investment allocation) is explicitly out of scope — the user handles that manually.

**Governing principle:** ONE number, dynamic and reserve-aware, that answers "right now, what can I save/invest/spend by end of month — accounting for what's been paid and posted versus what's still coming." Every fix below serves making that number trustworthy.

---

## PART 0 — Confirmed Decisions (locked, do not relitigate)

**Income**
- Base net stays at current baseline for June (do not auto-adjust).
- Paydays 7th and 22nd, weekend-adjusted to prior Friday. Confirmed.
- Base + commission only; nothing else hits the account.

**Bills — corrections this pass**
- Car loan amount = **$337.57** (was $337.00).
- **Add Replit subscription: $21.00, due day 21, autopay.** Already in current checking figure — add as go-forward bill, do NOT re-subtract from current balance.
- **EZ-Pass: remove from recurring bills.** Move to one-time framework. Next occurrence ~$30 (not $10).
- Car loan bill: confirm Include state (integrity warns it may need to stay TRUE — it is NOT eliminated, the new Camry loan is active). Keep Include=TRUE.
- All other bills confirmed correct.

**QuickSilver (only card used)**
- Food + gas primarily. Statement **close = 18th, payment due = 22nd** (fixed monthly).
- Spending 19th → next 18th accrues to the next statement.
- `quicksilverOwed` = current open-statement balance, held against checking, clears when the 22nd payment posts.

**Variable spend**
- No category tracking. Single running total.
- Default $600/month, fully dynamic — user updates actual through the month; updates the headline in real time.
- Target stays $600.

**Forward Reserve — SIMPLIFIED (critical correction)**
- **Only bills due on days 1–7 of the FOLLOWING month.** Nothing else.
- **No variable buffer. No 14-day window. No "to next payday."** Just next month's 1st–7th bills.
- **No minimum cushion. No checking floor.** Zero.

**Allocation**
- User handles HYSA and investment moves manually. App does not sweep.
- Long-term accounts excluded from the daily/monthly engine (display balances only, if at all).

**Deferred obligations**
- Parking ticket $50, PPG $143, NY taxes $354, Mimi $1,000 — all deferred.
- Default: excluded from this month's math.
- Toggle to turn each on/off (when on, enters the math); add/subtract; mark finished (leaves the math).

**Integration**
- Skip Plaid. Manual entry. Daily session-start discipline is the accuracy mechanism.

**Headline rename**
- "Save / Invest / Spend This Month." The single decision number. Reserve-aware, dynamic.

**End goal**
- Fully replace the user's financial system. Not trustworthy yet. Trustworthiness is the job.

---

## PART 1 — The Posted-State Model (new core requirement)

The user's primary question on opening the app: *"What bills are coming up, have they been paid and posted to my bank, and given that — what can I save/spend right now by end of month?"*

This requires distinguishing three states per obligation, and intelligently defaulting based on autopay behavior.

### 1.1 Three states

| State | Meaning | Effect on headline |
|---|---|---|
| `upcoming` | Not yet paid | Held against checking (money still to leave) |
| `paid_pending_post` | Paid/initiated but not yet cleared the bank | **Still held** against checking (money committed, not yet withdrawn) |
| `posted` | Cleared and reflected in the bank balance | Released from hold (already in the checking number) |

### 1.2 Intelligent defaults (the requested intelligence)

- **Autopay bills that almost always post on time (National Grid, National Fuel, QuickSilver):** default to auto-progressing `upcoming → posted` on their due/posting date without user action. These rarely need a manual touch. BUT give each a **manual "Posted" toggle** so the user can flip it off if a posting is delayed, which immediately re-holds the amount against the headline.
- **Manual / non-autopay bills:** default to `upcoming` and require the user to confirm `paid_pending_post`, then `posted`. These are the ones the user actively manages.
- **The user-facing control:** every bill row shows a **Posted toggle**. Default state is intelligently set per the above. Flipping it on = posted (released). Flipping it off = re-held. This directly and instantly moves the Save/Invest/Spend number.

### 1.3 Why "still held when paid-pending-post"

A bill the user paid but that hasn't cleared the bank is money already committed but still sitting in the checking balance. If it were released from the hold the instant it's marked paid, the headline would overstate available cash until the debit actually posts. Holding until posted keeps the number honest. This is the same invariant as `quicksilverOwed`.

---

## PART 2 — CRITICAL FIXES (in strict order; nothing ships until these are green)

### FIX 1 — Engine-drift invariant FAIL (#11) — HIGHEST PRIORITY
**Symptom:** Engine and independent recomputer disagree by exactly $897.27 (the forward reserve). `RequiredHold delta $897.27, SafeToSpend delta $129.00.`

**Why it's #1:** This is the exact bug class that produced "−$22 by hand vs engine said +$266." No Safe to Spend / Save-Invest-Spend number can be trusted while this invariant fails.

**Action:**
1. Open `financeEngine.ts:444` (engine) and `integrity.ts` (independent recomputer) side by side.
2. Diff line by line. The $897.27 delta means one side includes FR in required hold and the other does not.
3. Reconcile to the penny. The recomputer and the engine must compute required hold identically, including FR treatment.
4. Re-run integrity check #11. Must report PASS with zero delta before proceeding.

**Acceptance:** Integrity #11 = PASS, delta $0.00.

### FIX 2 — Forward Reserve window correction
**Symptom:** FR currently sums a 14-day-after-payday window ($897.27). User's confirmed rule: **only days 1–7 of next month, bills only, no variable buffer.**

**Action:**
```
forwardReserve = Σ bill.amount for include=TRUE bills where
                 bill.dueDay between 1 and 7
                 AND the bill instance falls in the FOLLOWING month
// NO variable proration. NO 14-day window. NO cushion.
```
Recompute. With current bills, days 1–7 next month = Car Loan $337.57 (day 1) + Verizon $65 (day 2) + Claude $21 (day 3) + Rent $1,000 (day 4) + Replit $21 (day 21 — NOT in 1–7, excluded) = **$1,423.57**.

Note: this is HIGHER than the current $897.27 because the current window was wrong AND was deduping incorrectly. Verify the new number against the actual day-1–7 bill set.

**Acceptance:** FR equals the exact sum of next-month day-1–7 bills, no buffer, reconciled in both engine and recomputer (ties to Fix 1).

### FIX 3 — Stale payday FAIL (#2)
**Symptom:** Assumption row stores next payday 2026-05-22 (past). Engine computes dynamically (correct) but the stale stored row fails integrity.

**Action:** Delete the stored `next_payday_date` assumption row entirely. Compute `nextNominalPayday`/`nextEffectivePayday` dynamically on every load (the engine already does this). Remove all reads of the stored field.

**Acceptance:** Integrity #2 = PASS. No stored payday anywhere.

### FIX 4 — Pill renderer undercount (UI bug)
**Symptom:** Badge shows "1 engine fail" / "2 warn" but actual state is 2 FAIL, 4 WARN. The pill counts only the cycle-math invariant, missing the stale-payday failure.

**Action:** Pill must count all FAIL and all WARN from the integrity log, not a hardcoded subset.

**Acceptance:** Badge matches the integrity log exactly (after Fixes 1–3 land, this should read 0 FAIL).

### FIX 5 — Bill corrections (data)
- Car loan → $337.57.
- Add Replit $21, day 21, autopay (do not re-subtract from current balance).
- Remove EZ-Pass from recurring; create one-time EZ-Pass ~$30 for next month.

**Acceptance:** Bills list reflects all three; totals recompute.

### FIX 6 — QuickSilver statement-cycle accuracy
**Symptom:** `quicksilverOwed` should reflect the real statement cycle (close 18th, due 22nd), not a generic calendar month.

**Action:**
```
currentStatementSpend = Σ QuickSilver variable entries where
                        entry.date in (last 18th, next 18th]
quicksilverOwed = currentStatementSpend NOT yet paid off
// held against checking until the 22nd payment posts (posted-state model)
```

**Acceptance:** QS owed ties to the open statement window, clears on the 22nd payment posting.

### FIX 7 — Posted-state model implementation (Part 1)
Implement the three-state model with intelligent defaults and per-bill Posted toggle. Wire posted-state into the headline: `upcoming` and `paid_pending_post` are held; `posted` is released.

**Acceptance:** Flipping any Posted toggle moves the headline by exactly the bill amount, instantly.

---

## PART 3 — DEPLOYMENT (do immediately after Fixes 1–4 are green)

The app is NOT deployed. It runs on the workspace dev domain, which sleeps. It cannot be a daily tool until this is fixed.

**Action:** Publish → Autoscale Deployment (or Reserved VM for always-warm). Bind to the same Postgres DB. Carry `ANTHROPIC_API_KEY` into deployment secrets (separate from workspace secrets). Confirm the stable `*.replit.app` URL works on the phone with the workspace closed.

**Acceptance:** App loads on phone with workspace fully closed; data persists; advisor responds.

---

## PART 4 — Deferred Obligations Module

- Each deferred item (parking $50, PPG $143, NY taxes $354, Mimi $1,000): stored with amount, label, and `active=false` default.
- Excluded from all math while inactive.
- Per-item toggle: activate (enters the headline math as an outflow), deactivate (leaves).
- Add/edit/remove items; mark finished (archives, leaves math).
- A "Deferred Obligations" panel with a running total footer, always visible but not impacting the headline unless toggled on.

**Acceptance:** Toggling an item on reduces Save/Invest/Spend by its amount; off restores it.

---

## PART 5 — The Headline Math (final, canonical)

```
Save / Invest / Spend This Month = MAX(0,
    checkingBalance
  − billsHeld                  // upcoming + paid_pending_post bills due this month, NOT posted
  − quicksilverOwed            // open-statement card balance not yet posted
  − variableRemainingThisMonth // MAX(0, monthlyTarget − variableLoggedThisMonth), or user override
  − oneTimeHeld                // active one-time expenses not yet posted
  − forwardReserve             // next month days 1–7 bills only
  − activeDeferredTotal        // only deferred items toggled ON (default 0)
)

overCommittedBy = MAX(0, −preFloorValue)   // surfaced when negative
```

- `posted` bills are NOT subtracted (already in checking).
- Dynamic: updates on balance change, spend log, posted toggles, deferred toggles.
- Displayed signed via the over-committed flag when negative.
- This is the ONLY headline. No competing "month production" number anywhere near it.

**Reconciliation sanity (today, May 23):** checking $2,017, May bills mostly posted, QS owed ~$300 (open statement), variable $600 logged (remaining $0), FR = next-month 1–7 bills ~$1,423.57. Expect a small positive or modest over-committed figure — and whatever it is, it must tie to the penny between engine and recomputer (Fix 1). The current $0/over-$768 will change once FR window (Fix 2) is corrected.

---

## PART 6 — Verification Gate (must pass before "trustworthy")

1. Integrity #11 (invariant) = PASS, $0 delta.
2. Integrity #2 (payday) = PASS.
3. Badge counts match integrity log (0 FAIL after fixes).
4. Forward Reserve = exact next-month day-1–7 bill sum, no buffer.
5. Posted toggle moves headline by exact bill amount.
6. QuickSilver owed ties to the 18th-close statement window.
7. Deferred toggle on/off moves headline correctly.
8. App deployed; works on phone with workspace closed.
9. UI = engine cross-validation: every displayed card === its engine field.
10. Month-timing stability: headline does not swing across the month for a fixed scenario beyond variable-accrual delta.

When all ten are green, the app is trustworthy enough to be the sole system.

---

## PART 7 — Build Order

1. **Fix 1** (engine drift invariant) — nothing else matters until this is green.
2. **Fix 2** (FR window → 1–7 next month only).
3. **Fix 3 + Fix 4** (stale payday + pill count) — same pass, 10-line fixes.
4. **Deploy** (Part 3) — get it on the phone, stable.
5. **Fix 5** (bill corrections: car $337.57, add Replit, EZ-Pass → one-time).
6. **Fix 6** (QuickSilver statement cycle).
7. **Fix 7** (posted-state model + toggles + intelligent defaults).
8. **Part 4** (deferred module).
9. **Part 6** (run the full verification gate; do not declare done until 10/10).

**Stopping rule:** if anything is left incomplete, the app stays in "not trustworthy" status and the user is told exactly which gate items are red. No "complete" claim without 10/10 green with pasted evidence.

---

## PART 8 — UI / Product Polish (scoped separately, per user)

Reserved for a dedicated pass. Top-practitioner scope to be defined separately. Headline principles to carry in:
- One hero number (Save/Invest/Spend This Month), reserve-aware, with the over-committed flag.
- Posted toggles inline on every bill, visually distinct from Include.
- Deferred obligations panel, collapsible, with running total.
- Engine-math waterfall expandable for full auditability.
- Daily session-start checklist (the accuracy mechanism, since no Plaid).
- Integrity badge that tells the truth (post Fix 4).

---

*End of Playbook v9.0. The trust threshold is the 10-item verification gate in Part 6. Until 10/10 green, the app is not the sole system.*
