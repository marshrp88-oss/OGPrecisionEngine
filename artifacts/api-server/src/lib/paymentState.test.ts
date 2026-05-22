import { describe, it, expect } from "vitest";
import { cycleKey, decideBillStateTransition, type BillStateInput } from "./paymentState";

function base(overrides: Partial<BillStateInput> = {}): BillStateInput {
  return {
    includeInCycle: true,
    paymentState: "scheduled",
    paidDate: null,
    paymentStateCycleKey: null,
    dueDay: 15,
    autopay: false,
    ...overrides,
  };
}

describe("cycleKey", () => {
  it("formats YYYY-MM with zero-padded month", () => {
    expect(cycleKey(new Date(2026, 0, 5))).toBe("2026-01");
    expect(cycleKey(new Date(2026, 9, 22))).toBe("2026-10");
  });
});

describe("decideBillStateTransition — autopay flip on due day", () => {
  it("flips scheduled autopay bill to paid on the due day", () => {
    const today = new Date(2026, 4, 15); // May 15
    const d = decideBillStateTransition(base({ autopay: true, dueDay: 15 }), today);
    expect(d.paymentState).toBe("paid");
    expect(d.paidDate).toBe("2026-05-15");
    expect(d.paymentStateCycleKey).toBe("2026-05");
    expect(d.changed).toBe(true);
  });

  it("flips scheduled autopay bill to paid after the due day", () => {
    const today = new Date(2026, 4, 20);
    const d = decideBillStateTransition(base({ autopay: true, dueDay: 15 }), today);
    expect(d.paymentState).toBe("paid");
    expect(d.paidDate).toBe("2026-05-15");
  });

  it("leaves scheduled autopay bill before the due day untouched", () => {
    const today = new Date(2026, 4, 14);
    const d = decideBillStateTransition(base({ autopay: true, dueDay: 15 }), today);
    expect(d.paymentState).toBe("scheduled");
    expect(d.paidDate).toBeNull();
    expect(d.changed).toBe(false);
  });
});

describe("decideBillStateTransition — manual flip strictly past due", () => {
  it("does NOT flip manual bill on the due day (still grace)", () => {
    const today = new Date(2026, 4, 15);
    const d = decideBillStateTransition(base({ autopay: false, dueDay: 15 }), today);
    expect(d.paymentState).toBe("scheduled");
    expect(d.changed).toBe(false);
  });

  it("flips manual bill to late_unpaid only after due day (strict >)", () => {
    const today = new Date(2026, 4, 16);
    const d = decideBillStateTransition(base({ autopay: false, dueDay: 15 }), today);
    expect(d.paymentState).toBe("late_unpaid");
    expect(d.paidDate).toBeNull();
    expect(d.paymentStateCycleKey).toBe("2026-05");
    expect(d.changed).toBe(true);
  });
});

describe("decideBillStateTransition — cycle rollover at month boundary", () => {
  it("reverts prior-cycle 'paid' back to 'scheduled' with cleared paidDate", () => {
    const today = new Date(2026, 5, 3); // June 3
    const d = decideBillStateTransition(
      base({
        autopay: true,
        dueDay: 15,
        paymentState: "paid",
        paidDate: "2026-05-15",
        paymentStateCycleKey: "2026-05",
      }),
      today,
    );
    expect(d.paymentState).toBe("scheduled");
    expect(d.paidDate).toBeNull();
    expect(d.paymentStateCycleKey).toBe("2026-06");
    expect(d.changed).toBe(true);
  });

  it("reverts prior-cycle 'late_unpaid' to 'scheduled'", () => {
    const today = new Date(2026, 5, 1);
    const d = decideBillStateTransition(
      base({
        paymentState: "late_unpaid",
        paymentStateCycleKey: "2026-05",
        dueDay: 20,
      }),
      today,
    );
    expect(d.paymentState).toBe("scheduled");
    expect(d.paymentStateCycleKey).toBe("2026-06");
  });

  it("reverts prior-cycle 'skipped_cycle' to 'scheduled'", () => {
    const today = new Date(2026, 5, 1);
    const d = decideBillStateTransition(
      base({
        paymentState: "skipped_cycle",
        paymentStateCycleKey: "2026-05",
      }),
      today,
    );
    expect(d.paymentState).toBe("scheduled");
    expect(d.paymentStateCycleKey).toBe("2026-06");
  });

  it("rollover + auto-progression can both apply (revert then re-flip if past due)", () => {
    // June 16, autopay bill due 15th, was paid last month
    const today = new Date(2026, 5, 16);
    const d = decideBillStateTransition(
      base({
        autopay: true,
        dueDay: 15,
        paymentState: "paid",
        paidDate: "2026-05-15",
        paymentStateCycleKey: "2026-05",
      }),
      today,
    );
    // Rollover reverts to scheduled, then autopay flips it to paid for June.
    expect(d.paymentState).toBe("paid");
    expect(d.paidDate).toBe("2026-06-15");
    expect(d.paymentStateCycleKey).toBe("2026-06");
  });
});

describe("decideBillStateTransition — idempotency", () => {
  it("running twice on the same state produces no further change", () => {
    const today = new Date(2026, 4, 20);
    const input = base({ autopay: true, dueDay: 15 });
    const first = decideBillStateTransition(input, today);
    expect(first.changed).toBe(true);

    const second = decideBillStateTransition(
      {
        ...input,
        paymentState: first.paymentState,
        paidDate: first.paidDate,
        paymentStateCycleKey: first.paymentStateCycleKey,
      },
      today,
    );
    expect(second.changed).toBe(false);
    expect(second.paymentState).toBe(first.paymentState);
    expect(second.paidDate).toBe(first.paidDate);
    expect(second.paymentStateCycleKey).toBe(first.paymentStateCycleKey);
  });

  it("manual late_unpaid bill stays late_unpaid on subsequent runs in same cycle", () => {
    const today = new Date(2026, 4, 20);
    const first = decideBillStateTransition(
      base({ autopay: false, dueDay: 15 }),
      today,
    );
    expect(first.paymentState).toBe("late_unpaid");
    const second = decideBillStateTransition(
      {
        ...base({ autopay: false, dueDay: 15 }),
        paymentState: first.paymentState,
        paymentStateCycleKey: first.paymentStateCycleKey,
      },
      today,
    );
    expect(second.changed).toBe(false);
  });
});
