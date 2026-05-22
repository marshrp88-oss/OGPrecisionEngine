import { describe, it, expect } from "vitest";
import { selectActiveOneTimeExpenses, type OneTimeRow } from "./financeEngine";
import { oneTimeExpensesDueInCycle, d as utcDay } from "@workspace/finance";

const rows: OneTimeRow[] = [
  {
    description: "Vet visit",
    amount: "150.00",
    dueDate: "2026-05-20",
    paid: false,
    deferred: false,
  },
  {
    description: "Wedding gift",
    amount: "250.00",
    dueDate: "2026-05-22",
    paid: false,
    deferred: true,
  },
  {
    description: "Already paid car reg",
    amount: "85.00",
    dueDate: "2026-05-10",
    paid: true,
    deferred: false,
  },
  {
    description: "Deferred dental",
    amount: "500.00",
    dueDate: "2026-05-18",
    paid: false,
    deferred: true,
  },
];

describe("selectActiveOneTimeExpenses (v8.0 Part 3)", () => {
  it("filters out deferred entries", () => {
    const active = selectActiveOneTimeExpenses(rows);
    expect(active.map((o) => o.name).sort()).toEqual(
      ["Already paid car reg", "Vet visit"].sort(),
    );
  });

  it("preserves amount, paid status and dueDate parsing", () => {
    const active = selectActiveOneTimeExpenses(rows);
    const vet = active.find((o) => o.name === "Vet visit")!;
    expect(vet.amount).toBe(150);
    expect(vet.paid).toBe(false);
    expect(vet.dueDate).not.toBeNull();
  });

  it("returns an empty list when every row is deferred", () => {
    const all = selectActiveOneTimeExpenses([
      { description: "a", amount: "10", dueDate: null, paid: false, deferred: true },
      { description: "b", amount: "20", dueDate: null, paid: false, deferred: true },
    ]);
    expect(all).toEqual([]);
  });

  it("cycle engine total excludes deferred one-times", () => {
    // Total of non-deferred unpaid items dated in cycle should be 150
    // (vet visit only — paid item is excluded inside the engine,
    // deferred items are excluded by the helper).
    const today = utcDay(2026, 5, 1);
    const nextPayday = utcDay(2026, 5, 22);
    const active = selectActiveOneTimeExpenses(rows);
    const total = oneTimeExpensesDueInCycle(active, today, nextPayday);

    // Recompute including deferred to prove the filter is what removes them.
    const withDeferred = selectActiveOneTimeExpenses(
      rows.map((r) => ({ ...r, deferred: false })),
    );
    const totalIfDeferredIncluded = oneTimeExpensesDueInCycle(
      withDeferred,
      today,
      nextPayday,
    );

    expect(total).toBe(150);
    expect(totalIfDeferredIncluded).toBe(150 + 250 + 500);
  });
});
