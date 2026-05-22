import { describe, it, expect } from "vitest";
import { buildBillPatchUpdate } from "./bills";

const today = new Date(2026, 4, 18); // May 18, 2026 (local)
const now = new Date("2026-05-18T12:00:00.000Z");

describe("buildBillPatchUpdate — PATCH /bills cycle-key stamping", () => {
  it("does NOT stamp paymentStateCycleKey when paymentState is omitted", () => {
    const out = buildBillPatchUpdate({ amount: "200.00" }, today, now);
    expect(out.paymentStateCycleKey).toBeUndefined();
    expect(out).toMatchObject({ amount: "200.00", updatedAt: now });
  });

  it("stamps paymentStateCycleKey to current YYYY-MM when paymentState is provided", () => {
    const out = buildBillPatchUpdate({ paymentState: "paid" }, today, now);
    expect(out.paymentStateCycleKey).toBe("2026-05");
    expect(out.paymentState).toBe("paid");
    expect(out.updatedAt).toBe(now);
  });

  it("clears paidDate when transitioning to non-paid without an explicit paidDate", () => {
    const out = buildBillPatchUpdate({ paymentState: "skipped_cycle" }, today, now);
    expect(out.paymentStateCycleKey).toBe("2026-05");
    expect(out.paidDate).toBeNull();
  });

  it("preserves explicitly supplied paidDate even for non-paid state", () => {
    const out = buildBillPatchUpdate(
      { paymentState: "late_unpaid", paidDate: "2026-05-01" },
      today,
      now,
    );
    expect(out.paidDate).toBe("2026-05-01");
  });

  it("does NOT clear paidDate when transitioning to paid", () => {
    const out = buildBillPatchUpdate(
      { paymentState: "paid", paidDate: "2026-05-18" },
      today,
      now,
    );
    expect(out.paidDate).toBe("2026-05-18");
    expect(out.paymentStateCycleKey).toBe("2026-05");
  });

  it("stamps cycle key derived from the supplied `today`, not the wall clock", () => {
    const augustToday = new Date(2026, 7, 2);
    const out = buildBillPatchUpdate({ paymentState: "paid" }, augustToday, now);
    expect(out.paymentStateCycleKey).toBe("2026-08");
  });
});
