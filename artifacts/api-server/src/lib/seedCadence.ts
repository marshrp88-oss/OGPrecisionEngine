/**
 * seedCadence.ts — idempotent upsert of the unemployment pay-cadence config.
 * =========================================================================
 * Writes the five pay-cadence assumption keys that drive the cadence-aware
 * payday engine (see payCadence.ts / financeEngine.ts). Safe to run repeatedly:
 * each key is inserted if missing and only updated when its value changed.
 *
 * Run (requires DATABASE_URL):
 *   pnpm --filter @workspace/api-server run seed:cadence
 *
 * Every value here is ALSO settable at runtime via the existing endpoint, e.g.
 * to correct the first real deposit Wednesday in one call:
 *   curl -X PUT $API/assumptions/pay_anchor_date -H 'content-type: application/json' \
 *        -d '{"value":"2026-07-01"}'
 *
 * Defaults (when a key is unset) reproduce the legacy semi-monthly schedule, so
 * removing these rows reverts to 7th/22nd behavior.
 */
import { db, assumptions } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Unemployment income (ground truth): $750 net/week, paid weekly on Wednesdays,
 * no withholding. First real deposit is 2026-06-24 (the Wednesday on/after the
 * 23rd) — there is NO income before it. `pay_start_date` is the permanent fix
 * for phantom backdated paychecks: the generator emits no deposit before it.
 */
const CADENCE_ASSUMPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["pay_cadence", "weekly"],
  ["pay_anchor_date", "2026-06-24"], // a Wednesday — first unemployment deposit
  ["pay_start_date", "2026-06-24"], // income-start boundary; nothing before it
  ["net_per_period", "750.00"], // $750 take-home per weekly deposit
  ["pay_tax_rate", "0"], // stored only; not yet consumed by engine math
  ["pay_weekend_shift", "prior_business_day"],
];

async function upsertAssumption(key: string, value: string): Promise<"inserted" | "updated" | "unchanged"> {
  const [existing] = await db.select().from(assumptions).where(eq(assumptions.key, key));
  if (!existing) {
    await db.insert(assumptions).values({ key, value });
    return "inserted";
  }
  if (existing.value !== value) {
    await db.update(assumptions).set({ value, updatedAt: new Date() }).where(eq(assumptions.key, key));
    return "updated";
  }
  return "unchanged";
}

async function seedCadence(): Promise<void> {
  console.log("Upserting unemployment pay-cadence assumptions...");
  for (const [key, value] of CADENCE_ASSUMPTIONS) {
    const action = await upsertAssumption(key, value);
    console.log(`  ${key} = ${value}  (${action})`);
  }
  console.log("Pay-cadence assumptions seeded.");
}

seedCadence()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Cadence seed failed:", err);
    process.exit(1);
  });
