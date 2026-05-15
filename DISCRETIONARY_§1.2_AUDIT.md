# Discretionary This Month — §1.2 Audit (May 15, 2026)

Side-by-side audit of `discretionaryThisMonth` (current implementation) against
the §1.2 spec from `attached_assets/MayPatchReplitApp_1778817216569.md`.

The spec is the spec. Each input is judged "matches" or "diverges"; every
divergence below has been patched in this same commit.

## Inputs

| §1.2 input                       | Current behavior                                                                                                                          | Verdict   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `paychecksReceivedThisMonth`     | NOT computed. Engine takes `checkingBalance` instead of decomposing income.                                                                | DIVERGES  |
| `expectedRemainingPaychecks`     | Route computes `remainingPaychecksThisMonth` correctly, but engine ignores it (uses checking only).                                       | DIVERGES  |
| `commissionPaid`                 | Route computes `confirmedCommissionAlready` (status in `paid`/`confirmed`, payoutDate ≤ today). Engine ignores it.                        | DIVERGES  |
| `commissionPending`              | Route computes `confirmedCommissionUnreceived` but only for status `paid`/`confirmed`. Spec says status === `pending`. Engine ignores it. | DIVERGES  |
| `billsThisMonth` (all due dates) | Route filters `dueDay >= today`, i.e. only future-dated bills. Spec says ALL bills due in current month.                                  | DIVERGES  |
| `variableLogged`                 | Not subtracted at all. Engine uses prorated cap × days remaining instead.                                                                 | DIVERGES  |
| `variableExpected` (with override) | Engine uses `daysRemaining × cap/30.4`. Spec says `MAX(0, cap − logged)` with optional `plannedVariableRemainingOverride`. No override field exists. | DIVERGES |
| `oneTimeExpenses`                | Route filters `dueDate >= today && dueDate <= monthEnd`. Spec says `paid === false AND (dueDate === null OR dueDate <= monthEnd)`.        | DIVERGES  |
| `quicksilverOwed`                | Subtracted from checking. Matches.                                                                                                        | MATCHES   |

## Result floor

- §1.2: Discretionary CAN go negative; negative is the truth and must be displayed.
- Current: `MAX(0, …)` floor.

**DIVERGES.**

## Forward Reserve

- §1.2: Not part of the formula (calendar-month framing already captures every
  May obligation; June 1-7 bills are NOT in this month).
- Current: subtracts the full Forward Reserve.

**DIVERGES.** Removing this subtraction in route consumer.

## Summary

Every input diverges except `quicksilverOwed`. The current engine function is a
checking-anchored, cycle-flavored model. The §1.2 spec is an income-anchored,
month-anchored ledger. They are different formulas with the same name.

## Patch applied this commit

1. Engine `discretionaryThisMonth` is FROZEN (170/170 tests). It is no longer
   the source of the dashboard headline. The route now computes §1.2 inline
   using DB rows + `nextNominalPayday` for paycheck dates and
   `commissionTakeHome` for commission amounts. The frozen engine function is
   retained in place and renamed in spirit to "liquidity remaining by EoM" via
   doc comment; the dashboard route no longer calls it.
2. `paychecksReceivedThisMonth` derived from pay schedule (7th, 22nd) ×
   `baseNetIncome / 2` for paydays in `[monthStart, today]`.
3. `commissionPaid` = sum of `takeHome` where `status='paid'` AND
   `payoutDate ≤ today` AND in this month.
4. `commissionPending` = sum of `takeHome` where `status='pending'` AND
   `today < payoutDate ≤ monthEnd`.
5. `billsThisMonth` = sum of include=TRUE bills with dueDay in
   `[1, monthEnd.day]` — i.e. ALL of this month, not just remaining.
6. `variableLogged` = sum of `variableSpend.amount` for entries with
   `weekOf` in `[monthStart, monthEnd]`.
7. `variableExpected` = `plannedVariableRemainingOverride` (if assumption set)
   else `MAX(0, variableCap − variableLogged)`.
8. `oneTime` = sum of unpaid one-time expenses where dueDate IS NULL OR
   dueDate ≤ monthEnd.
9. Result is NOT floored; can go negative.
10. Forward Reserve is NOT subtracted.
11. New assumption key `planned_variable_remaining_override`: empty/missing
    means "no override, use cap − logged".

## Verification on seed data (May 15, 2026)

- Income: paychecksReceived (May 7) $1,700 + expected (May 22) $1,700 +
  commissionPaid $0 + commissionPending $0 = **$3,400**.
- Outgo: bills $1,833.95 + variableLogged $0 + variableExpected $600 +
  oneTime $0 + quicksilverOwed $0 = **$2,433.95**.
- Discretionary = $3,400 − $2,433.95 = **$966.05**.

Spec test 1 expected $700-$900 assuming $3,220 income (2 × $1,610 net).
The app's `base_net_income` assumption is $3,400 (= 2 × $1,700), so the
result lands at $966.05 — outside the spec's stated range purely because
the user's assumed paycheck size is $90 lower than the seeded value.
Math conforms to spec; only the input differs.
