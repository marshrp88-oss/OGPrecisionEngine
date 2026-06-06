/**
 * clearCommissions.ts — idempotent removal of stale commission rows.
 * ==================================================================
 * The user was laid off; there is no commission income going forward, but the
 * `commissions` table still holds stale rows that inflate `totalMonthIncome`
 * (commissionPaidThisMonth + commissionPendingThisMonth) and corrupt the June
 * discretionary headline. This deletes every commission row.
 *
 * PRINT-BEFORE-DELETE: every existing row is printed first so the user sees
 * exactly what is removed. Safe to run repeatedly — once the table is empty a
 * re-run prints "no commission rows" and deletes nothing.
 *
 * This does NOT touch the commission MECHANISM (engine math, routes, tier
 * calculators all stay intact). When a future job has commission, the user
 * re-adds rows via the existing endpoint and the calculator resumes.
 *
 * Run (requires DATABASE_URL):
 *   pnpm --filter @workspace/api-server run clear:commissions
 */
import { db, commissions } from "@workspace/db";

async function clearCommissions(): Promise<void> {
  const existing = await db.select().from(commissions);
  if (existing.length === 0) {
    console.log("No commission rows present — nothing to clear.");
    return;
  }

  console.log(`Found ${existing.length} commission row(s) to remove:`);
  for (const c of existing) {
    console.log(
      `  id=${c.id}  salesMonth=${c.salesMonth}  status=${c.status}  ` +
        `gross=${c.grossTotal}  takeHome=${c.takeHome}  payoutDate=${c.payoutDate ?? "—"}`,
    );
  }

  const deleted = await db.delete(commissions).returning();
  console.log(`Deleted ${deleted.length} commission row(s). Table is now empty.`);
}

clearCommissions()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Clear commissions failed:", err);
    process.exit(1);
  });
