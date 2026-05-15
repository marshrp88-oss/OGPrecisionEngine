# Forward Reserve Audit

Per MASTER_PLAN §2.1. Documents how the three discretionary/savings/safe-to-spend functions in `lib/finance/engine.ts` use Forward Reserve, and confirms each matches Playbook §2.1.

## Playbook §2.1 (the rule)

> Forward Reserve feeds Monthly Savings (B62) but NOT current-cycle Safe to Spend (B19/B16).

Restated: Forward Reserve is the cash that must be set aside today to cover bills due in the first 7 days of *next* month (i.e. between the next paycheck-cycle's payday and the calendar-month rollover). It is **excluded** from current-cycle spending authority and **included** as a deduction in the monthly savings projection.

## Function inventory

### 1. `safeToSpend` — `engine.ts:551`

**Question:** "Can I spend today without missing a bill before next payday?"

**Forward Reserve usage:** Excluded by default. The `includeForwardReserveInSts` flag defaults to `false`. When false (the always-used production path), the effective hold is `hold - forwardReserveAmount`, which subtracts Forward Reserve from the hold *before* it is itself subtracted from checking. Net effect: Forward Reserve does NOT reduce STS.

**Verdict:** ✅ Matches §2.1. Forward Reserve is excluded from STS.

### 2. `monthlySavingsEstimate` — `engine.ts:654`

**Question:** "What will this paycheck-boundary cycle leave behind by next payday?"

**Forward Reserve usage:** Subtracted as `fwdReserve` (line 689) using the dedicated `forwardReserve(billsForReserve, variableCap, monthLengthDays, currentCycleBills)` overload that explicitly excludes current-cycle bills to prevent double-counting.

**Verdict:** ✅ Matches §2.1. Forward Reserve is included as a deduction; double-count protection is in place.

### 3. `discretionaryThisMonth` — `engine.ts:730`

**Question (current implementation):** "How much cash from checking can I deploy by end of month after every known obligation is funded?"

**Forward Reserve usage:** Subtracted as `fwdReserve` (line 753) using the *full* Forward Reserve (no current-cycle exclusion).

**Rationale (per docstring lines 746-752):** Discretionary uses a checking-anchored model and does not subtract Required Hold separately. Without subtracting Forward Reserve, May 1-7 obligations would be invisible to the function, creating a false-positive surplus on, say, April 30. Adding it ensures every June 1-7 obligation is reserved out of today's cash. The double-count concern that applies to `monthlySavingsEstimate` (which subtracts both full-month-fixed AND forward-reserve, where Car Loan would otherwise appear twice) does not apply here because `discretionaryThisMonth` only subtracts current-month bills, not next-month-1-7 bills.

**Verdict:** ✅ Internally consistent within the checking-anchored model.

## Conflict with MASTER_PLAN §1.2

MASTER_PLAN §1.2 specifies a **different** Discretionary calculation — an **income-anchored** model that sums paychecks received + expected remaining + commission paid + commission pending, and explicitly does NOT subtract Forward Reserve (because all bills inside this month are already in the outgo side, and June 1-7 bills are not in this month at all). That formula is mathematically incompatible with the current checking-anchored implementation.

Resolution requires a product decision (filed in chat as "Conflict A"). Options:

- **(A)** Keep current checking-anchored function, amend the plan.
- **(B)** Replace per §1.2; preserve current implementation under a new name `liquidityRemainingByEom` so the existing 170 tests continue to validate it.

Until that decision is made, `discretionaryThisMonth` remains checking-anchored and the audit above stands.

## Tests

All three functions have dedicated unit tests in `lib/finance/engine.test.ts`:
- `safeToSpend` — extensive coverage of the Forward Reserve exclusion, including the `includeForwardReserveInSts` toggle.
- `monthlySavingsEstimate` — covers the double-count protection for current-cycle bills.
- `discretionaryThisMonth` — covers the checking-anchored math including the Forward Reserve subtraction.

170/170 pass at the time of this audit.
