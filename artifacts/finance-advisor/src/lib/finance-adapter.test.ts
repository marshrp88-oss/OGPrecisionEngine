/**
 * Tests for the UI adapter that bridges API payloads to the validated
 * `@workspace/finance` engine. Engine semantics are already covered by
 * `lib/finance/engine.test.ts`; these tests focus on the adapter's
 * responsibilities: shape conversion, date parsing, and the cycle-boundary
 * filter that the engine applies on the bills we hand it.
 */
import { describe, it, expect } from "vitest";
import { Bill as EngineBill, d } from "@workspace/finance";
import {
  parseApiDate,
  toEngineBill,
  billsInCycleTotal,
  type ApiBill,
} from "./finance-adapter";

function apiBill(overrides: Partial<ApiBill> = {}): ApiBill {
  return {
    id: 1,
    name: "Bill",
    amount: 0,
    dueDay: 1,
    category: "general",
    autopay: true,
    includeInCycle: true,
    ...overrides,
  };
}

describe("parseApiDate", () => {
  it("returns null for null, undefined, and empty string", () => {
    expect(parseApiDate(null)).toBeNull();
    expect(parseApiDate(undefined)).toBeNull();
    expect(parseApiDate("")).toBeNull();
  });

  it("returns the same Date instance when given a Date", () => {
    const original = new Date("2026-01-05T00:00:00.000Z");
    const result = parseApiDate(original);
    expect(result).toBe(original);
  });

  it("parses an ISO yyyy-mm-dd string at UTC midnight", () => {
    const result = parseApiDate("2026-01-05");
    expect(result).not.toBeNull();
    expect(result!.getTime()).toBe(Date.UTC(2026, 0, 5));
  });

  it("parses a full ISO timestamp", () => {
    const result = parseApiDate("2026-01-05T12:34:56.000Z");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-01-05T12:34:56.000Z");
  });

  it("returns null for an unparseable string", () => {
    expect(parseApiDate("not a date")).toBeNull();
  });
});

describe("toEngineBill", () => {
  it("maps API fields to the engine Bill constructor positionally", () => {
    const bill = toEngineBill(
      apiBill({
        id: 42,
        name: "Phone",
        amount: 50,
        dueDay: 5,
        category: "utilities",
        autopay: false,
        includeInCycle: true,
      }),
    );
    expect(bill).toBeInstanceOf(EngineBill);
    expect(bill.name).toBe("Phone");
    expect(bill.amount).toBe(50);
    expect(bill.dueDay).toBe(5);
    expect(bill.category).toBe("utilities");
    expect(bill.include).toBe(true);
  });

  it("propagates includeInCycle=false to the engine's include flag", () => {
    const bill = toEngineBill(apiBill({ includeInCycle: false }));
    expect(bill.include).toBe(false);
  });
});

describe("billsInCycleTotal", () => {
  // today: Mon 2026-01-05, payday: Wed 2026-01-07 (no weekend shift).
  // The engine's cycle window is [today, effectivePayday) — strictly less
  // than payday — so a bill due ON payday is excluded by design.
  const today = d(2026, 1, 5);
  const nextPayday = d(2026, 1, 7);

  it("includes only bills due in [today, effectivePayday) and respects the boundary", () => {
    const bills: ApiBill[] = [
      // Due before today this month → engine rolls to next month → excluded.
      apiBill({ id: 1, name: "Rent", amount: 1000, dueDay: 1 }),
      // Due Jan 5 = today → included.
      apiBill({ id: 2, name: "Phone", amount: 50, dueDay: 5 }),
      // Due Jan 6 → included.
      apiBill({ id: 3, name: "Internet", amount: 80, dueDay: 6 }),
      // Due ON payday (Jan 7) → EXCLUDED (strict <).
      apiBill({ id: 4, name: "Gym", amount: 30, dueDay: 7 }),
      // Due after payday → excluded.
      apiBill({ id: 5, name: "Subscription", amount: 15, dueDay: 10 }),
      // includeInCycle=false → excluded regardless of due date.
      apiBill({
        id: 6,
        name: "Streaming",
        amount: 20,
        dueDay: 6,
        includeInCycle: false,
      }),
    ];

    const result = billsInCycleTotal(bills, today, nextPayday);

    expect(result.count).toBe(2);
    expect(result.total).toBe(130);
    expect(result.bills.map((b) => b.name).sort()).toEqual(["Internet", "Phone"]);
  });

  it("returns zeros when no bills fall inside the cycle window", () => {
    const bills: ApiBill[] = [
      apiBill({ id: 1, name: "Gym", amount: 30, dueDay: 7 }),
      apiBill({ id: 2, name: "Rent", amount: 1000, dueDay: 1 }),
    ];
    const result = billsInCycleTotal(bills, today, nextPayday);
    expect(result.count).toBe(0);
    expect(result.total).toBe(0);
    expect(result.bills).toEqual([]);
  });

  it("shifts the effective payday to the prior Friday on weekends", () => {
    // Nominal payday Sat 2026-01-10 → effective Fri 2026-01-09.
    // A bill due on Fri Jan 9 sits ON the effective payday → EXCLUDED.
    // A bill due on Thu Jan 8 → included.
    const todayLocal = d(2026, 1, 5);
    const nominal = d(2026, 1, 10);
    const bills: ApiBill[] = [
      apiBill({ id: 1, name: "Thu", amount: 25, dueDay: 8 }),
      apiBill({ id: 2, name: "Fri", amount: 40, dueDay: 9 }),
    ];
    const result = billsInCycleTotal(bills, todayLocal, nominal);
    expect(result.count).toBe(1);
    expect(result.total).toBe(25);
    expect(result.bills[0]!.name).toBe("Thu");
  });
});
