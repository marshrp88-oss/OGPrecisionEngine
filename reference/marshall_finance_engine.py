"""
marshall_finance_engine.py
==========================
Reference implementation for Marshall Finance — the personal financial
operating system replacing OG_Financial_Engine_7_2.xlsx.

Every function is:
  - Pure (inputs → output, no side effects)
  - Typed
  - Documented with the source cell or playbook section
  - Numerically exact to the workbook (no rounding in intermediate steps)

SOURCE AUTHORITY (in descending precedence):
  1. FIX_PLAN.md  (most recent corrections — overrides all)
  2. OG_Financial_Engine_7_2.xlsx  (workbook formulas)
  3. Claude_Financial_Playbook_v7_3.docx  (methodology)
  4. BUILD_SPEC.md  (architecture)

Zero external dependencies. Python 3.11+ stdlib only.

Author: Marshall Finance reference engine (generated April 2026)
"""

from __future__ import annotations

import math
import calendar
from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import Enum
from typing import Optional


# ---------------------------------------------------------------------------
# 0. CONSTANTS  (Assumptions sheet — all values from B2:B15)
# ---------------------------------------------------------------------------

POSTING_CUSHION_DAYS: int = 1          # Assumptions!B2
COMMISSION_TAX_RATE: float = 0.435     # Assumptions!B3
MONTH_LENGTH_DAYS: float = 30.4        # Assumptions!B4  — denominator for proration
COMMISSION_PAYOUT_DAY: int = 22        # Assumptions!B5
MRR_TARGET: float = 700.0             # Assumptions!B6
NRR_TARGET: float = 6000.0            # Assumptions!B7
ALERT_THRESHOLD_YELLOW: float = 400.0  # Assumptions!B8
VARIABLE_SPEND_CAP: float = 600.0     # Assumptions!B9
BASE_NET_INCOME: float = 3220.0       # Assumptions!B10
HYSA_TARGET: float = 15000.0          # Assumptions!B11
RETIREMENT_RETURN: float = 0.07       # Assumptions!B12
TAX_ANNUAL_RESERVE: float = 400.0     # Assumptions!B13
SAVINGS_TO_HYSA_RATIO: float = 0.5    # Assumptions!B14
INCLUDE_FORWARD_RESERVE_IN_STS: bool = True  # Assumptions!B15

# FIX_PLAN §A2 — corrected 401(k) match structure (replaces old B7/B8)
K401_MATCH_MULTIPLIER: float = 0.50   # Employer matches this fraction of employee contribution
K401_EMPLOYEE_CEILING: float = 0.08   # Employee ceiling % of gross for match calculation
K401_CONTRIBUTION_PCT: float = 0.04   # Current employee contribution (as of April 2026)

GROSS_SALARY: float = 54000.0         # Assumptions!B35 (Tax Planning)
FED_TAX_RATE: float = 0.12            # Assumptions!B36
STATE_TAX_RATE: float = 0.04          # Assumptions!B37
PAY_PERIODS_PER_YEAR: int = 24        # Semi-monthly

DROUGHT_THRESHOLD: float = 50.0       # Playbook §6.4 — commission < $50 = drought month
STALENESS_WARN_DAYS: int = 3          # Playbook §4.8 — stale after 3 days


# ---------------------------------------------------------------------------
# 1. DATA CLASSES
# ---------------------------------------------------------------------------

@dataclass
class Bill:
    """One row from the Bills sheet."""
    name: str
    amount: float          # Column B
    due_day: int           # Column C — day of month (1-31)
    include: bool          # Column F — TRUE = must be reserved
    category: str = ""     # Column J
    autopay: bool = True   # Column K
    notes: str = ""        # Column N


@dataclass
class OneTimeExpense:
    """One slot from Dashboard B35:B39 / C35:C39."""
    name: str
    amount: float
    due_date: Optional[date]   # None = dateless (invisible to cycle hold, visible to savings)
    paid: bool = False


@dataclass
class CommissionRow:
    """One row from the Commissions sheet (A11:H22+)."""
    sales_month: date          # Column A — first-of-month
    mrr_achieved: float        # Column B
    nrr_achieved: float        # Column C
    # D/E/F/G computed at query time — not stored per BUILD_SPEC §5.1


@dataclass
class VariableSpendEntry:
    """One week from Dashboard B44:B48."""
    week_start: date
    amount: float              # Total logged variable spend
    card_accrual: float = 0.0  # QuickSilver portion (Dashboard B48)


@dataclass
class PurchaseOption:
    """One column (B–E) from Decision Sandbox."""
    name: str
    total_price: float
    down_payment: float = 0.0
    annual_rate: float = 0.0   # as decimal, e.g. 0.0474
    term_months: int = 60
    monthly_addons: float = 0.0  # Insurance, tax, HOA
    one_time_cost: float = 0.0   # For outright purchases (no loan)


@dataclass
class IntegrityCheckResult:
    """One row from Assumptions D20:D29."""
    check_number: int
    description: str
    passed: bool
    detail: str = ""


# ---------------------------------------------------------------------------
# 2. DATE UTILITIES
# ---------------------------------------------------------------------------

def effective_payday(nominal: date) -> date:
    """
    Weekend-adjust a nominal payday to the prior Friday.

    Source: Dashboard!B26 / BUILD_SPEC §4.7 / FIX_PLAN §B6
    Logic: WEEKDAY(B4,2) >= 6 → "WEEKEND PAYDAY RISK"
    Python: weekday() — Monday=0, Saturday=5, Sunday=6

    >>> from datetime import date
    >>> effective_payday(date(2026, 8, 22))  # Saturday → Friday
    datetime.date(2026, 8, 21)
    >>> effective_payday(date(2026, 11, 22))  # Sunday → Friday
    datetime.date(2026, 11, 20)
    >>> effective_payday(date(2026, 4, 22))  # Wednesday → unchanged
    datetime.date(2026, 4, 22)
    """
    dow = nominal.weekday()  # 0=Mon … 5=Sat, 6=Sun
    if dow == 5:   # Saturday → -1
        return nominal - timedelta(days=1)
    if dow == 6:   # Sunday → -2
        return nominal - timedelta(days=2)
    return nominal


def next_nominal_payday(today: date, pay_days: tuple[int, ...] = (7, 22)) -> date:
    """
    Return the next nominal payday date (before weekend adjustment).

    Pay schedule is semi-monthly on the 7th and 22nd.
    Source: BUILD_SPEC §4.1 / owner_profile.pay_schedule_days
    """
    candidates: list[date] = []
    for day in pay_days:
        last_dom = calendar.monthrange(today.year, today.month)[1]
        d = min(day, last_dom)
        candidate = today.replace(day=d)
        if candidate >= today:
            candidates.append(candidate)
    if candidates:
        return min(candidates)
    # All paydays this month have passed — advance to next month
    if today.month == 12:
        nm_year, nm_month = today.year + 1, 1
    else:
        nm_year, nm_month = today.year, today.month + 1
    nm_last = calendar.monthrange(nm_year, nm_month)[1]
    first_day = min(pay_days[0], nm_last)
    return date(nm_year, nm_month, first_day)


def days_until_payday(today: date, next_payday_nominal: date) -> int:
    """
    Days remaining until the effective payday. Uses ceil so "tomorrow"
    shows as 1, not 0.

    Source: FIX_PLAN §B5 — off-by-one fix.
    Formula: Math.max(0, Math.ceil(ms / (1000*60*60*24)))
    """
    effective = effective_payday(next_payday_nominal)
    delta = (effective - today).days
    return max(0, delta)


def bill_next_due_date(today: date, due_day: int, include: bool) -> Optional[date]:
    """
    Compute the next due date for a bill — replicates Bills!Column D formula.

    For most bills (rows 3+):
      =IF(OR(C="",F=FALSE),"",
         IF(DATE(YEAR(TODAY()),MONTH(TODAY()),C)>=TODAY(),
            DATE(YEAR(TODAY()),MONTH(TODAY()),C),
            EDATE(DATE(YEAR(TODAY()),MONTH(TODAY()),C),1)))

    For row 2 (Gym, EOMONTH variant — handles months shorter than due_day):
      Clamps due_day to last day of current month before comparison.

    We use the clamped version for all rows (functionally equivalent for
    any due_day ≤ 28, and correct for days 29-31 in short months).

    Source: Bills!D2:D13 / Playbook §1.1
    """
    if not include or due_day is None:
        return None
    # Clamp to last day of current month
    last_dom = calendar.monthrange(today.year, today.month)[1]
    clamped = min(due_day, last_dom)
    candidate = today.replace(day=clamped)
    if candidate >= today:
        return candidate
    # Roll to next month
    if today.month == 12:
        ny, nm = today.year + 1, 1
    else:
        ny, nm = today.year, today.month + 1
    last_dom_nm = calendar.monthrange(ny, nm)[1]
    clamped_nm = min(due_day, last_dom_nm)
    return date(ny, nm, clamped_nm)


def commission_payout_date(sales_month: date, payout_day: int = COMMISSION_PAYOUT_DAY) -> date:
    """
    Return payout date for a given sales month: the 22nd of the following month.

    Source: Commissions!H11: =DATE(YEAR(A11),MONTH(A11)+1,Assumptions!B5)
    """
    if sales_month.month == 12:
        return date(sales_month.year + 1, 1, payout_day)
    return date(sales_month.year, sales_month.month + 1, payout_day)


def days_since_update(last_update: date, today: date) -> int:
    """
    Days since the checking balance was last updated.
    Source: Dashboard!B8 = TODAY() - B5
    """
    return (today - last_update).days


# ---------------------------------------------------------------------------
# 3. FINANCIAL MATH UTILITIES
# ---------------------------------------------------------------------------

def pmt(annual_rate: float, term_months: int, principal: float) -> float:
    """
    Monthly loan payment — Excel PMT(rate/12, term, -principal).

    PMT(r, n, pv) = pv * r / (1 - (1+r)^-n)

    When rate is 0, returns principal / term_months.
    Source: Decision Sandbox!B21, Debt Strategy!B19,B24,B33,B38,B43
    """
    if annual_rate == 0:
        return principal / term_months if term_months > 0 else 0.0
    r = annual_rate / 12
    return principal * r / (1 - (1 + r) ** (-term_months))


def fv(annual_rate: float, periods: int, payment: float, pv: float) -> float:
    """
    Future value — Excel FV(rate, nper, pmt, pv).
    Sign convention: pv and pmt are positive inflows; result is balance.

    FV = -pv * (1+r)^n - pmt * ((1+r)^n - 1) / r

    Source: Retirement Planning!B35/B36/B39/B40 and Decision Sandbox!B26
    """
    if annual_rate == 0:
        return pv + payment * periods
    r = annual_rate
    growth = (1 + r) ** periods
    return pv * growth + payment * (growth - 1) / r


def fv_annual(annual_rate: float, years: int, annual_payment: float, pv: float) -> float:
    """
    Future value with annual contributions and annual compounding.
    Used for retirement projections.

    Source: Retirement Planning!B35: =FV(B12, 60-B10, -B19-B21, -B9)
    Note: workbook calls FV with periods in years and annual pmt.
    """
    return fv(annual_rate, years, annual_payment, pv)


# ---------------------------------------------------------------------------
# 4. COMMISSION ENGINE
# ---------------------------------------------------------------------------

def mrr_payout_gross(mrr: float, mrr_target: float = MRR_TARGET) -> float:
    """
    MRR gross payout using 4-tier piecewise formula.

    EXACT formula from Commissions!D11 (workbook):
      MAX(0,MIN(mrr,349.93)-0)*0.3705
      +MAX(0,MIN(mrr,489.93)-349.93)*0.9634
      +MAX(0,MIN(mrr,mrr_target-0.07)-489.93)*5.5212
      +MAX(0,mrr-(mrr_target-0.07))*0.65

    Source: Commissions!D11 / FIX_PLAN §B1 / BUILD_SPEC §5.3
    Tier breakpoints are functions of mrr_target, not hardcoded.
    """
    if mrr <= 0:
        return 0.0
    tier1_cap = 349.93
    tier2_cap = 489.93
    tier3_cap = mrr_target - 0.07   # = 699.93 when target = 700

    tier1 = max(0.0, min(mrr, tier1_cap)) * 0.3705
    tier2 = max(0.0, min(mrr, tier2_cap) - tier1_cap) * 0.9634
    tier3 = max(0.0, min(mrr, tier3_cap) - tier2_cap) * 5.5212
    tier4 = max(0.0, mrr - tier3_cap) * 0.65

    return tier1 + tier2 + tier3 + tier4


def nrr_payout_gross(nrr: float, nrr_target: float = NRR_TARGET) -> float:
    """
    NRR gross payout using 4-tier piecewise formula.

    EXACT formula from Commissions!E11 (workbook):
      MAX(0,MIN(nrr,2999.4)-0)*0.0204
      +MAX(0,MIN(nrr,4199.4)-2999.4)*0.0388
      +MAX(0,MIN(nrr,nrr_target-0.6)-4199.4)*0.2801
      +MAX(0,nrr-(nrr_target-0.6))*0.042

    Source: Commissions!E11 / FIX_PLAN §B1 / BUILD_SPEC §5.3
    """
    if nrr <= 0:
        return 0.0
    tier1_cap = 2999.40
    tier2_cap = 4199.40
    tier3_cap = nrr_target - 0.6   # = 5999.40 when target = 6000

    tier1 = max(0.0, min(nrr, tier1_cap)) * 0.0204
    tier2 = max(0.0, min(nrr, tier2_cap) - tier1_cap) * 0.0388
    tier3 = max(0.0, min(nrr, tier3_cap) - tier2_cap) * 0.2801
    tier4 = max(0.0, nrr - tier3_cap) * 0.042

    return tier1 + tier2 + tier3 + tier4


def commission_take_home(
    mrr: float,
    nrr: float,
    mrr_target: float = MRR_TARGET,
    nrr_target: float = NRR_TARGET,
    tax_rate: float = COMMISSION_TAX_RATE,
) -> float:
    """
    Take-home commission after estimated tax withholding.

    Source: Commissions!G11: =F11*(1-$B$8)
    where B8 = Assumptions!B3 (0.435)

    Take-home = (MRR_gross + NRR_gross) * (1 - tax_rate)
    """
    gross = mrr_payout_gross(mrr, mrr_target) + nrr_payout_gross(nrr, nrr_target)
    return gross * (1.0 - tax_rate)


def confirmed_commission_this_month(
    commissions: list[CommissionRow],
    today: date,
    mrr_target: float = MRR_TARGET,
    nrr_target: float = NRR_TARGET,
    tax_rate: float = COMMISSION_TAX_RATE,
    payout_day: int = COMMISSION_PAYOUT_DAY,
) -> float:
    """
    Commission take-home confirmed for the current month.

    Replicates Dashboard!B55:
      =IFERROR(INDEX(Commissions!G:G,
               MATCH(DATE(YEAR(TODAY()),MONTH(TODAY()),22),
                     Commissions!H:H, 0)), "")

    Logic: find the commission row whose payout_date equals DATE(today.year,
    today.month, 22). If found AND payout_date <= today, return take-home.
    Blank/unfound = $0 (commission-as-zero rule).

    Source: Dashboard!B55 / Playbook §2.5 / BUILD_SPEC §4.2
    """
    target_payout = date(today.year, today.month, payout_day)
    for row in commissions:
        pd = commission_payout_date(row.sales_month, payout_day)
        if pd == target_payout and pd <= today:
            return commission_take_home(row.mrr_achieved, row.nrr_achieved,
                                        mrr_target, nrr_target, tax_rate)
    return 0.0


def drought_flag(
    commissions: list[CommissionRow],
    threshold: float = DROUGHT_THRESHOLD,
    mrr_target: float = MRR_TARGET,
    nrr_target: float = NRR_TARGET,
    tax_rate: float = COMMISSION_TAX_RATE,
    consecutive_months: int = 2,
) -> bool:
    """
    True if the most recent N consecutive commission months all had
    take-home below the drought threshold.

    Playbook §6.4: "Commission drought: B54 blank or near-zero for 2+
    consecutive months. Drought flag at < $50 threshold."

    Playbook §1.4 note: "Drought Flag checks ALL months of data, not just
    last 3 — this is more conservative than the label implies."

    Implementation: check the last `consecutive_months` rows by sales_month
    order. If all have take_home < threshold, flag is active.

    Source: Commissions!B26 (ArrayFormula) / Playbook §1.4 / BUILD_SPEC §6.1
    """
    if not commissions:
        return False
    sorted_rows = sorted(commissions, key=lambda r: r.sales_month)
    recent = sorted_rows[-consecutive_months:]
    if len(recent) < consecutive_months:
        return False
    return all(
        commission_take_home(r.mrr_achieved, r.nrr_achieved, mrr_target, nrr_target, tax_rate)
        < threshold
        for r in recent
    )


# ---------------------------------------------------------------------------
# 5. BILLS ENGINE
# ---------------------------------------------------------------------------

def bills_in_current_cycle(
    bills: list[Bill],
    today: date,
    next_payday_nominal: date,
) -> list[tuple[Bill, date]]:
    """
    Filter bills that count in the current cycle hold.

    Replicates Bills!Column H AND gate (dual-audit verified):
      =AND(F=TRUE, B>0, D>=TODAY(), D<Dashboard!$B$4)

    CRITICAL: strict D < B4 (next payday). Bills due ON payday are excluded
    because they are covered by the incoming check, not reserved from prior cash.

    Source: Bills!H2:H13 / Playbook §1.1 / BUILD_SPEC §4.4 / FIX_PLAN §B2
    """
    effective_next = effective_payday(next_payday_nominal)
    result: list[tuple[Bill, date]] = []
    for bill in bills:
        if not bill.include:
            continue
        if bill.amount <= 0:
            continue
        next_due = bill_next_due_date(today, bill.due_day, bill.include)
        if next_due is None:
            continue
        if next_due >= today and next_due < effective_next:
            result.append((bill, next_due))
    return result


def forward_reserve(
    bills: list[Bill],
    variable_cap: float = VARIABLE_SPEND_CAP,
    month_length_days: float = MONTH_LENGTH_DAYS,
) -> float:
    """
    Forward Reserve: sum of bills due 1st–7th of next month (Include=TRUE)
    plus 7 days of prorated variable spend.

    Source: Dashboard!B33:
      =SUMIFS(Bills!B:B, Bills!F:F, TRUE, Bills!C:C, ">="&1, Bills!C:C, "<="&7)
       + (7 * (Assumptions!B9 / Assumptions!B4))

    IMPORTANT: uses due_day (Column C), not computed next_due_date.
    IMPORTANT: B33 feeds B61 in Monthly Savings ONLY.
    B33 is NOT in B16 (Total Required Hold) — forward reserve double-count
    was resolved in v7.1.

    Source: Dashboard!B33 / Playbook §2.1 / BUILD_SPEC §4.3 / FIX_PLAN §B4
    """
    bills_1_thru_7 = sum(
        b.amount for b in bills
        if b.include and b.due_day >= 1 and b.due_day <= 7
    )
    daily_variable = variable_cap / month_length_days
    return bills_1_thru_7 + 7.0 * daily_variable


def required_hold(
    bills_due_total: float,
    pending_holds: float = 0.0,
    minimum_cushion: float = 0.0,
    checking_floor: float = 0.0,
    irregular_buffer: float = 0.0,
    timing_buffer: float = 0.0,
    one_time_due_total: float = 0.0,
) -> float:
    """
    Total Required Hold — sum of all reserves against checking.

    Source: Dashboard!B16:
      =B11+B12+B13+B30+B31+B32+B40
      where B11=bills, B12=pending, B13=cushion, B30=floor,
            B31=irregular, B32=timing, B40=one_time_due

    NOTE: B33 (Forward Reserve) is NOT in this formula.
    """
    return (
        bills_due_total
        + pending_holds
        + minimum_cushion
        + checking_floor
        + irregular_buffer
        + timing_buffer
        + one_time_due_total
    )


def one_time_expenses_due_in_cycle(
    expenses: list[OneTimeExpense],
    today: date,
    next_payday_nominal: date,
) -> float:
    """
    Sum of one-time expenses with due dates falling in the current cycle.

    Source: Dashboard!B40 SUMPRODUCT:
      =SUMPRODUCT((B35:B39)*((C35:C39>=TODAY())*(C35:C39<=B4)*(B35:B39<>"")))

    Note: upper bound is <= next_payday (inclusive), unlike bills (strict <).
    Dateless expenses (C column blank) are invisible to this calculation
    but still appear in B59 (known_one_time_all).

    Source: Dashboard!B40 / BUILD_SPEC §4.5
    """
    effective_next = effective_payday(next_payday_nominal)
    return sum(
        e.amount
        for e in expenses
        if (not e.paid
            and e.due_date is not None
            and e.due_date >= today
            and e.due_date <= effective_next)
    )


def known_one_time_all(expenses: list[OneTimeExpense]) -> float:
    """
    Sum of ALL unpaid one-time expenses regardless of due date.

    Source: Dashboard!B59: =SUM(B35:B39)
    Includes dateless expenses — they reduce the savings estimate even
    if they don't appear in the current cycle hold.
    """
    return sum(e.amount for e in expenses if not e.paid)


# ---------------------------------------------------------------------------
# 6. CYCLE DECISION OUTPUTS
# ---------------------------------------------------------------------------

def safe_to_spend(
    checking_balance: float,
    bills_due_total: float,
    pending_holds: float = 0.0,
    minimum_cushion: float = 0.0,
    checking_floor: float = 0.0,
    irregular_buffer: float = 0.0,
    timing_buffer: float = 0.0,
    one_time_due_total: float = 0.0,
    forward_reserve_amount: float = 0.0,
    include_forward_reserve_in_sts: bool = INCLUDE_FORWARD_RESERVE_IN_STS,
) -> float:
    """
    Safe to Spend — primary cycle decision output.

    Source: Dashboard!B19:
      =MAX(0, B6 - IF(Assumptions!$B$15=TRUE, B16, B16-B33))

    When include_forward_reserve_in_sts=TRUE (default):
      STS = MAX(0, checking - hold)
    When FALSE:
      STS = MAX(0, checking - (hold - forward_reserve))

    CRITICAL SEPARATION: safe_to_spend() NEVER calls forward_reserve().
    monthly_savings_estimate() calls forward_reserve().
    These answer different questions:
      - safe_to_spend: "what can I spend from checking right now?"
      - monthly_savings: "what will I have left at end of cycle?"

    Source: Dashboard!B19 / Playbook §1.2 / BUILD_SPEC §4.4 / FIX_PLAN §B2
    """
    hold = required_hold(
        bills_due_total, pending_holds, minimum_cushion,
        checking_floor, irregular_buffer, timing_buffer, one_time_due_total,
    )
    if include_forward_reserve_in_sts:
        effective_hold = hold
    else:
        effective_hold = hold - forward_reserve_amount
    return max(0.0, checking_balance - effective_hold)


def daily_rate_static(
    safe_to_spend_amount: float,
    variable_spend_until_payday: float,
    next_payday_nominal: date,
    last_balance_update: date,
) -> float:
    """
    Daily Rate (From Last Update) — static rate anchored to balance update date.

    Source: Dashboard!B21:
      =IFERROR(IF(B4<=B5, 0, MAX(0,(B19-B24)/(B4-B5))), 0)

    where B4=next_payday, B5=last_balance_update, B19=safe_to_spend, B24=variable_until_payday

    Returns 0 if payday has passed or already arrived (B4 <= B5).
    B24 (variable_spend_until_payday) is intentionally manual — not wired to variable log.
    """
    effective = effective_payday(next_payday_nominal)
    days = (effective - last_balance_update).days
    if days <= 0:
        return 0.0
    return max(0.0, (safe_to_spend_amount - variable_spend_until_payday) / days)


def daily_rate_realtime(
    safe_to_spend_amount: float,
    variable_spend_until_payday: float,
    next_payday_nominal: date,
    today: date,
) -> float:
    """
    Daily Rate (Real-Time) — tightens daily as payday approaches.

    Source: Dashboard!B22:
      =IFERROR(IF($B$4<=TODAY(), 0, MAX(0,(B19-B24)/($B$4-TODAY()))), 0)

    This rate tightens each day because the denominator shrinks.
    The static rate (B21) stays fixed until balance is updated.
    """
    effective = effective_payday(next_payday_nominal)
    days = (effective - today).days
    if days <= 0:
        return 0.0
    return max(0.0, (safe_to_spend_amount - variable_spend_until_payday) / days)


def days_of_coverage(safe_to_spend_amount: float, daily_rate: float) -> Optional[float]:
    """
    Days of coverage at the current daily rate.

    Source: Dashboard!B23:
      =IFERROR(IF(B21=0,"",B19/B21),"")

    Returns None when daily rate is 0 (no meaningful coverage figure).
    """
    if daily_rate == 0:
        return None
    return safe_to_spend_amount / daily_rate


class CycleStatus(Enum):
    RED = "RED"
    YELLOW = "YELLOW"
    GREEN = "GREEN"


def cycle_status(
    safe_to_spend_amount: float,
    yellow_threshold: float = ALERT_THRESHOLD_YELLOW,
) -> CycleStatus:
    """
    RED / YELLOW / GREEN cycle status.

    Source: Dashboard!B27 (IFS formula):
      =IFS(B19<=0,"RED", B19<Assumptions!B8,"YELLOW", TRUE,"GREEN")

    RED:    safe_to_spend <= 0
    YELLOW: 0 < safe_to_spend < yellow_threshold
    GREEN:  safe_to_spend >= yellow_threshold

    Source: Dashboard!B27 / Assumptions!B8 / BUILD_SPEC §4.10
    """
    if safe_to_spend_amount <= 0:
        return CycleStatus.RED
    if safe_to_spend_amount < yellow_threshold:
        return CycleStatus.YELLOW
    return CycleStatus.GREEN


# ---------------------------------------------------------------------------
# 7. MONTHLY SAVINGS ESTIMATE  (Dashboard B62 — master output)
# ---------------------------------------------------------------------------

def monthly_savings_estimate(
    base_net_monthly: float,
    confirmed_commission: float,
    included_bills: list[Bill],
    next_payday_nominal: date,
    today: date,
    one_time_expenses: list[OneTimeExpense],
    quicksilver_accrual: float,
    bills_for_reserve: list[Bill],
    variable_cap: float = VARIABLE_SPEND_CAP,
    month_length_days: float = MONTH_LENGTH_DAYS,
) -> float:
    """
    Estimated Monthly Savings — forward-looking cycle savings floor.

    Source: Dashboard!B62:
      =MAX(0, B56-B57-B58-B59-B60-B61)

    B56 = total_month_income = base_net + confirmed_commission
    B57 = full_month_fixed_bills = SUMIFS(Bills!B, Bills!F, TRUE)
    B58 = remaining_variable_prorated = ROUND(((B4-TODAY())/B4_assumptions)*B9, 2)
    B59 = known_one_time_all = SUM(B35:B39)
    B60 = quicksilver_accrual = B51 = B48
    B61 = forward_reserve = B33

    NOTE: included_bills (for B57) uses the Include=TRUE flag on the full
    month bill list. bills_for_reserve (for B61/forward_reserve) should be
    the same list — they may differ only in test fixtures.

    Source: Dashboard!B56–B62 / Playbook §2.1 / BUILD_SPEC §5.4 / FIX_PLAN §B3
    """
    # B56
    total_month_income = base_net_monthly + confirmed_commission

    # B57 — SUMIFS(Bills!B, Bills!F, TRUE) — all Include=TRUE regardless of cycle position
    full_month_fixed = sum(b.amount for b in included_bills if b.include)

    # B58 — days_to_payday / 30.4 × variable_cap, ROUND to 2 decimal places
    days_to_payday = (effective_payday(next_payday_nominal) - today).days
    remaining_variable_prorated = round(
        max(0.0, (days_to_payday / month_length_days) * variable_cap), 2
    )

    # B59 — SUM of all expense amounts (with or without due date, unpaid)
    known_one_time = known_one_time_all(one_time_expenses)

    # B60 = B51 = B48 (QuickSilver accrual)
    qs_accrual = quicksilver_accrual

    # B61 = B33
    fwd_reserve = forward_reserve(bills_for_reserve, variable_cap, month_length_days)

    result = (
        total_month_income
        - full_month_fixed
        - remaining_variable_prorated
        - known_one_time
        - qs_accrual
        - fwd_reserve
    )
    return max(0.0, result)


def discretionary_this_month(
    checking_balance: float,
    unpaid_fixed_bills_remaining_this_month: float,
    unpaid_one_time_expenses_remaining_this_month: float,
    quicksilver_accrual_not_yet_posted: float,
    bills_for_reserve: list[Bill],
    today: date,
    variable_cap: float = VARIABLE_SPEND_CAP,
    month_length_days: float = MONTH_LENGTH_DAYS,
) -> float:
    """
    Discretionary This Month — end-of-month deployable surplus from current
    checking, after funding every known outflow between today and the first
    paycheck of the following month.

    Answers: "How much cash can I save, invest, or spend on non-obligated
              purchases this month after every known obligation is funded?"

    Distinct from safe_to_spend (current-cycle spending authority — no
    forward reserve, paycheck-bounded) and from monthly_savings_estimate
    (full-month income/outflow ledger, paycheck-boundary). Discretionary is
    checking-only and explicitly subtracts forward_reserve per Playbook §2.1.

    Formula:
      MAX(0,
        checking
        - unpaid_fixed_bills_remaining_this_month
        - prorated_variable_remaining_this_month
        - unpaid_one_time_expenses_remaining_this_month
        - quicksilver_accrual_not_yet_posted
        - forward_reserve(bills_for_reserve)
      )

      prorated_variable = days_remaining_in_month * (variable_cap / month_length_days)
        where days_remaining_in_month = (last_day_of_month - today.day + 1),
        inclusive of today and inclusive of the last day.

    Source: Playbook §2.1 (Forward Reserve Rule) / Cycle Dashboard headline.
    """
    last_day = calendar.monthrange(today.year, today.month)[1]
    days_remaining = max(0, last_day - today.day + 1)
    prorated_variable_remaining = days_remaining * (variable_cap / month_length_days)
    fwd_reserve = forward_reserve(bills_for_reserve, variable_cap, month_length_days)
    result = (
        checking_balance
        - unpaid_fixed_bills_remaining_this_month
        - prorated_variable_remaining
        - unpaid_one_time_expenses_remaining_this_month
        - quicksilver_accrual_not_yet_posted
        - fwd_reserve
    )
    return max(0.0, result)


# ---------------------------------------------------------------------------
# 8. 401(K) MATCH GAP  (FIX_PLAN §A2 — corrected formula)
# ---------------------------------------------------------------------------

@dataclass
class MatchGapResult:
    effective_employee_pct: float
    employer_match_pct: float
    max_possible_match_pct: float
    match_gap_pct: float
    annual_captured: float
    annual_available: float
    annual_gap: float
    monthly_gap: float
    at_ceiling: bool


def match_gap_analysis(
    gross_salary: float = GROSS_SALARY,
    contribution_pct: float = K401_CONTRIBUTION_PCT,
    match_multiplier: float = K401_MATCH_MULTIPLIER,
    employee_ceiling: float = K401_EMPLOYEE_CEILING,
) -> MatchGapResult:
    """
    401(k) match gap using the CORRECTED formula from FIX_PLAN §A2.

    The old workbook formula (Retirement Planning!B21) used match_rate/match_cap
    from B7/B8 — that schema is REPLACED by the corrected multiplier/ceiling model.

    FIX_PLAN §A2 verified values (gross $54,000, contribution 4%, multiplier 0.50,
    ceiling 0.08):
      effective_employee_pct = 0.04
      employer_match_pct     = 0.04 × 0.50 = 0.02 (2% of gross)
      max_possible           = 0.08 × 0.50 = 0.04 (4% of gross)
      match_gap              = 0.02
      annual_captured        = 54000 × 0.02 = $1,080/yr
      annual_available       = 54000 × 0.04 = $2,160/yr
      annual_gap             = $1,080/yr
      monthly_gap            = $90/mo

    Source: FIX_PLAN §A2 (overrides Retirement Planning!B21/B22)
    """
    effective_employee = min(contribution_pct, employee_ceiling)
    employer_match_pct = effective_employee * match_multiplier
    max_possible_match = employee_ceiling * match_multiplier
    match_gap_pct = max_possible_match - employer_match_pct

    annual_captured = gross_salary * employer_match_pct
    annual_available = gross_salary * max_possible_match
    annual_gap = annual_available - annual_captured
    monthly_gap = annual_gap / 12.0

    return MatchGapResult(
        effective_employee_pct=effective_employee,
        employer_match_pct=employer_match_pct,
        max_possible_match_pct=max_possible_match,
        match_gap_pct=match_gap_pct,
        annual_captured=annual_captured,
        annual_available=annual_available,
        annual_gap=annual_gap,
        monthly_gap=monthly_gap,
        at_ceiling=(contribution_pct >= employee_ceiling),
    )


# ---------------------------------------------------------------------------
# 9. SESSION INTEGRITY CHECK  (Assumptions D20:D29 → D31)
# ---------------------------------------------------------------------------

@dataclass
class SessionIntegrityReport:
    checks: list[IntegrityCheckResult]
    overall_pass: bool
    fail_count: int

    @property
    def status_text(self) -> str:
        if self.overall_pass:
            return "✅ ALL 10 CHECKS PASS"
        return f"❌ {self.fail_count} CHECK(S) FAILED"


def session_integrity_check(
    base_net_monthly: float,
    next_payday_nominal: date,
    today: date,
    last_balance_update: date,
    bills: list[Bill],
    forward_reserve_amount: float,
    commission_tax_rate: float,
    variable_spend_cap: float,
    monthly_savings: float,
    match_gap_result: Optional[MatchGapResult],
) -> SessionIntegrityReport:
    """
    10-point session integrity check. Any failure = investigate before proceeding.

    Translates Assumptions!D20:D29 formula checks to meaningful runtime assertions.
    The exact Excel checks (ISFORMULA, specific cell values) are replaced with
    equivalent semantic checks valid in the application context.

    Source: Assumptions!D20:D29, D31 / Playbook §1.3 / BUILD_SPEC §4.9
    """
    checks: list[IntegrityCheckResult] = []

    # 1. Base net income is set and > 0  (was: D20 Dashboard!B15=B11)
    checks.append(IntegrityCheckResult(
        check_number=1,
        description="Base net income set and positive",
        passed=base_net_monthly > 0,
        detail=f"base_net_monthly={base_net_monthly}",
    ))

    # 2. Next payday is in the future  (was: D21 Dashboard!B22 is formula)
    effective = effective_payday(next_payday_nominal)
    checks.append(IntegrityCheckResult(
        check_number=2,
        description="Next effective payday is in the future",
        passed=effective > today,
        detail=f"effective_payday={effective}, today={today}",
    ))

    # 3. Last balance update ≤ 3 days old  (was: D22 Dashboard!B54 is formula)
    staleness = days_since_update(last_balance_update, today)
    checks.append(IntegrityCheckResult(
        check_number=3,
        description=f"Balance update ≤ {STALENESS_WARN_DAYS} days old",
        passed=staleness <= STALENESS_WARN_DAYS,
        detail=f"days_since_update={staleness}",
    ))

    # 4. At least one bill has Include=TRUE  (was: D23 Bills!D2 is formula)
    has_active_bill = any(b.include for b in bills)
    checks.append(IntegrityCheckResult(
        check_number=4,
        description="At least one bill is Include=TRUE",
        passed=has_active_bill,
        detail=f"active_bills={sum(1 for b in bills if b.include)}",
    ))

    # 5. Forward reserve computes non-negative  (was: D24 Bills!F6=FALSE)
    checks.append(IntegrityCheckResult(
        check_number=5,
        description="Forward reserve is non-negative",
        passed=forward_reserve_amount >= 0,
        detail=f"forward_reserve={forward_reserve_amount:.2f}",
    ))

    # 6. Commission tax rate is set  (was: D25 Claude Sub row check)
    checks.append(IntegrityCheckResult(
        check_number=6,
        description="Commission tax rate is configured",
        passed=0 < commission_tax_rate < 1,
        detail=f"commission_tax_rate={commission_tax_rate}",
    ))

    # 7. Variable spend cap is set  (was: D26 Dashboard!B33 is formula)
    checks.append(IntegrityCheckResult(
        check_number=7,
        description="Variable spend cap is configured",
        passed=variable_spend_cap > 0,
        detail=f"variable_spend_cap={variable_spend_cap}",
    ))

    # 8. Monthly savings is a valid number  (was: D27 Assumptions!B8=400)
    savings_valid = (
        monthly_savings is not None
        and not math.isnan(monthly_savings)
        and not math.isinf(monthly_savings)
    )
    checks.append(IntegrityCheckResult(
        check_number=8,
        description="Monthly savings estimate is a valid number",
        passed=savings_valid,
        detail=f"monthly_savings={monthly_savings}",
    ))

    # 9. 401(k) match gap calculation returns a number  (was: D28 Dashboard!B62 is formula)
    checks.append(IntegrityCheckResult(
        check_number=9,
        description="401(k) match gap computed successfully",
        passed=match_gap_result is not None and not math.isnan(match_gap_result.annual_gap),
        detail=f"annual_gap={match_gap_result.annual_gap if match_gap_result else 'None'}",
    ))

    # 10. No bill has a negative amount  (was: D29 WM!B16 is formula)
    no_negative_bills = all(b.amount >= 0 for b in bills)
    checks.append(IntegrityCheckResult(
        check_number=10,
        description="No bill has a negative amount",
        passed=no_negative_bills,
        detail=f"negative_bills={[b.name for b in bills if b.amount < 0]}",
    ))

    fail_count = sum(1 for c in checks if not c.passed)
    return SessionIntegrityReport(
        checks=checks,
        overall_pass=(fail_count == 0),
        fail_count=fail_count,
    )


# ---------------------------------------------------------------------------
# 10. FORWARD PROJECTION  (2-cycle cash flow)
# ---------------------------------------------------------------------------

@dataclass
class ProjectionCycle:
    cycle_label: str
    payday_date: date
    base_income: float
    expected_commission: float
    total_income: float
    fixed_bills: float
    variable_estimate: float
    forward_reserve_out: float
    estimated_savings: float
    projected_checking: float


def forward_projection(
    current_checking: float,
    current_monthly_savings: float,
    bills: list[Bill],
    today: date,
    next_payday_nominal: date,
    commissions: list[CommissionRow],
    base_net_monthly: float = BASE_NET_INCOME,
    variable_cap: float = VARIABLE_SPEND_CAP,
    month_length_days: float = MONTH_LENGTH_DAYS,
    mrr_target: float = MRR_TARGET,
    nrr_target: float = NRR_TARGET,
    tax_rate: float = COMMISSION_TAX_RATE,
    payout_day: int = COMMISSION_PAYOUT_DAY,
    cycles: int = 2,
) -> list[ProjectionCycle]:
    """
    Multi-cycle forward cash flow projection.

    Projects the next `cycles` paychecks, computing expected savings each cycle.
    Commission is only included if a payout row exists for that month.
    Base pay is the floor (commission-as-zero rule for planning).

    Source: BUILD_SPEC §5.2 (computed values), workbook architecture notes
    (3-cycle projection rows 80-84), FIX_PLAN §B3 methodology.
    """
    result: list[ProjectionCycle] = []
    # Build payday sequence
    paydays = [effective_payday(next_payday_nominal)]
    nominal = next_payday_nominal
    for _ in range(cycles - 1):
        # Advance to next payday
        if nominal.day == 7:
            nominal = nominal.replace(day=22)
        else:
            if nominal.month == 12:
                nominal = date(nominal.year + 1, 1, 7)
            else:
                nominal = date(nominal.year, nominal.month + 1, 7)
        paydays.append(effective_payday(nominal))

    running_checking = current_checking

    for i, payday in enumerate(paydays):
        label = f"Cycle {i+1}: payday {payday.isoformat()}"

        # Commission confirmed for this month?
        target_payout = date(payday.year, payday.month, payout_day)
        expected_commission = 0.0
        for row in commissions:
            pd = commission_payout_date(row.sales_month, payout_day)
            if pd == target_payout and pd <= payday:
                expected_commission = commission_take_home(
                    row.mrr_achieved, row.nrr_achieved,
                    mrr_target, nrr_target, tax_rate
                )

        total_income = base_net_monthly / 2.0 + expected_commission  # semi-monthly base
        fixed_half = sum(b.amount for b in bills if b.include) / 2.0
        variable_est = variable_cap / 2.0
        fwd_res = forward_reserve(bills, variable_cap, month_length_days)

        est_savings = max(0.0, total_income - fixed_half - variable_est)
        running_checking = running_checking + total_income - fixed_half - variable_est

        result.append(ProjectionCycle(
            cycle_label=label,
            payday_date=payday,
            base_income=base_net_monthly / 2.0,
            expected_commission=expected_commission,
            total_income=total_income,
            fixed_bills=fixed_half,
            variable_estimate=variable_est,
            forward_reserve_out=fwd_res,
            estimated_savings=est_savings,
            projected_checking=running_checking,
        ))

    return result


# ---------------------------------------------------------------------------
# 11. DECISION SANDBOX
# ---------------------------------------------------------------------------

@dataclass
class PurchaseComparisonResult:
    name: str
    monthly_payment: float
    total_monthly_cost: float
    daily_lifestyle_cost: float
    new_daily_safe_spend: float
    annual_cost: float
    total_interest_with_opportunity_cost: float
    hysa_after_down: float
    hysa_runway_months: float
    affordability: str           # "✅ Yes" | "⚠️ Tight" | "❌ No"
    income_coverage_pct: float


def decision_sandbox_compare(
    options: list[PurchaseOption],
    current_daily_safe_spend: float,
    monthly_fixed_bills: float,
    variable_cap: float,
    base_net_monthly: float,
    hysa_balance: float,
    return_assumption: float = RETIREMENT_RETURN,
    opportunity_cost_months: int = 120,
) -> list[PurchaseComparisonResult]:
    """
    Purchase comparison across up to 4 options.

    Replicates Decision Sandbox B21:E30.

    PMT formula (B21): =IF(OR(rate=0,term=0), 0, PMT(rate/12, term, -(price-down)))
    Total monthly (B22): monthly_payment + add_ons
    Daily lifestyle (B23): total_monthly / 30.4
    New daily safe spend (B24): current_daily - daily_lifestyle
    Annual cost (B25): total_monthly * 12
    Total interest (B26): (pmt * term - financed) + FV(return/12, 120, 0, -down)
      — FV term is the opportunity cost of the down payment over 120 months
    HYSA after (B27): hysa - down_payment
    HYSA runway (B28): ROUND(hysa_after / total_monthly, 1)
    Affordability (B29): base_net - (fixed + total_monthly) vs variable_cap
    Income coverage % (B30): annual_cost / (base_net * 12)

    Source: Decision Sandbox!B21:E30 / BUILD_SPEC §6.1 item 7
    """
    results: list[PurchaseComparisonResult] = []

    for opt in options:
        financed = opt.total_price - opt.down_payment
        if opt.annual_rate > 0 and opt.term_months > 0:
            monthly_payment = pmt(opt.annual_rate, opt.term_months, financed)
        else:
            monthly_payment = 0.0

        total_monthly = monthly_payment + opt.monthly_addons
        daily_lifestyle = total_monthly / 30.4
        new_daily_safe = current_daily_safe_spend - daily_lifestyle

        if opt.total_price > 0 and opt.term_months > 0:
            annual_cost = total_monthly * 12
        else:
            annual_cost = opt.one_time_cost

        # Interest = actual interest + opportunity cost of down payment
        actual_interest = (monthly_payment * opt.term_months - financed) if opt.term_months > 0 else 0.0
        opp_cost = 0.0
        if opt.down_payment > 0:
            opp_cost = fv(return_assumption / 12, opportunity_cost_months, 0.0, opt.down_payment) - opt.down_payment
        total_interest = actual_interest + opp_cost

        hysa_after = hysa_balance - opt.down_payment
        hysa_runway = round(hysa_after / total_monthly, 1) if total_monthly > 0 else float('inf')

        residual = base_net_monthly - (monthly_fixed_bills + total_monthly)
        if residual > variable_cap:
            affordability = "✅ Yes"
        elif residual > 0:
            affordability = "⚠️ Tight"
        else:
            affordability = "❌ No"

        income_pct = annual_cost / (base_net_monthly * 12) if base_net_monthly > 0 else 0.0

        results.append(PurchaseComparisonResult(
            name=opt.name,
            monthly_payment=monthly_payment,
            total_monthly_cost=total_monthly,
            daily_lifestyle_cost=daily_lifestyle,
            new_daily_safe_spend=new_daily_safe,
            annual_cost=annual_cost,
            total_interest_with_opportunity_cost=total_interest,
            hysa_after_down=hysa_after,
            hysa_runway_months=hysa_runway,
            affordability=affordability,
            income_coverage_pct=income_pct,
        ))

    return results


def income_replacement_floor(
    monthly_savings_target: float,
    monthly_fixed_bills: float,
    variable_cap: float,
    total_tax_rate: float,
) -> tuple[float, float]:
    """
    Minimum base salary (annual and monthly gross) to maintain the savings
    floor at $0 commission.

    Source: Decision Sandbox!B53:
      =(B50*12)/(1-B51)
      where B50 = savings_target + fixed_bills + variable_cap
            B51 = fed_rate + state_rate

    Returns: (annual_floor, monthly_floor)
    """
    min_monthly_net = monthly_savings_target + monthly_fixed_bills + variable_cap
    annual_floor = (min_monthly_net * 12) / (1.0 - total_tax_rate)
    return annual_floor, annual_floor / 12.0


def drought_survival_runway(
    checking_balance: float,
    hysa_balance: float,
    monthly_fixed_bills: float,
    variable_cap: float,
    base_net_monthly: float,
) -> dict:
    """
    Zero-commission runway calculation.

    Source: Decision Sandbox!B33:B43

    Returns dict with: total_liquid, total_burn, monthly_deficit, runway_months,
    indefinite (bool), monthly_surplus_if_no_deficit.
    """
    total_liquid = checking_balance + hysa_balance
    total_burn = monthly_fixed_bills + variable_cap
    monthly_deficit = max(0.0, total_burn - base_net_monthly)
    monthly_surplus = max(0.0, base_net_monthly - total_burn)

    if monthly_deficit <= 0:
        runway_months = None  # indefinite
        indefinite = True
    else:
        runway_months = round(total_liquid / monthly_deficit, 1)
        indefinite = False

    return {
        "total_liquid": total_liquid,
        "total_burn": total_burn,
        "monthly_deficit": monthly_deficit,
        "monthly_surplus": monthly_surplus,
        "runway_months": runway_months,
        "indefinite": indefinite,
    }


# ---------------------------------------------------------------------------
# 12. TAX PLANNING  (Assumptions B35:B41)
# ---------------------------------------------------------------------------

def tax_reserve_per_paycheck(
    gross_annual: float = GROSS_SALARY,
    fed_rate: float = FED_TAX_RATE,
    state_rate: float = STATE_TAX_RATE,
    pay_periods: int = PAY_PERIODS_PER_YEAR,
) -> tuple[float, float]:
    """
    Tax reserve amounts — per paycheck and per month.

    Source: Assumptions!B38: =B35*(B36+B37)
            Assumptions!B40: =B38/B39
            Assumptions!B41: =B38/12

    Returns: (per_paycheck, per_month)
    """
    annual_liability = gross_annual * (fed_rate + state_rate)
    per_paycheck = annual_liability / pay_periods
    per_month = annual_liability / 12.0
    return per_paycheck, per_month


# ---------------------------------------------------------------------------
# 13. INCOME GROWTH SCENARIO  (Assumptions B53:B60)
# ---------------------------------------------------------------------------

def income_growth_scenario(
    current_base_salary: float = GROSS_SALARY,
    new_base_salary: float = 65000.0,
    fed_rate: float = FED_TAX_RATE,
    state_rate: float = STATE_TAX_RATE,
    base_net_monthly: float = BASE_NET_INCOME,
    monthly_fixed_bills: float = 0.0,
) -> dict:
    """
    Raise impact modeling — how a salary change flows to savings.

    Source: Assumptions!B56:B60:
      B56 = (new - current) * (1 - fed - state) / 12
      B57 = Dashboard!B54 + B56
      B58 = Dashboard!B57
      B59 = B57 - B58
      B60 = B56

    Returns dict with all intermediate values.
    """
    monthly_net_increase = (new_base_salary - current_base_salary) * (1 - fed_rate - state_rate) / 12.0
    new_monthly_net = base_net_monthly + monthly_net_increase
    new_savings_floor = new_monthly_net - monthly_fixed_bills
    savings_floor_improvement = monthly_net_increase  # B60 = B56

    return {
        "current_base_salary": current_base_salary,
        "new_base_salary": new_base_salary,
        "monthly_net_increase": monthly_net_increase,
        "new_monthly_net": new_monthly_net,
        "current_fixed_bills": monthly_fixed_bills,
        "new_savings_floor": new_savings_floor,
        "savings_floor_improvement": savings_floor_improvement,
    }


# ---------------------------------------------------------------------------
# 14. DEBT STRATEGY  (Debt Strategy sheet)
# ---------------------------------------------------------------------------

@dataclass
class DebtAnalysis:
    standard_monthly: float
    standard_total_paid: float
    standard_total_interest: float
    extended_monthly: float
    extended_total_paid: float
    extended_total_interest: float
    extra_interest_extended_vs_standard: float
    # Accelerated scenarios
    payoff_3yr_monthly: float
    payoff_3yr_total_interest: float
    payoff_3yr_interest_saved: float
    payoff_5yr_monthly: float
    payoff_5yr_total_interest: float
    payoff_5yr_interest_saved: float
    payoff_7yr_monthly: float
    payoff_7yr_total_interest: float
    payoff_7yr_interest_saved: float
    # Break-even
    invest_fv_3yr_extra: float
    invest_verdict: str
    invest_dollar_advantage: float


def debt_payoff_analysis(
    balance: float,
    annual_rate: float,
    standard_term_years: int = 10,
    extended_term_years: int = 25,
    return_assumption: float = RETIREMENT_RETURN,
) -> DebtAnalysis:
    """
    Student loan debt strategy analysis.

    Source: Debt Strategy sheet (B6:B54)

    Standard: PMT(rate/12, 10*12, -balance)
    Extended: PMT(rate/12, 25*12, -balance)
    Accelerated: 3yr, 5yr, 7yr PMT calculations
    Break-even: FV of investing (3yr payment - standard payment) × 10 years at 7%

    Source: Debt Strategy!B19–B50 / BUILD_SPEC §6.1 item 5
    """
    r12 = annual_rate / 12

    # Standard
    std_monthly = pmt(annual_rate, standard_term_years * 12, balance)
    std_total = std_monthly * standard_term_years * 12
    std_interest = std_total - balance

    # Extended
    ext_monthly = pmt(annual_rate, extended_term_years * 12, balance)
    ext_total = ext_monthly * extended_term_years * 12
    ext_interest = ext_total - balance
    extra_interest = ext_interest - std_interest

    # Accelerated 3yr
    m3 = pmt(annual_rate, 36, balance)
    interest_3yr = (m3 * 36) - balance
    saved_3yr = std_interest - interest_3yr

    # Accelerated 5yr
    m5 = pmt(annual_rate, 60, balance)
    interest_5yr = (m5 * 60) - balance
    saved_5yr = std_interest - interest_5yr

    # Accelerated 7yr
    m7 = pmt(annual_rate, 84, balance)
    interest_7yr = (m7 * 84) - balance
    saved_7yr = std_interest - interest_7yr

    # Break-even: invest (3yr_payment - standard_payment) for 10 years at return_assumption
    # vs interest saved by 3yr payoff
    extra_monthly_payment = m3 - std_monthly
    invest_fv = fv_annual(return_assumption / 12, 120, extra_monthly_payment, 0.0)
    dollar_advantage = invest_fv - saved_3yr
    verdict = "INVEST the difference" if invest_fv > saved_3yr else "PAY AGGRESSIVELY"

    return DebtAnalysis(
        standard_monthly=std_monthly,
        standard_total_paid=std_total,
        standard_total_interest=std_interest,
        extended_monthly=ext_monthly,
        extended_total_paid=ext_total,
        extended_total_interest=ext_interest,
        extra_interest_extended_vs_standard=extra_interest,
        payoff_3yr_monthly=m3,
        payoff_3yr_total_interest=interest_3yr,
        payoff_3yr_interest_saved=saved_3yr,
        payoff_5yr_monthly=m5,
        payoff_5yr_total_interest=interest_5yr,
        payoff_5yr_interest_saved=saved_5yr,
        payoff_7yr_monthly=m7,
        payoff_7yr_total_interest=interest_7yr,
        payoff_7yr_interest_saved=saved_7yr,
        invest_fv_3yr_extra=invest_fv,
        invest_verdict=verdict,
        invest_dollar_advantage=abs(dollar_advantage),
    )


# ---------------------------------------------------------------------------
# 15. RETIREMENT PLANNING  (Retirement Planning sheet)
# ---------------------------------------------------------------------------

@dataclass
class RetirementProjection:
    years_to_retirement: int
    annual_contribution: float
    monthly_contribution: float
    employer_match_captured: float
    max_employer_match: float
    total_annual_going_in: float
    projected_at_60: float
    projected_at_65: float
    # At match cap
    at_cap_projected_60: float
    at_cap_projected_65: float
    # Aggressive (12%)
    aggressive_projected_60: float
    aggressive_projected_65: float
    match_gap_banner: str
    million_monthly_needed: float


def retirement_projection(
    gross_salary: float = GROSS_SALARY,
    contribution_pct: float = K401_CONTRIBUTION_PCT,
    current_balance: float = 2200.0,
    current_age: int = 30,
    target_age: int = 65,
    return_assumption: float = RETIREMENT_RETURN,
    match_multiplier: float = K401_MATCH_MULTIPLIER,
    employee_ceiling: float = K401_EMPLOYEE_CEILING,
) -> RetirementProjection:
    """
    401(k) projections at three contribution rates.

    Source: Retirement Planning!B35:B40 and FIX_PLAN §A2 for match formula.

    NOTE: The match formula uses the CORRECTED multiplier/ceiling model,
    not the old B7/B8 rate/cap model from the workbook.

    Projection formula (Retirement Planning!B36):
      =FV(B12, B16, -B19-B21, -B9)
    where B12=return, B16=years_to_retirement, B19=employee_annual, B21=match_captured,
          B9=current_balance.
    FV called with annual periods and annual payment (employee + match combined).
    """
    years = target_age - current_age

    # Current
    emp_annual = gross_salary * contribution_pct
    match_gap = match_gap_analysis(gross_salary, contribution_pct, match_multiplier, employee_ceiling)
    match_captured = match_gap.annual_captured
    total_annual = emp_annual + match_captured

    proj_60 = fv_annual(return_assumption, 60 - current_age, total_annual, current_balance)
    proj_65 = fv_annual(return_assumption, years, total_annual, current_balance)

    # At match cap (employee contributes employee_ceiling)
    cap_emp_annual = gross_salary * employee_ceiling
    cap_match = match_gap_analysis(gross_salary, employee_ceiling, match_multiplier, employee_ceiling)
    cap_total = cap_emp_annual + cap_match.annual_captured
    cap_60 = fv_annual(return_assumption, 60 - current_age, cap_total, current_balance)
    cap_65 = fv_annual(return_assumption, years, cap_total, current_balance)

    # Aggressive (12%)
    agg_pct = 0.12
    agg_emp = gross_salary * agg_pct
    agg_match = match_gap_analysis(gross_salary, agg_pct, match_multiplier, employee_ceiling)
    agg_total = agg_emp + agg_match.annual_captured
    agg_60 = fv_annual(return_assumption, 60 - current_age, agg_total, current_balance)
    agg_65 = fv_annual(return_assumption, years, agg_total, current_balance)

    # Match gap banner
    if match_gap.at_ceiling:
        banner = "✅ Full match captured"
    else:
        monthly_gap = match_gap.monthly_gap
        annual_gap = match_gap.annual_gap
        banner = (
            f"⚠️ Contributing {contribution_pct*100:.1f}% vs "
            f"{employee_ceiling*100:.1f}% employee contribution ceiling. "
            f"${annual_gap:,.2f}/year (${monthly_gap:,.2f}/mo) in free employer match uncaptured."
        )

    # $1M target: monthly contribution needed to reach $1M at 65 with current balance
    # Solve: FV(r_monthly, years*12, pmt, current_balance) = 1,000,000
    # Using pmt formula rearranged: pmt = (FV - PV*(1+r)^n) * r / ((1+r)^n - 1)
    r_m = return_assumption / 12
    n_m = years * 12
    growth = (1 + r_m) ** n_m
    # 1M = current_balance*growth + pmt*(growth-1)/r_m
    # pmt = (1M - current_balance*growth) * r_m / (growth - 1)
    million_monthly = (1_000_000 - current_balance * growth) * r_m / (growth - 1)
    million_monthly = max(0.0, million_monthly)

    return RetirementProjection(
        years_to_retirement=years,
        annual_contribution=emp_annual,
        monthly_contribution=emp_annual / 24,  # semi-monthly paycheck deduction
        employer_match_captured=match_captured,
        max_employer_match=match_gap.annual_available,
        total_annual_going_in=total_annual,
        projected_at_60=proj_60,
        projected_at_65=proj_65,
        at_cap_projected_60=cap_60,
        at_cap_projected_65=cap_65,
        aggressive_projected_60=agg_60,
        aggressive_projected_65=agg_65,
        match_gap_banner=banner,
        million_monthly_needed=million_monthly,
    )


# ---------------------------------------------------------------------------
# 16. WEALTH MANAGEMENT OUTPUTS
# ---------------------------------------------------------------------------

def hysa_gap(current: float, target: float = HYSA_TARGET) -> float:
    """
    HYSA gap to target. Negative = surplus beyond target.
    Source: Wealth Management HYSA Gap Tracker
    """
    return target - current


def months_to_close_hysa_gap(
    gap: float,
    monthly_savings: float,
    savings_to_hysa_ratio: float = SAVINGS_TO_HYSA_RATIO,
) -> Optional[float]:
    """
    Months to close HYSA gap assuming savings_to_hysa_ratio of savings go to HYSA.

    Source: Wealth Management: gap / (Dashboard!B62 * Assumptions!B14)
    Returns None if gap is 0 or negative (already at target).
    """
    if gap <= 0:
        return None
    allocated = monthly_savings * savings_to_hysa_ratio
    if allocated <= 0:
        return None
    return gap / allocated


def savings_rate(monthly_savings: float, gross_monthly: float) -> float:
    """
    Savings rate as fraction of gross monthly income.

    Source: Wealth Management Savings Rate Tracker:
      =B62 / (Assumptions!B35/12)
    Target: 0.20 (20%)
    """
    if gross_monthly <= 0:
        return 0.0
    return monthly_savings / gross_monthly


def net_worth_projection(
    current_net_worth: float,
    monthly_savings_floor: float,
    current_age: int = 30,
    target_ages: tuple[int, ...] = (35, 40, 45),
    return_assumption: float = RETIREMENT_RETURN,
) -> dict[int, float]:
    """
    Net worth FV at target ages.

    Source: Wealth Management Net Worth Projection:
      =FV(return, years, -monthly_savings*12, -current_net_worth)
    """
    results: dict[int, float] = {}
    for age in target_ages:
        years = age - current_age
        if years <= 0:
            results[age] = current_net_worth
        else:
            annual_savings = monthly_savings_floor * 12
            results[age] = fv_annual(return_assumption, years, annual_savings, current_net_worth)
    return results


# ---------------------------------------------------------------------------
# 17. STALENESS CHECK  (Dashboard B8 / Playbook §6.4)
# ---------------------------------------------------------------------------

def is_stale(last_balance_update: date, today: date, warn_days: int = STALENESS_WARN_DAYS) -> bool:
    """
    True if checking balance is more than warn_days old.
    Source: Dashboard!B8 / BUILD_SPEC §4.8 / Playbook §6.4
    """
    return days_since_update(last_balance_update, today) > warn_days


def payday_risk_flag(next_payday_nominal: date) -> bool:
    """
    True if nominal payday falls on a weekend.
    Source: Dashboard!B26: =IF(WEEKDAY($B$4,2)>=6,"WEEKEND PAYDAY RISK","")
    """
    return next_payday_nominal.weekday() >= 5  # Saturday=5, Sunday=6


# ---------------------------------------------------------------------------
# 18. VARIABLE SPEND PRORATION HELPER
# ---------------------------------------------------------------------------

def variable_daily_rate(
    variable_cap: float = VARIABLE_SPEND_CAP,
    month_length_days: float = MONTH_LENGTH_DAYS,
) -> float:
    """
    Daily variable spend allowance.
    Source: Playbook §2.2: $600 / 30.4 = $19.74/day
    """
    return variable_cap / month_length_days


def variable_prorated(
    days: int,
    variable_cap: float = VARIABLE_SPEND_CAP,
    month_length_days: float = MONTH_LENGTH_DAYS,
) -> float:
    """
    Variable spend for a given number of days (e.g., 7 days of forward reserve).
    Source: Dashboard!B33 numerator: 7*(Assumptions!B9/Assumptions!B4)
    """
    return days * (variable_cap / month_length_days)
