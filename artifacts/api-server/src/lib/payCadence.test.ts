/**
 * payCadence.test.ts — unit tests for the pure cadence generator.
 * Pure module (no DB import) → no @workspace/db mock required.
 */
import { describe, it, expect } from "vitest";
import {
  applyWeekendShift,
  payDatesInWindow,
  nextPayDate,
  parseAnchorDate,
  normalizeCadence,
  normalizeWeekendShift,
  resolvePayCadenceConfig,
  LEGACY_SEMIMONTHLY_ANCHOR,
  type PayCadence,
  type WeekendShift,
} from "./payCadence";

const u = (s: string) => new Date(s + "T00:00:00.000Z");
const iso = (d: Date) => d.toISOString().split("T")[0];
const isoList = (ds: Date[]) => ds.map(iso);

describe("applyWeekendShift", () => {
  // 2026-06-13 = Sat, 2026-06-14 = Sun, 2026-06-12 = Fri, 2026-06-10 = Wed.
  it("prior_business_day moves Sat->Fri and Sun->Fri", () => {
    expect(iso(applyWeekendShift(u("2026-06-13"), "prior_business_day"))).toBe("2026-06-12");
    expect(iso(applyWeekendShift(u("2026-06-14"), "prior_business_day"))).toBe("2026-06-12");
  });
  it("next_business_day moves Sat->Mon and Sun->Mon", () => {
    expect(iso(applyWeekendShift(u("2026-06-13"), "next_business_day"))).toBe("2026-06-15");
    expect(iso(applyWeekendShift(u("2026-06-14"), "next_business_day"))).toBe("2026-06-15");
  });
  it("none leaves weekends untouched, and weekdays are never shifted", () => {
    expect(iso(applyWeekendShift(u("2026-06-13"), "none"))).toBe("2026-06-13");
    for (const shift of ["prior_business_day", "next_business_day", "none"] as WeekendShift[]) {
      expect(iso(applyWeekendShift(u("2026-06-10"), shift))).toBe("2026-06-10"); // Wed
    }
  });
});

describe("payDatesInWindow — weekly", () => {
  // Anchor: Wed 2026-06-10. Weekly Wednesdays never hit a weekend.
  const anchor = u("2026-06-10");
  it("lists every Wednesday in June (inclusive bounds)", () => {
    // June 2026 Wednesdays: 3, 10, 17, 24 (anchor is the 10th; 3rd = anchor−7).
    expect(isoList(payDatesInWindow("weekly", anchor, "prior_business_day", u("2026-06-01"), u("2026-06-30"))))
      .toEqual(["2026-06-03", "2026-06-10", "2026-06-17", "2026-06-24"]);
  });
  it("includes endpoints and works for windows before the anchor", () => {
    expect(isoList(payDatesInWindow("weekly", anchor, "none", u("2026-05-20"), u("2026-06-10"))))
      .toEqual(["2026-05-20", "2026-05-27", "2026-06-03", "2026-06-10"]);
  });
  it("a roughly-monthly window yields 4-5 weekly deposits (≈$3000 @ $692.31)", () => {
    const n = payDatesInWindow("weekly", anchor, "prior_business_day", u("2026-06-01"), u("2026-06-30")).length;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(5);
  });
});

describe("payDatesInWindow — biweekly", () => {
  const anchor = u("2026-06-10");
  it("steps 14 days from the anchor", () => {
    expect(isoList(payDatesInWindow("biweekly", anchor, "none", u("2026-06-01"), u("2026-07-31"))))
      .toEqual(["2026-06-10", "2026-06-24", "2026-07-08", "2026-07-22"]);
  });
});

describe("payDatesInWindow — semimonthly", () => {
  it("anchor on the 7th reproduces the legacy [7th, 22nd] schedule, weekend-shifted", () => {
    const anchor = u("2026-01-07"); // day-of-month 7
    // June: 7th = Sun -> Fri 5th; 22nd = Mon (no shift).
    expect(isoList(payDatesInWindow("semimonthly", anchor, "prior_business_day", u("2026-06-01"), u("2026-06-30"))))
      .toEqual(["2026-06-05", "2026-06-22"]);
    // With shift=none the nominal dates show through.
    expect(isoList(payDatesInWindow("semimonthly", anchor, "none", u("2026-06-01"), u("2026-06-30"))))
      .toEqual(["2026-06-07", "2026-06-22"]);
  });
  it("derives the second day as anchorDay + 15", () => {
    const anchor = u("2026-03-15"); // -> [15, 30]
    expect(isoList(payDatesInWindow("semimonthly", anchor, "none", u("2026-04-01"), u("2026-04-30"))))
      .toEqual(["2026-04-15", "2026-04-30"]);
  });
});

describe("payDatesInWindow — monthly", () => {
  it("one deposit per month on the anchor day, clamped to month length", () => {
    const anchor = u("2026-01-31"); // clamps to Feb 28
    expect(isoList(payDatesInWindow("monthly", anchor, "none", u("2026-01-01"), u("2026-03-31"))))
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });
});

describe("nextPayDate — back-compat with legacy deriveNextPayday", () => {
  // Legacy = semimonthly, anchor day 7, prior_business_day. These six values
  // are the EXACT golden outputs captured in dashboard.golden.test.ts.
  const anchor = u("2026-01-07");
  const c: PayCadence = "semimonthly";
  const s: WeekendShift = "prior_business_day";
  const cases: Array<[string, string]> = [
    ["2026-05-01", "2026-05-07"], // before the 7th
    ["2026-05-19", "2026-05-22"], // mid-cycle
    ["2026-05-21", "2026-05-22"], // payday-1
    ["2026-05-22", "2026-05-22"], // ON payday -> inclusive
    ["2026-05-23", "2026-06-05"], // payday+1 -> June 7 (Sun) -> Fri June 5
    ["2026-05-31", "2026-06-05"], // after both -> June 5
  ];
  it.each(cases)("nextPayDate(%s) === %s", (today, expected) => {
    expect(iso(nextPayDate(c, anchor, s, u(today)))).toBe(expected);
  });
});

describe("config resolution + legacy defaults", () => {
  it("parseAnchorDate accepts YYYY-MM-DD (UTC) and rejects junk", () => {
    expect(iso(parseAnchorDate("2026-06-10")!)).toBe("2026-06-10");
    expect(parseAnchorDate("")).toBeNull();
    expect(parseAnchorDate("06/10/2026")).toBeNull();
    expect(parseAnchorDate(null)).toBeNull();
    expect(parseAnchorDate("2026-13-40")).toBeNull();
  });
  it("normalize helpers coerce unknown values to legacy defaults", () => {
    expect(normalizeCadence("weekly")).toBe("weekly");
    expect(normalizeCadence("")).toBe("semimonthly");
    expect(normalizeCadence("fortnightly")).toBe("semimonthly");
    expect(normalizeWeekendShift("none")).toBe("none");
    expect(normalizeWeekendShift("bogus")).toBe("prior_business_day");
  });
  it("resolvePayCadenceConfig with everything unset yields the legacy schedule", () => {
    const cfg = resolvePayCadenceConfig(() => "");
    expect(cfg.cadence).toBe("semimonthly");
    expect(cfg.shift).toBe("prior_business_day");
    expect(cfg.anchor.getTime()).toBe(LEGACY_SEMIMONTHLY_ANCHOR.getTime());
    // And that legacy config reproduces a known golden next-payday.
    expect(iso(nextPayDate(cfg.cadence, cfg.anchor, cfg.shift, u("2026-05-23")))).toBe("2026-06-05");
  });
  it("resolvePayCadenceConfig reads the unemployment config", () => {
    const store: Record<string, string> = {
      pay_cadence: "weekly",
      pay_anchor_date: "2026-06-10",
      pay_weekend_shift: "prior_business_day",
    };
    const cfg = resolvePayCadenceConfig((k) => store[k]);
    expect(cfg.cadence).toBe("weekly");
    expect(iso(cfg.anchor)).toBe("2026-06-10");
    expect(iso(nextPayDate(cfg.cadence, cfg.anchor, cfg.shift, u("2026-06-11")))).toBe("2026-06-17");
  });
});

describe("nextPayDate — weekly / monthly", () => {
  const anchor = u("2026-06-10"); // Wed
  it("weekly is inclusive on the anchor day and steps forward", () => {
    expect(iso(nextPayDate("weekly", anchor, "none", u("2026-06-09")))).toBe("2026-06-10");
    expect(iso(nextPayDate("weekly", anchor, "none", u("2026-06-10")))).toBe("2026-06-10"); // inclusive
    expect(iso(nextPayDate("weekly", anchor, "none", u("2026-06-11")))).toBe("2026-06-17");
  });
  it("weekly applies the weekend shift to the chosen occurrence", () => {
    const satAnchor = u("2026-06-13"); // Sat
    expect(iso(nextPayDate("weekly", satAnchor, "prior_business_day", u("2026-06-13")))).toBe("2026-06-12");
    expect(iso(nextPayDate("weekly", satAnchor, "next_business_day", u("2026-06-13")))).toBe("2026-06-15");
  });
  it("monthly rolls to the next month after the anchor day passes", () => {
    const m = u("2026-01-15");
    expect(iso(nextPayDate("monthly", m, "none", u("2026-03-10")))).toBe("2026-03-15");
    expect(iso(nextPayDate("monthly", m, "none", u("2026-03-16")))).toBe("2026-04-15");
  });
});
