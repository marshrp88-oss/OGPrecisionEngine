/**
 * Route-level integration test for PATCH /bills/:id.
 *
 * Boots the bills router on a real Express app and exercises the full
 * HTTP round-trip (request parsing → handler → DB write → response zod
 * parsing). The DB and the cycleBillEngine are stubbed with vi.mock so
 * the test stays hermetic — what matters is that the route, when given
 * a paymentState patch, writes a payment_state_cycle_key column of the
 * form YYYY-MM through `db.update().set(...)`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const setSpy = vi.fn();
const returningSpy = vi.fn();

const stubBill = {
  id: 1,
  name: "Rent",
  amount: "1125.00",
  dueDay: 1,
  frequency: "monthly",
  includeInCycle: true,
  category: "essential",
  autopay: true,
  notes: null,
  activeFrom: null,
  activeUntil: null,
  paymentState: "paid",
  paidDate: "2026-05-01",
  paymentStateCycleKey: "2026-05",
  createdAt: new Date(),
  updatedAt: new Date(),
};

vi.mock("@workspace/db", () => {
  const updateChain = {
    set(data: unknown) {
      setSpy(data);
      return updateChain;
    },
    where() {
      return updateChain;
    },
    async returning() {
      returningSpy();
      return [stubBill];
    },
  };
  return {
    db: {
      update: () => updateChain,
      select: () => ({
        from: () => ({
          where: async () => [],
          orderBy: () => ({ limit: async () => [] }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: async () => [stubBill] }) }),
      delete: () => ({ where: () => ({ returning: async () => [stubBill] }) }),
    },
    bills: { id: "bills.id" },
    assumptions: {},
    commissions: {},
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, eq: () => ({ __eq: true }) };
});

vi.mock("../lib/cycleBillEngine", () => ({
  enumerateBills: vi.fn(async () => [
    {
      id: 1,
      name: "Rent",
      amount: 1125,
      dueDay: 1,
      frequency: "monthly",
      category: "essential",
      autopay: true,
      notes: null,
      includeInCycle: true,
      activeFrom: null,
      activeUntil: null,
      countsThisCycle: false,
      countsThisCycleStrict: false,
      countsThisMonth: false,
      nextDueDate: new Date("2026-06-01"),
      daysUntilDue: 14,
      isActivePeriod: true,
      paymentState: "paid",
      paidDate: "2026-05-01",
    },
  ]),
}));

vi.mock("../lib/financeEngine", () => ({
  deriveNextPayday: () => new Date("2026-05-22"),
}));

vi.mock("../lib/paymentState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/paymentState")>();
  // Keep the real cycleKey; stub the DB-bound sync to a noop.
  return { ...actual, syncBillPaymentStates: vi.fn(async () => {}) };
});

async function buildApp() {
  const billsRouter = (await import("./bills")).default;
  const app = express();
  app.use(express.json());
  app.use("/", billsRouter);
  return app;
}

describe("PATCH /bills/:id — integration (route + db stub)", () => {
  beforeEach(() => {
    setSpy.mockClear();
    returningSpy.mockClear();
  });

  it("stamps payment_state_cycle_key on the DB write when paymentState is supplied", async () => {
    const app = await buildApp();
    const res = await request(app).patch("/bills/1").send({ paymentState: "paid" });

    expect(res.status).toBe(200);
    expect(returningSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);

    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.paymentState).toBe("paid");
    // YYYY-MM, anchored to the server's current month.
    const now = new Date();
    const ck = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    expect(written.paymentStateCycleKey).toBe(ck);
    expect(written.updatedAt).toBeInstanceOf(Date);
  });

  it("does NOT stamp payment_state_cycle_key when paymentState is omitted", async () => {
    const app = await buildApp();
    const res = await request(app).patch("/bills/1").send({ amount: 1200 });

    expect(res.status).toBe(200);
    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written).not.toHaveProperty("paymentStateCycleKey");
    // Does not clobber paidDate either.
    expect(written).not.toHaveProperty("paidDate");
  });

  it("clears paid_date on non-paid transitions when no explicit paidDate is given", async () => {
    const app = await buildApp();
    await request(app).patch("/bills/1").send({ paymentState: "skipped_cycle" });

    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.paymentState).toBe("skipped_cycle");
    expect(written.paidDate).toBeNull();
  });

  it("preserves an explicitly supplied paidDate on a non-paid transition", async () => {
    const app = await buildApp();
    await request(app)
      .patch("/bills/1")
      .send({ paymentState: "late_unpaid", paidDate: "2026-05-01" });

    const written = setSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(written.paymentState).toBe("late_unpaid");
    // Zod coerces date strings; helper preserves the value (whatever shape).
    expect(written.paidDate).toBeDefined();
    expect(written.paidDate).not.toBeNull();
  });

  it("rejects an invalid paymentState with 400 (no DB write)", async () => {
    const app = await buildApp();
    const res = await request(app).patch("/bills/1").send({ paymentState: "bogus" });
    expect(res.status).toBe(400);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
