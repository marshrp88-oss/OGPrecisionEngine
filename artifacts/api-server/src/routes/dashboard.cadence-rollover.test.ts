/**
 * dashboard.cadence-rollover.test.ts
 * ==================================
 * Rollover regression for WEEKLY cadence (PRD §4.4). With a weekly Wednesday
 * schedule the payday-morning rollover fires every week, so this locks the
 * behavior the legacy semi-monthly net can't exercise.
 *
 * Config: pay_cadence=weekly, pay_anchor_date=2026-06-10 (Wed),
 * pay_weekend_shift=prior_business_day. Drives computeCycleState at the
 * Wednesday payday and its neighbours and asserts there is NO date split /
 * off-by-one between the cycle window and the next-payday:
 *   - on payday the window rolls FORWARD (daysUntilPayday ≥ 1, next payday is
 *     strictly after today),
 *   - the ~7-day weekly window includes only bills due before the next
 *     Wednesday (proving the cycle follows the cadence, not the month).
 *
 * Hermetic — same db/drizzle mock harness as cycleHold.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const bill = (id: number, name: string, amount: string, dueDay: number) => ({
    id,
    name,
    amount,
    dueDay,
    frequency: "monthly",
    category: "essential",
    autopay: true,
    notes: null,
    includeInCycle: true,
    activeFrom: null,
    activeUntil: null,
    paymentState: "scheduled",
    paidDate: null,
    paymentStateCycleKey: null,
    clearedDate: null,
  });
  return {
    bills: [
      bill(1, "Rent", "1000.00", 1), // dueDay 1-7 → forward reserve, always held
      bill(2, "Electric", "200.00", 12), // in the weekly window only on/after Jun 10
      bill(3, "Phone", "80.00", 20), // never in a ~7-day window around Jun 10
    ],
    balances: [
      { id: 1, accountType: "checking", amount: "3000.00", asOfDate: "2026-06-09" },
    ],
    assumptions: [
      { key: "alert_threshold", value: "400" },
      { key: "month_length_days", value: "30.4" },
      { key: "variable_spend_cap", value: "600" },
      { key: "pending_holds_reserve", value: "0" },
      { key: "minimum_cushion", value: "0" },
      { key: "variable_spend_until_payday", value: "0" },
      { key: "base_net_income", value: "3000" },
      { key: "quicksilver_balance_owed", value: "0" },
      // Cadence config under test:
      { key: "pay_cadence", value: "weekly" },
      { key: "pay_anchor_date", value: "2026-06-10" },
      { key: "pay_weekend_shift", value: "prior_business_day" },
      { key: "net_per_period", value: "692.31" },
    ],
    oneTimeExpenses: [] as Array<Record<string, unknown>>,
    variableSpend: [] as Array<Record<string, unknown>>,
    commissions: [] as Array<Record<string, unknown>>,
    retirementPlan: [] as Array<Record<string, unknown>>,
    playbookVersions: [] as Array<Record<string, unknown>>,
    integrityLog: [] as Array<Record<string, unknown>>,
  };
});

function makeSchemaProxy(name: string): Record<string, string> & { __table: string } {
  return new Proxy({ __table: name } as Record<string, string> & { __table: string }, {
    get(target, prop) {
      if (prop === "__table") return target.__table;
      if (typeof prop === "string") return prop;
      return undefined;
    },
  });
}

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ _eq: { col: String(col), val } }),
    ne: (col: unknown, val: unknown) => ({ _ne: { col: String(col), val } }),
    and: (...conds: unknown[]) => ({ _and: conds }),
    desc: (col: unknown) => ({ _desc: String(col) }),
  };
});

vi.mock("@workspace/db", () => {
  const schemas = {
    bills: makeSchemaProxy("bills"),
    balances: makeSchemaProxy("balances"),
    assumptions: makeSchemaProxy("assumptions"),
    oneTimeExpenses: makeSchemaProxy("oneTimeExpenses"),
    variableSpend: makeSchemaProxy("variableSpend"),
    commissions: makeSchemaProxy("commissions"),
    retirementPlan: makeSchemaProxy("retirementPlan"),
    playbookVersions: makeSchemaProxy("playbookVersions"),
    integrityLog: makeSchemaProxy("integrityLog"),
  };
  function dataFor(table: unknown): Array<Record<string, unknown>> {
    const t = (table as { __table?: string })?.__table;
    switch (t) {
      case "bills":
        return fixture.bills as unknown as Array<Record<string, unknown>>;
      case "balances":
        return fixture.balances as unknown as Array<Record<string, unknown>>;
      case "assumptions":
        return fixture.assumptions as unknown as Array<Record<string, unknown>>;
      case "oneTimeExpenses":
        return fixture.oneTimeExpenses;
      case "variableSpend":
        return fixture.variableSpend;
      case "commissions":
        return fixture.commissions;
      case "retirementPlan":
        return fixture.retirementPlan;
      case "playbookVersions":
        return fixture.playbookVersions;
      case "integrityLog":
        return fixture.integrityLog;
      default:
        return [];
    }
  }
  function makeQuery(rows: Array<Record<string, unknown>>) {
    let result = [...rows];
    const chain = {
      where(cond: { _eq?: { col: string; val: unknown } }) {
        if (cond?._eq) {
          const { col, val } = cond._eq;
          result = result.filter((r) => r[col] === val);
        }
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit(n: number) {
        result = result.slice(0, n);
        return chain;
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }
  return {
    db: {
      select: () => ({
        from(table: unknown) {
          return makeQuery(dataFor(table));
        },
      }),
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      delete: () => ({ where: () => ({ returning: async () => [] }) }),
    },
    ...schemas,
  };
});

const u = (s: string) => new Date(s + "T00:00:00.000Z");
const iso = (d: Date | null) => (d ? d.toISOString().split("T")[0] : null);

describe("Weekly cadence — payday-morning rollover (anchor Wed 2026-06-10)", () => {
  it("cycle window + next payday stay consistent across Tue/Wed/Thu", async () => {
    const { computeCycleState } = await import("../lib/financeEngine");
    const pick = (c: Awaited<ReturnType<typeof computeCycleState>>) => ({
      nextPayday: iso(c.nextPayday),
      daysUntilPayday: c.daysUntilPayday,
      billsDueBeforePayday: c.billsDueBeforePayday,
      forwardReserve: c.forwardReserve,
      totalRequiredHold: c.totalRequiredHold,
      safeToSpend: c.safeToSpend,
    });
    const snap = {
      jun09_paydayMinus1: pick(await computeCycleState(u("2026-06-09"))),
      jun10_onPayday: pick(await computeCycleState(u("2026-06-10"))),
      jun11_paydayPlus1: pick(await computeCycleState(u("2026-06-11"))),
    };
    expect(snap).toMatchInlineSnapshot(`
      {
        "jun09_paydayMinus1": {
          "billsDueBeforePayday": 1000,
          "daysUntilPayday": 1,
          "forwardReserve": 1000,
          "nextPayday": "2026-06-10",
          "safeToSpend": 2000,
          "totalRequiredHold": 1000,
        },
        "jun10_onPayday": {
          "billsDueBeforePayday": 1200,
          "daysUntilPayday": 7,
          "forwardReserve": 1000,
          "nextPayday": "2026-06-17",
          "safeToSpend": 1800,
          "totalRequiredHold": 1200,
        },
        "jun11_paydayPlus1": {
          "billsDueBeforePayday": 1200,
          "daysUntilPayday": 6,
          "forwardReserve": 1000,
          "nextPayday": "2026-06-17",
          "safeToSpend": 1800,
          "totalRequiredHold": 1200,
        },
      }
    `);
  });

  it("on payday the window rolls FORWARD — no zero-day / off-by-one split", async () => {
    const { computeCycleState } = await import("../lib/financeEngine");
    const onPayday = await computeCycleState(u("2026-06-10"));
    // Next payday is the FOLLOWING Wednesday, strictly after today.
    expect(iso(onPayday.nextPayday)).toBe("2026-06-17");
    expect(onPayday.daysUntilPayday).toBe(7);
    // Electric (due Jun 12) is inside the rolled [Jun 10, Jun 17) window;
    // Rent (dueDay 1) is the forward reserve. Phone (Jun 20) is out of range.
    expect(onPayday.billsDueBeforePayday).toBeCloseTo(1200, 2);
    expect(onPayday.forwardReserve).toBeCloseTo(1000, 2);
  });

  it("the weekly window is ~7 days — the day before payday excludes next week's bills", async () => {
    const { computeCycleState } = await import("../lib/financeEngine");
    const minus1 = await computeCycleState(u("2026-06-09"));
    // [Jun 9, Jun 10) holds only the forward reserve (Rent); Electric (Jun 12)
    // is beyond the next deposit, so the weekly window correctly excludes it.
    expect(iso(minus1.nextPayday)).toBe("2026-06-10");
    expect(minus1.daysUntilPayday).toBe(1);
    expect(minus1.billsDueBeforePayday).toBeCloseTo(1000, 2);
  });
});
