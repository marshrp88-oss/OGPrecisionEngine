// v9 one-shot data patch — idempotent. Run on a live DB to apply Phase 1
// bill-data corrections without wiping the existing state (seed.ts purges).
//
//   pnpm --filter @workspace/api-server exec tsx src/lib/v9-patch.ts
//
// Applied changes:
//   1. Car loan amount → 337.57 (was 337.00).
//   2. Remove EZ-Pass from recurring bills (idempotent delete by name).
//   3. Insert EZ-Pass top-up as a one-time expense (~$30, dated next month).
//   4. Insert Replit subscription ($21, day 21, autopay) if missing.
//   5. Delete stale `next_payday_date` assumption row if present.
//
// Re-running is safe — each operation checks current state first.

import {
  db,
  assumptions,
  bills,
  oneTimeExpenses,
} from "@workspace/db";
import { eq } from "drizzle-orm";

async function patch() {
  console.log("v9 patch — applying Phase 1 bill-data corrections…");

  // 1. Car loan amount → 337.57
  const carLoans = await db.select().from(bills);
  const carLoan = carLoans.find(
    (b) => b.name.toLowerCase().includes("car loan"),
  );
  if (carLoan && parseFloat(carLoan.amount) !== 337.57) {
    await db
      .update(bills)
      .set({ amount: "337.57", updatedAt: new Date() })
      .where(eq(bills.id, carLoan.id));
    console.log(
      `  [1] Car loan amount: ${carLoan.amount} → 337.57`,
    );
  } else if (carLoan) {
    console.log("  [1] Car loan already 337.57 — skip.");
  } else {
    console.log("  [1] No car loan bill found — skip.");
  }

  // 2. Remove recurring EZ-Pass bills (any case variant)
  const ezPassBills = carLoans.filter((b) =>
    b.name.toLowerCase().includes("ez-pass") ||
    b.name.toLowerCase().includes("ez pass") ||
    b.name.toLowerCase().includes("ezpass"),
  );
  if (ezPassBills.length > 0) {
    for (const b of ezPassBills) {
      await db.delete(bills).where(eq(bills.id, b.id));
      console.log(
        `  [2] Removed recurring bill "${b.name}" ($${b.amount}, day ${b.dueDay}).`,
      );
    }
  } else {
    console.log("  [2] No recurring EZ-Pass bill to remove — skip.");
  }

  // 3. EZ-Pass top-up as one-time expense (idempotent: skip if any open
  // EZ-Pass one-time already exists).
  const allOneTime = await db.select().from(oneTimeExpenses);
  const existingEzOneTime = allOneTime.find(
    (o) =>
      !o.deferred &&
      !o.paid &&
      (o.description.toLowerCase().includes("ez-pass") ||
        o.description.toLowerCase().includes("ez pass")),
  );
  if (!existingEzOneTime) {
    const today = new Date();
    const ezDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    await db.insert(oneTimeExpenses).values({
      description: "EZ-Pass top-up",
      amount: "30.00",
      dueDate: ezDate.toISOString().split("T")[0],
      paid: false,
      deferred: false,
      notes:
        "Moved from recurring (was $10 placeholder). Reload when balance dips.",
    });
    console.log(
      `  [3] Added EZ-Pass top-up one-time ($30, ${ezDate.toISOString().split("T")[0]}).`,
    );
  } else {
    console.log("  [3] EZ-Pass top-up one-time already present — skip.");
  }

  // 4. Replit subscription ($21, day 21, autopay) if missing
  const allBills = await db.select().from(bills);
  const replit = allBills.find((b) =>
    b.name.toLowerCase().includes("replit"),
  );
  if (!replit) {
    await db.insert(bills).values({
      name: "Replit Subscription",
      amount: "21.00",
      dueDay: 21,
      frequency: "monthly",
      category: "discretionary",
      autopay: true,
      includeInCycle: true,
    });
    console.log("  [4] Added Replit Subscription ($21, day 21, autopay).");
  } else {
    console.log("  [4] Replit subscription already present — skip.");
  }

  // 5. Delete stale next_payday_date assumption row
  const [stalePayday] = await db
    .select()
    .from(assumptions)
    .where(eq(assumptions.key, "next_payday_date"));
  if (stalePayday) {
    await db
      .delete(assumptions)
      .where(eq(assumptions.key, "next_payday_date"));
    console.log(
      `  [5] Deleted stale next_payday_date assumption (was "${stalePayday.value}").`,
    );
  } else {
    console.log("  [5] No stale next_payday_date assumption — skip.");
  }

  console.log("v9 patch complete.");
}

patch()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("v9 patch failed:", err);
    process.exit(1);
  });
