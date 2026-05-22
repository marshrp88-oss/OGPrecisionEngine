# RESERVE v8.0 — Validation Analysis

**Purpose:** Prove the corrected logic in Playbook v8.0 produces correct, stable, sensible outputs across dynamic real-world circumstances. Every scenario below is a concrete fixture the Replit Agent should convert into an automated test. Each shows the OLD (broken) output and the NEW (corrected) output so the regression target is unambiguous.

**How to read this:** Numbers use Marshall's real parameters (below). Every scenario states its setup, the inputs, the broken-vs-corrected outputs, and the assertion to encode. If a computed value here disagrees with the engine after implementation, the engine is wrong — these are the source of truth for the corrected behavior.

---

## Canonical Test Parameters (use these exact values in fixtures)

```
baseNetPerPaycheck      = 1610.00
paydays                 = [7, 22]   // weekend-adjusted to prior Friday
monthlyBaseIncome       = 3220.00   // 2 × 1610
variableCap             = 600.00    // per month
capDailyRate            = 19.74     // 600 / 30.4
trailingDailyRate_May   = 43.00     // observed actual, May 2026
monthLengthDays         = 30.4
commissionTaxRate       = 0.435
forwardReserve          = 1561.16   // June 1–7 bills 1423.00 + 7 × 19.74 = 138.16

BILLS (include = TRUE), total = 1833.95:
  Car Loan        337.00  day 1   auto
  Verizon          65.00  day 2   auto
  Claude           21.00  day 3   auto
  Rent           1000.00  day 4   auto
  Car Insurance   141.95  day 8   auto
  YouTube          14.00  day 15  auto
  National Grid   175.00  day 16  manual   (seasonal)
  National Fuel    70.00  day 19  manual   (seasonal)
  EZ-Pass          10.00  day 22  auto
EXCLUDED:
  Gym              27.00  day 2   include = FALSE (prepaid through Jan 2027)

COMMISSIONS:
  Dec 2025  MRR 890  → gross 1547.52 → take-home 874.35  (paid Feb 22)
  Jan/Feb/Mar 2026  = 0
```

---

## SCENARIO 1 — Month-Timing Stability (the headline proof)

**What it proves:** Discretionary This Month does not swing across the month. This is the defect that produced −$1,547. A fixed financial reality must yield a stable Discretionary at every point in the month.

**Setup:** May 2026. $0 commission. Variable spending tracks the cap pace ($19.74/day, total ≈ $600). No one-time. Bills as canonical. We sample Discretionary at six days.

**Corrected formula:** `Discretionary = monthIncome − monthBills − monthVariable − monthOneTime`
- monthIncome = 3220.00 (both May paychecks, always counted — STABLE)
- monthBills = 1833.95 (full month — STABLE)
- monthOneTime = 0
- monthVariable = logged_to_date + capDailyRate × days_remaining (≈ 600 when pace holds)

| Day | Checking (varies) | monthVariable | OLD Discretionary (broken) | NEW Discretionary (corrected) |
|---|---|---|---|---|
| May 1 | 1,900 | ~600 | 1,900 − 1,561 − 600 = **−261** | 3,220 − 1,834 − 600 = **786.05** |
| May 7 (payday) | 3,100 | ~600 | 3,100 − 1,561 − 600 = **939** | **786.05** |
| May 15 | 1,400 | ~600 | 1,400 − 1,561 − 600 = **−761** | **786.05** |
| May 22 (payday, pre-deposit) | 324 | ~600 | 324 − 1,561 − 600 = **−1,837** | **786.05** |
| May 22 (post-deposit) | 2,046 | ~600 | 2,046 − 1,561 − 600 = **−115** | **786.05** |
| May 31 | 1,250 | 600 | 1,250 − 1,561 − 600 = **−911** | **786.05** |

**The proof:** OLD swings from +939 to −1,837 — a $2,776 swing — on identical underlying finances, purely from where checking sits in the pay cycle. NEW is flat at **786.05** all month because it is anchored to month income and bills, not to checking, and excludes the forward reserve.

**Assertion to encode (test 14.3):** For a fixed scenario, `Math.abs(discretionary(dayA) − discretionary(dayB)) <= variableAccrualDelta(dayA, dayB) + 0.01`. With cap-pace spending the delta is ~0, so Discretionary must be constant to the cent across all six checkpoints.

---

## SCENARIO 2 — The Exact May 22 Defect, Re-Run

**What it proves:** The specific broken number is fixed and produces a sensible figure.

**Setup:** Real May 22 data. May 7 paycheck $1,610 (est), May 22 paycheck $1,722.61 (actual), commission $35.71. $600 variable logged by May 22; assume spending stops (no further variable). Checking $324 pre-deposit, $2,046.61 post-deposit. CC is a bill row; PPG $189 is deferred (excluded).

- monthIncome = 1,610 + 1,722.61 + 35.71 = **3,368.32**
- monthBills = 1,833.95
- monthVariable = 600.00 (logged; no further spend assumed)
- monthOneTime = 0 (PPG deferred; CC captured as bill)

**NEW Discretionary = 3,368.32 − 1,833.95 − 600.00 = 934.37**

**OLD Discretionary (observed in screenshot) = −1,547.16**

**The proof:** The −1,547 was the forward reserve (−1,561.16) plus variable remaining (−300) charged against depleted checking ($324) with the incoming paycheck uncounted. Removing the forward reserve from the flow measure and counting both May paychecks yields **+934.37** — a true, sensible figure for a month that produced real surplus despite heavy variable spend.

**Reconciliation with the cash analysis:** The May 22 cash reconciliation showed Marshall ending the month at ~$1,534 against a $1,550 forward reserve (≈ break-even *after holding the buffer*). That is consistent with Discretionary = +934.37 **because the forward reserve is a static buffer established in prior months, not re-funded from scratch each month.** The month produced ~$934 of surplus; the $1,550 buffer rolls forward untouched. The old logic's fatal flaw was treating the buffer as if it had to be re-earned every month — impossible on this income, hence the false catastrophe.

**Assertion:** `discretionaryThisMonth(may22Fixture)` returns 934.37 ± 0.01. Must never return a forward-reserve-driven negative.

---

## SCENARIO 3 — Clean Month, Zero Commission (baseline sanity)

**What it proves:** A normal month yields a sensible positive that matches hand calculation.

**Setup:** Any month, $0 commission, variable at cap ($600), no one-time, no late bills.

- monthIncome = 3,220.00
- monthBills = 1,833.95
- monthVariable = 600.00
- **Discretionary = 3,220 − 1,833.95 − 600 = 786.05**

**Interpretation:** At $0 commission and disciplined variable spending, Marshall produces ~$786/month of surplus. This is the true baseline savings capacity. Note this is BEFORE any forward-reserve concern because the buffer already exists.

**Assertion:** `discretionaryThisMonth(cleanMonthFixture)` = 786.05 ± 0.01.

---

## SCENARIO 4 — Variable Overspend (the real May lesson)

**What it proves:** Discretionary correctly contracts when variable spending genuinely exceeds plan — without the forward-reserve artifact.

**Setup:** $0 commission, variable runs at the observed $43/day for the full month (= $43 × 30.4 ≈ $1,307.20), no one-time.

- monthIncome = 3,220.00
- monthBills = 1,833.95
- monthVariable = 1,307.20
- **Discretionary = 3,220 − 1,833.95 − 1,307.20 = 78.85**

**Interpretation:** Sustained $43/day nearly erases the surplus — Discretionary falls from $786 (cap pace) to ~$79. This is the correct, honest signal: overspending is the lever, and the number reflects it proportionally and truthfully. Contrast with the old logic, which would have shown a forward-reserve-driven negative regardless of spending and thus carried no real signal about the overspend.

**Assertion:** `discretionaryThisMonth(overspendFixture)` = 78.85 ± 0.10. Sign is positive; magnitude reflects the variable delta, not the forward reserve.

---

## SCENARIO 5 — Commission Lands

**What it proves:** Confirmed commission flows into Discretionary correctly and increases it dollar-for-dollar of take-home.

**Setup:** Clean month (Scenario 3 base) plus a confirmed commission: MRR 700 → gross 1,424.02 → take-home 1,424.02 × 0.565 = 804.57, payout this month.

- monthIncome = 3,220.00 + 804.57 = 4,024.57
- monthBills = 1,833.95
- monthVariable = 600.00
- **Discretionary = 4,024.57 − 1,833.95 − 600 = 1,590.62**

**Interpretation:** Discretionary rises from 786.05 to 1,590.62 — an increase of exactly 804.57, the commission take-home. Commission is pure upside to monthly production because the base already covers the obligations.

**Assertion:** `discretionaryThisMonth(commissionFixture) − discretionaryThisMonth(cleanMonthFixture)` = 804.57 ± 0.01. Also verify commission is counted only when status = paid or confirmed-pending with payout date in the month (commission-as-zero in baseline).

---

## SCENARIO 6 — Bill Payment-State Matrix (Safe to Spend vs Discretionary)

**What it proves:** The payment-state engine feeds each number per the Part 2.5 matrix. Paying a bill moves Safe to Spend but never Discretionary.

**Setup:** June 3, checking 2,000, next payday June 7. Car Loan (day 1) and Verizon (day 2) already auto-paid. Claude (day 3, $21) and Rent (day 4, $1,000) still `scheduled`. Forward reserve for July 1–7 = 1,561.16.

**State 6a — Rent scheduled (unpaid):**
- billsDueBeforeNextPayday (unpaid) = Claude 21 + Rent 1,000 = 1,021
- Safe to Spend = MAX(0, 2,000 − 1,021 − 1,561.16) = MAX(0, −582.16) = **0** (sublabel: "over-committed by 582.16")
- Discretionary This Month (June) counts Rent as a June obligation regardless → unaffected by state

**State 6b — flip Rent to Paid:**
- billsDueBeforeNextPayday (unpaid) = Claude 21
- Safe to Spend = MAX(0, 2,000 − 21 − 1,561.16) = **417.84**
- Discretionary This Month = **unchanged** from 6a

**The proof:** Flipping Rent from scheduled→paid raises the Safe-to-Spend pre-floor by exactly 1,000 (−582.16 → +417.84) and leaves Discretionary unchanged. Payment state is a liquidity/timing concept; it never alters month production.

**Assertions:**
- `safeToSpend(6b) − safeToSpend_preFloor(6a)` = 1000.00 ± 0.01
- `discretionaryThisMonth(6a)` === `discretionaryThisMonth(6b)`

---

## SCENARIO 7 — Utility Paid Late (the requested behavior)

**What it proves:** A manual utility flips to `late_unpaid` automatically, stays in obligations, and corrects all numbers the instant it is marked Paid.

**Setup:** National Grid $175, scheduled day 16, manual. Today is day 20, NG still unpaid. Next payday day 22. Checking 1,400.

**State 7a — auto-flagged late:**
- Engine flips NG scheduled→`late_unpaid` (day 16 < day 20, manual, unpaid).
- NG still counted in Safe to Spend hold (you owe it) with "Late 4d" amber badge.
- billsDueBeforeNextPayday includes NG 175 + EZ-Pass 10 (day 22 = payday → excluded by strict <) → just NG 175 if other bills paid.
- Discretionary This Month counts NG as a month obligation (always).

**State 7b — Marshall pays it, flips to Paid:**
- NG drops out of Safe to Spend hold → Safe to Spend rises by 175.00.
- Discretionary unchanged (NG was always a May obligation).
- paid_date recorded; badge clears.

**The proof:** The manual switch (late→paid) auto-feeds Safe to Spend (+175) and Monthly Savings cycle, while Discretionary stays put. Exactly the requested "switch off/on and auto-feed projections" behavior.

**Assertions:**
- Auto-flag: a manual bill with scheduled_pay_day < today and state scheduled → state becomes `late_unpaid`.
- `safeToSpend(7b) − safeToSpend(7a)` = 175.00 ± 0.01.
- `discretionaryThisMonth(7a)` === `discretionaryThisMonth(7b)`.

---

## SCENARIO 8 — One-Time Defer Toggle

**What it proves:** Deferring a one-time expense removes it from all math and tracks it separately; re-arming restores it.

**Setup:** Clean month (Scenario 3). Add NY State taxes one-time $354, due this month.

**State 8a — scheduled:**
- monthOneTime = 354.00
- Discretionary = 3,220 − 1,833.95 − 600 − 354 = **432.05**

**State 8b — toggle Defer (push to August):**
- monthOneTime = 0 (excluded from all math)
- Moves to Deferred Obligations panel; footer total += 354.
- Discretionary = 3,220 − 1,833.95 − 600 − 0 = **786.05**

**The proof:** Deferring restores Discretionary by exactly the deferred amount (432.05 → 786.05, Δ = 354) and parks it in the tracked deferred panel so it is never lost.

**Assertions:**
- `discretionaryThisMonth(8b) − discretionaryThisMonth(8a)` = 354.00 ± 0.01.
- Deferred item appears in Deferred Obligations with correct footer total and is excluded from Safe to Spend and Discretionary.

---

## SCENARIO 9 — Available vs Posted Balance (resolves the May 22 confusion)

**What it proves:** Modeling two balances prevents the confusion that drove the entire May 22 session.

**Setup:** Bank shows Posted (settled) 345.56 and Available 2,027.07. Pending: deposit +1,722.61, deposit +35.71, and pending debits (Sunoco, Wegmans, Marathon, Black Rock, Replit, Walmart) summing to −76.81.

- Posted (settled) = 345.56
- Pending net = +1,722.61 + 35.71 − 76.81 = +1,681.51
- Available = 345.56 + 1,681.51 = 2,027.07 ✓ (reconciles to the bank)

**Behavior:**
- Update Balance modal captures Posted (345.56) and pending net (+1,681.51).
- Dashboard labels the figure explicitly. Safe to Spend computes from Available with pending debits already netted.
- Advisor snapshot includes both, so it never conflates them.

**The proof:** The whole "how am I negative now" episode was Posted ($345) vs Available ($2,027) confusion. With both modeled and labeled, the engine and advisor always know which is which.

**Assertion:** Given posted + pending inputs, `availableBalance` = posted + pendingNet, reconciling to 2,027.07 ± 0.01. Dashboard renders both with explicit labels.

---

## SCENARIO 10 — Payday Auto-Advance

**What it proves:** A stale payday cannot corrupt cycle math or income counting.

**Setup:** Stored payday = May 21 (stale). Today = May 22.

**Behavior:**
- On load, engine recomputes: today is the 22nd → dayOfMonth (22) is not < 22, so nextNominalPayday = June 7; effective = June 5 if June 7 is a weekend (June 7 2026 is a Sunday → June 5 Friday).
- Wait: today IS the 22nd. The 22nd payday is today. Rule: dayOfMonth < 22 → 22nd this month; else → 7th next month. On the 22nd exactly, the 22nd paycheck is landing today; treat today as payday, next nominal = June 7.
- "remaining paychecks this month" for May, evaluated on May 22: the May 22 paycheck (today) counts as received/landing → May has 0 further paychecks after today, but both May paychecks (7th, 22nd) are still counted in monthIncome for Discretionary because both have payDate in May.

**The proof:** monthIncome for May = both May paychecks regardless of today's position, so Discretionary stays stable (Scenario 1). The cycle boundary (next payday June 7) is correct, not stuck on the stale May 21.

**Assertions:**
- No stored payday is read; `nextNominalPayday(May 22)` = June 7, effective = June 5.
- `monthIncome(May, anyDay)` counts exactly the paychecks with payDate in May (here 2), independent of today.

---

## SCENARIO 11 — Seasonal Utility Variance

**What it proves:** Winter vs summer utility amounts flow into all numbers via the month-keyed table.

**Setup:** National Grid seasonal_amounts = { Jan: 220, Feb: 215, …, Jul: 80, …, Dec: 210 }. Compare January vs July.

- January effective NG = 220 → monthBills = 1,833.95 − 175 (flat default) + 220 = 1,878.95 → Discretionary (clean, $0 comm, cap variable) = 3,220 − 1,878.95 − 600 = **741.05**
- July effective NG = 80 → monthBills = 1,833.95 − 175 + 80 = 1,738.95 → Discretionary = 3,220 − 1,738.95 − 600 = **881.05**

**The proof:** Winter compresses Discretionary by ~$140 vs summer ($741 vs $881), correctly reflecting Buffalo heating costs. Flat values would have hidden this ~$140/mo seasonal swing.

**Assertion:** Bill effective amount = `seasonal_amounts[currentMonth] ?? amount`; Discretionary reflects the seasonal figure. Jan = 741.05, Jul = 881.05 (± 0.01).

---

## SCENARIO 12 — Per-Paycheck Income Override

**What it proves:** A non-standard paycheck (overtime) flows correctly without corrupting future months.

**Setup:** May 22 paycheck is $1,722.61 (overtime) instead of base $1,610. Override set for the May 22 cycle only.

- monthIncome (May) = 1,610 (May 7 base) + 1,722.61 (May 22 override) = 3,332.61
- Discretionary (clean, $0 comm, cap variable) = 3,332.61 − 1,833.95 − 600 = **898.66**
- June, no override → reverts to base: monthIncome = 3,220, Discretionary = 786.05

**The proof:** The override lifts May Discretionary by the $112.61 overtime delta (786.05 → 898.66) and does NOT persist into June. Future months are unaffected.

**Assertions:**
- `discretionaryThisMonth(mayOverrideFixture)` = 898.66 ± 0.01.
- `discretionaryThisMonth(juneFixture)` = 786.05 (override did not leak forward).

---

## SCENARIO 13 — Monthly Savings Floor / Deficit Surfacing

**What it proves:** A real deficit is shown, not masked by a $0 clamp.

**Setup:** Heavy month — variable $1,307 (overspend) AND a $354 non-deferred one-time, $0 commission.

- Raw Discretionary = 3,220 − 1,833.95 − 1,307.20 − 354 = **−275.15**

**Behavior:**
- Discretionary displays the true **−275.15** in red with "running a deficit this month."
- (Monthly Savings Estimate, the cycle number, floors at $0 but shows "deficit of $X" sublabel.)

**The proof:** Negative Discretionary is real and shown, not clamped. The user sees the truth: this month consumed $275 of buffer.

**Assertion:** `discretionaryThisMonth(deficitFixture)` = −275.15 ± 0.10, displayed signed (not clamped).

---

## SCENARIO 14 — Cross-Validation: UI Card === Engine

**What it proves:** Every dashboard card equals its engine call — the test category whose absence allowed the original defect to ship.

**Setup:** Any fixture above. Render the dashboard. Read each card's displayed numeric value.

**Assertions (for each fixture):**
- `displayed(SafeToSpendCard)` === `engine.safeToSpend(fixture)`
- `displayed(DiscretionaryCard)` === `engine.discretionaryThisMonth(fixture)`
- `displayed(MonthlySavingsCard)` === `engine.monthlySavingsEstimate(fixture)`
- `displayed(ForwardReserve)` === `engine.forwardReserve(fixture)`

No card may compute its own value independently of the engine. If any card derives a number locally, that is the bug class that produced −$1,547 and must be removed.

---

## Summary Table — Corrected Outputs Across All Scenarios

| # | Scenario | Key corrected output |
|---|---|---|
| 1 | Stability | Discretionary flat at 786.05 all month |
| 2 | May 22 re-run | +934.37 (was −1,547.16) |
| 3 | Clean month | 786.05 |
| 4 | Overspend $43/day | 78.85 |
| 5 | Commission lands | 1,590.62 (+804.57) |
| 6 | Pay a bill | Safe to Spend +1,000; Discretionary unchanged |
| 7 | Utility late→paid | Safe to Spend +175; Discretionary unchanged |
| 8 | Defer one-time | Discretionary +354 (432.05 → 786.05) |
| 9 | Available vs Posted | Available 2,027.07 reconciles |
| 10 | Payday auto-advance | next payday June 7, income stable |
| 11 | Seasonal utility | Jan 741.05 vs Jul 881.05 |
| 12 | Income override | May 898.66, June reverts to 786.05 |
| 13 | Deficit surfacing | −275.15 shown signed |
| 14 | UI === engine | every card matches engine call |

---

## What This Analysis Proves

1. **The headline defect is fixed.** Discretionary is stable across the month (Scenario 1) and the exact −$1,547 case now returns a sensible +$934 (Scenario 2).
2. **The fix is principled, not a patch.** Removing forward reserve from the flow measure and anchoring to the month makes every scenario internally consistent and reconcilable with the cash analysis.
3. **The payment-state engine behaves correctly.** Bills and one-time items move the right numbers and leave the others untouched (Scenarios 6, 7, 8).
4. **The data-trust fixes resolve the real-world confusion.** Available vs Posted and payday auto-advance (Scenarios 9, 10) eliminate the ambiguities that drove the May 22 session.
5. **Edge behaviors are correct.** Seasonality, income overrides, and deficits all flow truthfully (Scenarios 11, 12, 13).
6. **Regressions are prevented structurally.** The UI-vs-engine cross-validation (Scenario 14) closes the test gap that let the original defect ship.

**Instruction to the Agent:** Encode all 14 scenarios as automated tests before implementing the corresponding logic, then implement until every assertion passes. Scenarios 1, 2, and 14 are the non-negotiable core — they directly prevent the defect that motivated this entire correction.

---

*End of Validation Analysis. Pair with Playbook v8.0.*
