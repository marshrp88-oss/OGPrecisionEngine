/**
 * dashboard.bills-still-to-pay.test.ts
 * ====================================
 * Pins the two "bills still to pay" classification fixes in /dashboard/cash-position:
 *
 *   BUG 1 — a bill marked `paid` with a debit date in the FUTURE (a scheduled
 *           auto-pay that hasn't withdrawn yet) must count as STILL TO PAY, not
 *           already-debited. Only `paid` + debit date <= today is truly debited.
 *
 *   BUG 2 — a toggled-ON `variable` bill (Capital One QuickSilver) must be
 *           included in commitmentOutflowsRemaining (so it reduces
 *           availableToInvest) — counted EXACTLY ONCE (availableToInvest does
 *           not subtract the cycle hold). Toggled OFF → excluded.
 *
 * General-logic guarantee: inclusion is gated by the toggle (includeInCycle) +
 * valid due day + amount > 0 and the past/future debit date — NOT by category
 * or autopay. Same rules for AUTO and MANUAL bills alike.
 *
 * Hermetic: @workspace/db + drizzle-orm mocked (same harness as
 * dashboard.golden.test.ts); the real finance engine is exercised. Clock pinned
 * to noon UTC on 2026-06-07 (stable across UTC-12..UTC+11).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

type BillFixture = {
  id: number;
  name: string;
  amount: string;
  dueDay: number;
  frequency: string;
  category: string;
  autopay: boolean;
  notes: string | null;
  includeInCycle: boolean;
  activeFrom: string | null;
  activeUntil: string | null;
  paymentState: string;
  paidDate: string | null;
  clearedDate: string | null;
  paymentStateCycleKey: string | null;
};

const fixture = vi.hoisted(() => {
  const bill = (over: Partial<BillFixture> & { id: number; name: string; amount: string; dueDay: number }): BillFixture => ({
    frequency: "monthly",
    category: "essential",
    autopay: true,
    notes: null,
    includeInCycle: true,
    activeFrom: null,
    activeUntil: null,
    paymentState: "scheduled",
    paidDate: null,
    clearedDate: null,
    paymentStateCycleKey: null,
    ...over,
  });
  // Mutable so tests can re-toggle includeInCycle / payment state between requests.
  const bills: BillFixture[] = [
    // Already debited — paid with a PAST date. Must be EXCLUDED from still-to-pay.
    bill({ id: 1, name: "Rent", amount: "1000.00", dueDay: 4, paymentState: "paid", paidDate: "2026-06-04" }),
    // BUG 1 — paid but auto-pays TOMORROW (future). Must count as still-to-pay.
    bill({ id: 2, name: "Car Insurance", amount: "141.95", dueDay: 8, autopay: true, paymentState: "paid", paidDate: "2026-06-08" }),
    // Plain unpaid manual + autopay bills due later this month → still-to-pay.
    bill({ id: 3, name: "YouTube Premium", amount: "14.00", dueDay: 15, category: "discretionary" }),
    bill({ id: 4, name: "Electric", amount: "108.00", dueDay: 16, autopay: false, notes: "Manual pay" }),
    bill({ id: 5, name: "Gas", amount: "147.10", dueDay: 19, autopay: false, notes: "Manual pay" }),
    bill({ id: 6, name: "Replit Subscription", amount: "21.00", dueDay: 21, category: "discretionary" }),
    // BUG 2 — toggled-ON variable QuickSilver with an owed balance → still-to-pay.
    bill({ id: 7, name: "Capital One QuickSilver (variable)", amount: "78.00", dueDay: 25, category: "variable", autopay: false, includeInCycle: true }),
  ];
  return {
    bills,
    balances: [{ id: 1, accountType: "checking", amount: "2174.00", asOfDate: "2026-06-06" }],
    assumptions: [
      { key: "variable_spend_cap", value: "600" },
      { key: "minimum_cushion", value: "0" },
      { key: "base_net_income", value: "3220" },
      { key: "quicksilver_balance_owed", value: "0" },
      { key: "commission_tax_rate", value: "0.435" },
      { key: "mrr_target", value: "700" },
      { key: "nrr_target", value: "6000" },
      // Pin R so availableToInvest arithmetic is deterministic.
      { key: "planned_variable_remaining_override:2026-06", value: "360" },
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
      case "bills": return fixture.bills as unknown as Array<Record<string, unknown>>;
      case "balances": return fixture.balances as unknown as Array<Record<string, unknown>>;
      case "assumptions": return fixture.assumptions as unknown as Array<Record<string, unknown>>;
      case "oneTimeExpenses": return fixture.oneTimeExpenses;
      case "variableSpend": return fixture.variableSpend;
      case "commissions": return fixture.commissions;
      case "retirementPlan": return fixture.retirementPlan;
      case "playbookVersions": return fixture.playbookVersions;
      case "integrityLog": return fixture.integrityLog;
      default: return [];
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
      orderBy() { return chain; },
      limit(n: number) { result = result.slice(0, n); return chain; },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }
  return {
    db: {
      select: () => ({ from(table: unknown) { return makeQuery(dataFor(table)); } }),
      insert: () => ({ values: () => ({ returning: async () => [] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      delete: () => ({ where: () => ({ returning: async () => [] }) }),
    },
    ...schemas,
  };
});

const QS = () => fixture.bills.find((b) => b.id === 7)!;
const ELECTRIC = () => fixture.bills.find((b) => b.id === 4)!;

describe("cash-position: bills still to pay (Bug 1 future-dated paid, Bug 2 toggled-on QS)", () => {
  let app: express.Express;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-07T12:00:00.000Z"));
    const router = (await import("./dashboard")).default;
    app = express();
    app.use(router);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    // Reset toggles to the default ON state before each test.
    QS().includeInCycle = true;
    ELECTRIC().includeInCycle = true;
  });

  const get = () => request(app).get("/dashboard/cash-position");

  it("combined target: bills still to pay = $510.05, availableToInvest = $1303.95", async () => {
    const b = (await get()).body;
    // Electric 108 + Gas 147.10 + Replit 21 + YouTube 14 + Car Insurance 141.95
    // (future auto-pay, Bug 1) + QuickSilver 78 (toggled on, Bug 2) = 510.05.
    expect(b.commitmentOutflowsRemaining).toBe(510.05);
    expect(b.billsNotYetDebited).toBe(510.05);
    // Rent (paid 06-04, past) is the only already-debited bill.
    expect(b.billsAlreadyDebited).toBe(1000);
    // 2174 − 510.05 − 360 (R) = 1303.95, counted exactly once.
    expect(b.availableToInvest).toBe(1303.95);
    expect(b.availableToInvest).toBe(
      b.currentChecking - b.commitmentOutflowsRemaining - b.variableExpectedRemaining,
    );
  });

  it("BUG 1: a paid bill with a FUTURE debit date is still-to-pay; with a PAST date it is debited", async () => {
    const b = (await get()).body;
    const names = (b.billsNotYetDebitedDetail as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("Car Insurance"); // paid, paidDate 2026-06-08 (future)
    expect(names).not.toContain("Rent"); // paid, paidDate 2026-06-04 (past)
    const debited = (b.billsAlreadyDebitedDetail as Array<{ name: string }>).map((r) => r.name);
    expect(debited).toContain("Rent");
    expect(debited).not.toContain("Car Insurance");
  });

  it("BUG 2: toggled-ON QuickSilver is included once; toggled-OFF is excluded", async () => {
    const on = (await get()).body;
    expect(on.commitmentOutflowsRemaining).toBe(510.05);
    expect(
      (on.billsNotYetDebitedDetail as Array<{ name: string }>).some((r) => r.name.includes("QuickSilver")),
    ).toBe(true);

    QS().includeInCycle = false;
    const off = (await get()).body;
    // Drops by exactly the QS amount ($78) — no double-count, no residue.
    expect(off.commitmentOutflowsRemaining).toBe(432.05);
    expect(on.commitmentOutflowsRemaining - off.commitmentOutflowsRemaining).toBeCloseTo(78, 2);
    expect(off.availableToInvest - on.availableToInvest).toBeCloseTo(78, 2);
    expect(
      (off.billsNotYetDebitedDetail as Array<{ name: string }>).some((r) => r.name.includes("QuickSilver")),
    ).toBe(false);
  });

  it("toggle a manual bill on→off→on changes bills-still-to-pay by exactly its amount each time", async () => {
    const on1 = (await get()).body.commitmentOutflowsRemaining;

    ELECTRIC().includeInCycle = false;
    const off = (await get()).body.commitmentOutflowsRemaining;
    expect(on1 - off).toBeCloseTo(108, 2);

    ELECTRIC().includeInCycle = true;
    const on2 = (await get()).body.commitmentOutflowsRemaining;
    expect(on2 - off).toBeCloseTo(108, 2);
    expect(on2).toBe(on1);
  });
});
