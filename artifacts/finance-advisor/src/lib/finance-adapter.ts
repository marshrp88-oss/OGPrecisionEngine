/**
 * UI adapter for the shared `@workspace/finance` engine.
 *
 * The engine is pure TypeScript with strict `Date` inputs and snake_case
 * result fields in some places (e.g. `runway_months`). API responses arrive
 * as JSON, so dates are strings and field labels sometimes differ. This
 * adapter normalizes those shapes so pages can hand API payloads straight
 * to engine functions without each page re-implementing the conversions.
 */
import {
  Bill as EngineBill,
  pmt,
  fv,
  fvAnnual,
  matchGapAnalysis,
  retirementProjection,
  droughtSurvivalRunway,
  incomeReplacementFloor,
  incomeGrowthScenario,
  billsInCurrentCycle,
  type DroughtRunwayResult,
  type IncomeGrowthResult,
  type MatchGapResult,
  type RetirementProjectionResult,
} from "@workspace/finance";

export {
  pmt,
  fv,
  fvAnnual,
  matchGapAnalysis,
  retirementProjection,
  droughtSurvivalRunway,
  incomeReplacementFloor,
  incomeGrowthScenario,
};
export type {
  DroughtRunwayResult,
  IncomeGrowthResult,
  MatchGapResult,
  RetirementProjectionResult,
};

/** Convert a string|Date|null payload from the API into a Date. */
export function parseApiDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  // ISO yyyy-mm-dd or full ISO timestamp — both parseable by the Date ctor.
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Bill row shape returned by GET /api/bills. */
export interface ApiBill {
  id: number;
  name: string;
  amount: number;
  dueDay: number;
  category: string;
  autopay: boolean;
  includeInCycle: boolean;
  countsThisCycle?: boolean;
  nextDueDate?: string;
  daysUntilDue?: number;
}

/**
 * Map an API bill row to the engine's `Bill` shape. Engine bills only need
 * `name`, `amount`, `dueDay`, `category`, `includeInCycle` for the cycle
 * helpers we use here.
 */
export function toEngineBill(b: ApiBill): EngineBill {
  return new EngineBill(b.name, b.amount, b.dueDay, b.includeInCycle, b.category);
}

/** Sum bills in the current cycle from API rows + the API-supplied next payday. */
export function billsInCycleTotal(
  apiBills: ApiBill[],
  today: Date,
  nextPayday: Date,
): { total: number; count: number; bills: EngineBill[] } {
  const engineBills = apiBills.map(toEngineBill);
  const inCycle = billsInCurrentCycle(engineBills, today, nextPayday);
  const justBills = inCycle.map(([b]) => b);
  const total = justBills.reduce((s, b) => s + b.amount, 0);
  return { total, count: justBills.length, bills: justBills };
}
