/**
 * payCadence.ts — cadence-aware pay schedule generator (pure, no I/O).
 * ===================================================================
 * Generalizes the hardcoded semi-monthly (7th/22nd) payday schedule so the
 * engine can model weekly / biweekly / semimonthly / monthly income from a
 * single anchor date + cadence + weekend-shift rule. PURE functions only —
 * no DB, no clock — so they unit-test in isolation and can be wired into the
 * adapter (financeEngine.ts) in a later commit without touching the sealed
 * engine (lib/finance/engine.ts).
 *
 * All dates are handled at UTC midnight, matching the engine/adapter
 * convention (utcStartOfDay / @workspace/finance `d()`), NOT the route layer's
 * local `ymd()`. Reconciling that local/UTC split is a separate (rollover)
 * commit; this module is deliberately UTC-only.
 *
 * BACK-COMPAT CONTRACT: with cadence="semimonthly", an anchor whose day-of-
 * month is 7, and shift="prior_business_day", `nextPayDate` reproduces the
 * legacy `deriveNextPayday` exactly (earliest of {7th, 22nd} on-or-after
 * today, weekend-adjusted to the prior Friday). See payCadence.test.ts.
 */

export type PayCadence = "weekly" | "biweekly" | "semimonthly" | "monthly";
export type WeekendShift = "prior_business_day" | "next_business_day" | "none";

const MS_DAY = 86_400_000;

/**
 * Legacy default anchor: a date whose UTC day-of-month is 7, so semimonthly
 * derives [7th, 22nd] — reproducing the pre-cadence schedule. Only the
 * day-of-month matters for semimonthly/monthly; the year/month are irrelevant.
 */
export const LEGACY_SEMIMONTHLY_ANCHOR = new Date(Date.UTC(2020, 0, 7));

/** Parse a "YYYY-MM-DD" anchor string to a UTC-midnight Date; null if invalid. */
export function parseAnchorDate(raw: string | null | undefined): Date | null {
  const s = (raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T00:00:00.000Z");
  return isNaN(d.getTime()) ? null : d;
}

const CADENCES: ReadonlySet<string> = new Set([
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
]);
const SHIFTS: ReadonlySet<string> = new Set([
  "prior_business_day",
  "next_business_day",
  "none",
]);

/** Coerce an arbitrary string to a PayCadence, defaulting to legacy semimonthly. */
export function normalizeCadence(raw: string | null | undefined): PayCadence {
  const s = (raw ?? "").trim();
  return (CADENCES.has(s) ? s : "semimonthly") as PayCadence;
}

/** Coerce an arbitrary string to a WeekendShift, defaulting to prior_business_day. */
export function normalizeWeekendShift(raw: string | null | undefined): WeekendShift {
  const s = (raw ?? "").trim();
  return (SHIFTS.has(s) ? s : "prior_business_day") as WeekendShift;
}

export interface PayCadenceConfig {
  cadence: PayCadence;
  anchor: Date;
  shift: WeekendShift;
}

/**
 * Resolve the pay-cadence config from an assumption getter, applying legacy
 * defaults for any unset/invalid key. `get` returns the raw assumption value
 * (or null/empty when absent) — abstracts over allAssumps (route layer) and
 * getAssumption (adapter layer). With every key unset this yields the legacy
 * semimonthly 7th/22nd, prior-business-day schedule.
 */
export function resolvePayCadenceConfig(
  get: (key: string) => string | null | undefined,
): PayCadenceConfig {
  return {
    cadence: normalizeCadence(get("pay_cadence")),
    anchor: parseAnchorDate(get("pay_anchor_date")) ?? LEGACY_SEMIMONTHLY_ANCHOR,
    shift: normalizeWeekendShift(get("pay_weekend_shift")),
  };
}

function utcMidnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * MS_DAY);
}

function utcDate(year: number, month0: number, day: number): Date {
  return new Date(Date.UTC(year, month0, day));
}

/** Last day-of-month for a UTC (year, month0). */
function daysInUtcMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Shift a deposit off a weekend per the rule. `prior_business_day` matches the
 * engine's `effectivePayday` exactly (Sat -> Fri, Sun -> Fri). Holidays are not
 * modeled (out of scope) — weekends only.
 */
export function applyWeekendShift(date: Date, shift: WeekendShift): Date {
  if (shift === "none") return date;
  const dow = date.getUTCDay(); // 0=Sun .. 6=Sat
  if (shift === "prior_business_day") {
    if (dow === 6) return addDays(date, -1); // Sat -> Fri
    if (dow === 0) return addDays(date, -2); // Sun -> Fri
    return date;
  }
  // next_business_day
  if (dow === 6) return addDays(date, 2); // Sat -> Mon
  if (dow === 0) return addDays(date, 1); // Sun -> Mon
  return date;
}

/**
 * The NOMINAL (pre-weekend-shift) deposit dates for a single calendar month.
 * - monthly: anchor's day-of-month, clamped to month length.
 * - semimonthly: two days — [anchorDay, anchorDay + 15], each clamped. An anchor
 *   on the 7th yields [7, 22], reproducing the legacy schedule. (Collapses to a
 *   single date if clamping makes the two coincide.)
 * weekly/biweekly are not month-bounded and are handled by the callers directly.
 */
function nominalMonthDates(
  cadence: PayCadence,
  anchorDay: number,
  year: number,
  month0: number,
): Date[] {
  const last = daysInUtcMonth(year, month0);
  if (cadence === "monthly") {
    return [utcDate(year, month0, Math.min(anchorDay, last))];
  }
  // semimonthly
  const d1 = Math.min(anchorDay, last);
  const d2 = Math.min(anchorDay + 15, last);
  return d2 > d1
    ? [utcDate(year, month0, d1), utcDate(year, month0, d2)]
    : [utcDate(year, month0, d1)];
}

/**
 * All deposit dates (UTC midnight, weekend-shifted) whose SHIFTED date falls in
 * [windowStart, windowEnd] inclusive.
 */
export function payDatesInWindow(
  cadence: PayCadence,
  anchorDate: Date,
  shift: WeekendShift,
  windowStart: Date,
  windowEnd: Date,
): Date[] {
  const ws = utcMidnight(windowStart);
  const we = utcMidnight(windowEnd);
  if (ws.getTime() > we.getTime()) return [];

  const anchor = utcMidnight(anchorDate);
  const inWindow = (d: Date) =>
    d.getTime() >= ws.getTime() && d.getTime() <= we.getTime();
  const found: Date[] = [];

  if (cadence === "weekly" || cadence === "biweekly") {
    const step = cadence === "weekly" ? 7 : 14;
    // Generate nominal dates a few days outside the window so a weekend shift
    // can still land a near-edge deposit inside it.
    const lo = addDays(ws, -4).getTime();
    const hi = addDays(we, 4).getTime();
    const stepMs = step * MS_DAY;
    const nLo = Math.ceil((lo - anchor.getTime()) / stepMs);
    const nHi = Math.floor((hi - anchor.getTime()) / stepMs);
    for (let n = nLo; n <= nHi; n++) {
      const dep = applyWeekendShift(addDays(anchor, n * step), shift);
      if (inWindow(dep)) found.push(dep);
    }
  } else {
    const anchorDay = anchor.getUTCDate();
    // Walk each month from one before the window start (to catch a day-1 deposit
    // shifted into the prior month, or vice versa) through the window end.
    const startM = addDays(ws, -4);
    const endM = addDays(we, 4);
    const startIdx = startM.getUTCFullYear() * 12 + startM.getUTCMonth();
    const endIdx = endM.getUTCFullYear() * 12 + endM.getUTCMonth();
    for (let idx = startIdx; idx <= endIdx; idx++) {
      const y = Math.floor(idx / 12);
      const m0 = idx % 12;
      for (const nominal of nominalMonthDates(cadence, anchorDay, y, m0)) {
        const dep = applyWeekendShift(nominal, shift);
        if (inWindow(dep)) found.push(dep);
      }
    }
  }

  found.sort((a, b) => a.getTime() - b.getTime());
  // Dedupe (weekend shifts can collapse two adjacent nominals onto one date).
  const out: Date[] = [];
  for (const d of found) {
    if (!out.length || out[out.length - 1]!.getTime() !== d.getTime()) out.push(d);
  }
  return out;
}

/**
 * The next deposit on-or-after `today`, weekend-shifted.
 *
 * Semantics match the legacy `deriveNextPayday`: the comparison is on the
 * NOMINAL date (inclusive — if today IS a nominal payday it is returned), and
 * the returned value is the weekend-shifted deposit date. This intentionally
 * preserves the existing two-layer behavior where the cycle layer
 * (computeRequiredHold) rolls forward when today === a nominal payday; the
 * "strictly after" rollover is that layer's job, not this generator's.
 */
export function nextPayDate(
  cadence: PayCadence,
  anchorDate: Date,
  shift: WeekendShift,
  today: Date,
): Date {
  const t = utcMidnight(today);
  const anchor = utcMidnight(anchorDate);

  if (cadence === "weekly" || cadence === "biweekly") {
    const step = cadence === "weekly" ? 7 : 14;
    const stepMs = step * MS_DAY;
    const n = Math.ceil((t.getTime() - anchor.getTime()) / stepMs);
    return applyWeekendShift(addDays(anchor, n * step), shift);
  }

  const anchorDay = anchor.getUTCDate();
  const baseIdx = t.getUTCFullYear() * 12 + t.getUTCMonth();
  // Scan forward up to 24 months — far beyond any real cadence gap.
  for (let i = 0; i < 24; i++) {
    const idx = baseIdx + i;
    const y = Math.floor(idx / 12);
    const m0 = idx % 12;
    for (const nominal of nominalMonthDates(cadence, anchorDay, y, m0)) {
      if (nominal.getTime() >= t.getTime()) return applyWeekendShift(nominal, shift);
    }
  }
  throw new Error("nextPayDate: no payday found within 24 months of today");
}
