import {
  Bill,
  CommissionRow,
  OneTimeExpense,
  PurchaseOption,
  d as utcDay,
  mrrPayoutGross,
  nrrPayoutGross,
  commissionTakeHome,
  pmt,
  fv,
  fvAnnual,
  matchGapAnalysis,
  taxReservePerPaycheck,
  incomeGrowthScenario,
  incomeReplacementFloor,
  droughtSurvivalRunway,
  debtPayoffAnalysis,
  retirementProjection,
  forwardProjection,
  decisionSandboxCompare,
  forwardReserve,
  requiredHold,
  safeToSpend,
  monthlySavingsEstimate,
  effectivePayday,
  daysUntilPayday,
  billsInCurrentCycle,
  oneTimeExpensesDueInCycle,
  hysaGap,
} from "@workspace/finance";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, JsonValue>;
    required?: string[];
  };
}

const NUM = { type: "number" } as const;
const STR = { type: "string" } as const;
const BOOL = { type: "boolean" } as const;
const DATE_STR = {
  type: "string",
  description: "ISO date in YYYY-MM-DD format (UTC).",
} as const;

const BILL_SCHEMA = {
  type: "object",
  properties: {
    name: STR,
    amount: NUM,
    dueDay: { type: "integer", minimum: 1, maximum: 31 },
    include: BOOL,
    category: STR,
    autopay: BOOL,
  },
  required: ["name", "amount", "dueDay", "include"],
} as const;

const COMMISSION_SCHEMA = {
  type: "object",
  properties: {
    salesMonth: { ...DATE_STR, description: "First-of-month date for the sales month." },
    mrrAchieved: NUM,
    nrrAchieved: NUM,
  },
  required: ["salesMonth", "mrrAchieved", "nrrAchieved"],
} as const;

const ONE_TIME_SCHEMA = {
  type: "object",
  properties: {
    name: STR,
    amount: NUM,
    dueDate: { ...DATE_STR, description: "ISO date or null." },
    paid: BOOL,
  },
  required: ["name", "amount"],
} as const;

const PURCHASE_OPTION_SCHEMA = {
  type: "object",
  properties: {
    name: STR,
    totalPrice: NUM,
    downPayment: NUM,
    annualRate: { ...NUM, description: "APR as decimal, e.g. 0.0474 for 4.74%." },
    termMonths: { type: "integer" },
    monthlyAddons: { ...NUM, description: "Recurring monthly costs like insurance and registration." },
    oneTimeCost: { ...NUM, description: "Used only for cash purchases (totalPrice = 0)." },
  },
  required: ["name", "totalPrice"],
} as const;

function parseDate(input: unknown): Date {
  if (input instanceof Date) return input;
  if (typeof input !== "string") {
    throw new Error(`Invalid date input: ${JSON.stringify(input)}`);
  }
  const ymd = input.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`Date must be YYYY-MM-DD, got: ${input}`);
  return utcDay(parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10));
}

function parseDateOrNull(input: unknown): Date | null {
  if (input == null || input === "") return null;
  return parseDate(input);
}

interface BillJSON {
  name: string;
  amount: number;
  dueDay: number;
  include: boolean;
  category?: string;
  autopay?: boolean;
}
function toBill(b: BillJSON): Bill {
  return new Bill(b.name, b.amount, b.dueDay, b.include, b.category ?? "", b.autopay ?? true);
}

interface CommissionJSON {
  salesMonth: string;
  mrrAchieved: number;
  nrrAchieved: number;
}
function toCommission(c: CommissionJSON): CommissionRow {
  return new CommissionRow(parseDate(c.salesMonth), c.mrrAchieved, c.nrrAchieved);
}

interface OneTimeJSON {
  name: string;
  amount: number;
  dueDate?: string | null;
  paid?: boolean;
}
function toOneTime(o: OneTimeJSON): OneTimeExpense {
  return new OneTimeExpense(o.name, o.amount, parseDateOrNull(o.dueDate), o.paid ?? false);
}

interface PurchaseOptionJSON {
  name: string;
  totalPrice: number;
  downPayment?: number;
  annualRate?: number;
  termMonths?: number;
  monthlyAddons?: number;
  oneTimeCost?: number;
}
function toPurchaseOption(o: PurchaseOptionJSON): PurchaseOption {
  return new PurchaseOption(
    o.name,
    o.totalPrice,
    o.downPayment ?? 0,
    o.annualRate ?? 0,
    o.termMonths ?? 60,
    o.monthlyAddons ?? 0,
    o.oneTimeCost ?? 0,
  );
}

function serialize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

export const ENGINE_TOOLS: AnthropicTool[] = [
  {
    name: "mrrPayoutGross",
    description:
      "Compute the gross MRR commission payout (4-tier piecewise) for a given monthly recurring revenue achieved. Returns dollars before tax.",
    input_schema: {
      type: "object",
      properties: {
        mrr: { ...NUM, description: "MRR achieved this month, in dollars." },
        mrrTarget: { ...NUM, description: "Optional target override. Defaults to $700." },
      },
      required: ["mrr"],
    },
  },
  {
    name: "nrrPayoutGross",
    description:
      "Compute the gross NRR commission payout (4-tier piecewise). Returns dollars before tax.",
    input_schema: {
      type: "object",
      properties: {
        nrr: { ...NUM, description: "NRR achieved this month, in dollars." },
        nrrTarget: { ...NUM, description: "Optional target override. Defaults to $6,000." },
      },
      required: ["nrr"],
    },
  },
  {
    name: "commissionTakeHome",
    description:
      "Compute take-home commission after tax withholding for given MRR/NRR achieved.",
    input_schema: {
      type: "object",
      properties: {
        mrr: NUM,
        nrr: NUM,
        mrrTarget: NUM,
        nrrTarget: NUM,
        taxRate: { ...NUM, description: "Decimal, e.g. 0.435. Default per playbook." },
      },
      required: ["mrr", "nrr"],
    },
  },
  {
    name: "pmt",
    description: "Excel-style PMT — monthly loan payment. Returns dollars per month.",
    input_schema: {
      type: "object",
      properties: {
        annualRate: { ...NUM, description: "APR as decimal." },
        termMonths: { type: "integer" },
        principal: NUM,
      },
      required: ["annualRate", "termMonths", "principal"],
    },
  },
  {
    name: "fv",
    description: "Future value with periodic payment and present value (per-period rate).",
    input_schema: {
      type: "object",
      properties: {
        annualRate: { ...NUM, description: "Per-period rate (already divided)." },
        periods: { type: "integer" },
        payment: NUM,
        pv: NUM,
      },
      required: ["annualRate", "periods", "payment", "pv"],
    },
  },
  {
    name: "fvAnnual",
    description: "Future value compounded annually with annual payment and present value.",
    input_schema: {
      type: "object",
      properties: {
        annualRate: NUM,
        years: { type: "integer" },
        annualPayment: NUM,
        pv: NUM,
      },
      required: ["annualRate", "years", "annualPayment", "pv"],
    },
  },
  {
    name: "matchGapAnalysis",
    description:
      "401(k) match gap analysis. Returns annual/monthly free employer match left on the table at a given employee contribution rate.",
    input_schema: {
      type: "object",
      properties: {
        grossSalary: NUM,
        contributionPct: { ...NUM, description: "Decimal, e.g. 0.04 for 4%." },
        matchMultiplier: NUM,
        employeeCeiling: NUM,
      },
    },
  },
  {
    name: "taxReservePerPaycheck",
    description:
      "Tax reserve per paycheck and per month based on gross annual salary and tax rates. Returns [perPaycheck, perMonth].",
    input_schema: {
      type: "object",
      properties: {
        grossAnnual: NUM,
        fedRate: NUM,
        stateRate: NUM,
        payPeriods: { type: "integer" },
      },
    },
  },
  {
    name: "incomeGrowthScenario",
    description:
      "Model the cash-flow impact of a base-salary change (e.g. raise to $X). Returns new monthly net, savings floor, and improvement.",
    input_schema: {
      type: "object",
      properties: {
        currentBaseSalary: NUM,
        newBaseSalary: NUM,
        fedRate: NUM,
        stateRate: NUM,
        baseNetMonthly: NUM,
        monthlyFixedBills: NUM,
      },
    },
  },
  {
    name: "incomeReplacementFloor",
    description:
      "Compute minimum base salary (annual + monthly gross) required to maintain the savings floor at $0 commission.",
    input_schema: {
      type: "object",
      properties: {
        monthlySavingsTarget: NUM,
        monthlyFixedBills: NUM,
        variableCap: NUM,
        totalTaxRate: NUM,
      },
      required: ["monthlySavingsTarget", "monthlyFixedBills", "variableCap", "totalTaxRate"],
    },
  },
  {
    name: "droughtSurvivalRunway",
    description:
      "Zero-commission runway calculation. Returns months of runway given liquid balances and burn.",
    input_schema: {
      type: "object",
      properties: {
        checkingBalance: NUM,
        hysaBalance: NUM,
        monthlyFixedBills: NUM,
        variableCap: NUM,
        baseNetMonthly: NUM,
      },
      required: [
        "checkingBalance",
        "hysaBalance",
        "monthlyFixedBills",
        "variableCap",
        "baseNetMonthly",
      ],
    },
  },
  {
    name: "debtPayoffAnalysis",
    description:
      "Student-loan / installment-debt payoff analysis at standard, extended, 3yr, 5yr, 7yr aggressive scenarios with INVEST vs PAY verdict.",
    input_schema: {
      type: "object",
      properties: {
        balance: NUM,
        annualRate: NUM,
        standardTermYears: { type: "integer" },
        extendedTermYears: { type: "integer" },
        returnAssumption: NUM,
      },
      required: ["balance", "annualRate"],
    },
  },
  {
    name: "retirementProjection",
    description:
      "401(k) projections at three contribution rates (current, ceiling, aggressive 12%). Returns FV at 60 and 65.",
    input_schema: {
      type: "object",
      properties: {
        grossSalary: NUM,
        contributionPct: NUM,
        currentBalance: NUM,
        currentAge: { type: "integer" },
        targetAge: { type: "integer" },
        returnAssumption: NUM,
        matchMultiplier: NUM,
        employeeCeiling: NUM,
      },
    },
  },
  {
    name: "forwardProjection",
    description:
      "Multi-cycle forward cash-flow projection across 1-12 paydays. Use this for any 'what will my balance look like over the next N paydays' question. For hypothetical scenarios, build the bills/commissions arrays with the proposed changes layered in.",
    input_schema: {
      type: "object",
      properties: {
        currentChecking: NUM,
        bills: { type: "array", items: BILL_SCHEMA },
        today: DATE_STR,
        nextPaydayNominal: { ...DATE_STR, description: "Next nominal payday before weekend adjustment." },
        commissions: { type: "array", items: COMMISSION_SCHEMA },
        cycles: { type: "integer", minimum: 1, maximum: 12, description: "Number of cycles to project. Default 2." },
        baseNetMonthly: NUM,
        variableCap: NUM,
        mrrTarget: NUM,
        nrrTarget: NUM,
        taxRate: NUM,
      },
      required: ["currentChecking", "bills", "today", "nextPaydayNominal", "commissions"],
    },
  },
  {
    name: "decisionSandboxCompare",
    description:
      "Compare up to 4 purchase options (cars, big-ticket items) across monthly cost, daily lifestyle hit, HYSA runway, opportunity cost, and affordability flag.",
    input_schema: {
      type: "object",
      properties: {
        options: { type: "array", items: PURCHASE_OPTION_SCHEMA, minItems: 1, maxItems: 4 },
        currentDailySafeSpend: NUM,
        monthlyFixedBills: NUM,
        variableCap: NUM,
        baseNetMonthly: NUM,
        hysaBalance: NUM,
        returnAssumption: NUM,
        opportunityCostMonths: { type: "integer" },
      },
      required: [
        "options",
        "currentDailySafeSpend",
        "monthlyFixedBills",
        "variableCap",
        "baseNetMonthly",
        "hysaBalance",
      ],
    },
  },
  {
    name: "forwardReserve",
    description:
      "Compute the next-month forward reserve (1st-7th bills + 7 days variable). Used for override scenarios.",
    input_schema: {
      type: "object",
      properties: {
        bills: { type: "array", items: BILL_SCHEMA },
        variableCap: NUM,
        monthLengthDays: NUM,
      },
      required: ["bills"],
    },
  },
  {
    name: "requiredHold",
    description: "Sum of all reserves against checking. Used for override scenarios.",
    input_schema: {
      type: "object",
      properties: {
        billsDueTotal: NUM,
        pendingHolds: NUM,
        minimumCushion: NUM,
        checkingFloor: NUM,
        irregularBuffer: NUM,
        timingBuffer: NUM,
        oneTimeDueTotal: NUM,
      },
      required: ["billsDueTotal"],
    },
  },
  {
    name: "safeToSpend",
    description:
      "Safe-to-Spend computation. Used for override scenarios (e.g. 'what if my checking were $X?').",
    input_schema: {
      type: "object",
      properties: {
        checkingBalance: NUM,
        billsDueTotal: NUM,
        pendingHolds: NUM,
        minimumCushion: NUM,
        oneTimeDueTotal: NUM,
        forwardReserveAmount: NUM,
        includeForwardReserveInSts: BOOL,
      },
      required: ["checkingBalance", "billsDueTotal"],
    },
  },
  {
    name: "monthlySavingsEstimate",
    description:
      "Monthly savings estimate from base net + confirmed commission minus all monthly outflows. Used for override scenarios.",
    input_schema: {
      type: "object",
      properties: {
        baseNetMonthly: NUM,
        confirmedCommission: NUM,
        includedBills: { type: "array", items: BILL_SCHEMA },
        nextPaydayNominal: DATE_STR,
        today: DATE_STR,
        oneTimeExpenses: { type: "array", items: ONE_TIME_SCHEMA },
        quicksilverAccrual: NUM,
        billsForReserve: { type: "array", items: BILL_SCHEMA },
        variableCap: NUM,
      },
      required: [
        "baseNetMonthly",
        "confirmedCommission",
        "includedBills",
        "nextPaydayNominal",
        "today",
        "oneTimeExpenses",
        "quicksilverAccrual",
        "billsForReserve",
      ],
    },
  },
  {
    name: "effectivePayday",
    description: "Weekend-adjust a nominal payday to the prior Friday if Sat/Sun.",
    input_schema: {
      type: "object",
      properties: { nominal: DATE_STR },
      required: ["nominal"],
    },
  },
  {
    name: "daysUntilPayday",
    description: "Days remaining until the effective payday (floored at 0).",
    input_schema: {
      type: "object",
      properties: { today: DATE_STR, nextPaydayNominal: DATE_STR },
      required: ["today", "nextPaydayNominal"],
    },
  },
  {
    name: "billsInCurrentCycle",
    description:
      "Filter bills due in the current cycle (today <= dueDate < effective payday). Returns the matching bills with their next due dates.",
    input_schema: {
      type: "object",
      properties: {
        bills: { type: "array", items: BILL_SCHEMA },
        today: DATE_STR,
        nextPaydayNominal: DATE_STR,
      },
      required: ["bills", "today", "nextPaydayNominal"],
    },
  },
  {
    name: "oneTimeExpensesDueInCycle",
    description:
      "Sum of unpaid one-time expenses with due date inside the current cycle (today <= dueDate <= effective payday).",
    input_schema: {
      type: "object",
      properties: {
        expenses: { type: "array", items: ONE_TIME_SCHEMA },
        today: DATE_STR,
        nextPaydayNominal: DATE_STR,
      },
      required: ["expenses", "today", "nextPaydayNominal"],
    },
  },
  {
    name: "hysaGap",
    description: "HYSA gap to target. Negative = surplus.",
    input_schema: {
      type: "object",
      properties: { current: NUM, target: NUM },
      required: ["current"],
    },
  },
];

type ToolInput = Record<string, unknown>;

function num(input: ToolInput, key: string, required = false): number | undefined {
  const v = input[key];
  if (v == null) {
    if (required) throw new Error(`Missing required parameter: ${key}`);
    return undefined;
  }
  if (typeof v !== "number") throw new Error(`Parameter ${key} must be a number`);
  return v;
}

function reqNum(input: ToolInput, key: string): number {
  return num(input, key, true)!;
}

function billArray(input: ToolInput, key: string): Bill[] {
  const v = input[key];
  if (!Array.isArray(v)) throw new Error(`Parameter ${key} must be an array`);
  return v.map((b) => toBill(b as BillJSON));
}

function commissionArray(input: ToolInput, key: string): CommissionRow[] {
  const v = input[key];
  if (!Array.isArray(v)) throw new Error(`Parameter ${key} must be an array`);
  return v.map((c) => toCommission(c as CommissionJSON));
}

function oneTimeArray(input: ToolInput, key: string): OneTimeExpense[] {
  const v = input[key];
  if (!Array.isArray(v)) throw new Error(`Parameter ${key} must be an array`);
  return v.map((o) => toOneTime(o as OneTimeJSON));
}

function purchaseOptionArray(input: ToolInput, key: string): PurchaseOption[] {
  const v = input[key];
  if (!Array.isArray(v)) throw new Error(`Parameter ${key} must be an array`);
  return v.map((p) => toPurchaseOption(p as PurchaseOptionJSON));
}

export function executeEngineTool(name: string, rawInput: unknown): unknown {
  const input = (rawInput ?? {}) as ToolInput;
  switch (name) {
    case "mrrPayoutGross":
      return mrrPayoutGross(reqNum(input, "mrr"), num(input, "mrrTarget"));
    case "nrrPayoutGross":
      return nrrPayoutGross(reqNum(input, "nrr"), num(input, "nrrTarget"));
    case "commissionTakeHome":
      return commissionTakeHome(
        reqNum(input, "mrr"),
        reqNum(input, "nrr"),
        num(input, "mrrTarget"),
        num(input, "nrrTarget"),
        num(input, "taxRate"),
      );
    case "pmt":
      return pmt(reqNum(input, "annualRate"), reqNum(input, "termMonths"), reqNum(input, "principal"));
    case "fv":
      return fv(
        reqNum(input, "annualRate"),
        reqNum(input, "periods"),
        reqNum(input, "payment"),
        reqNum(input, "pv"),
      );
    case "fvAnnual":
      return fvAnnual(
        reqNum(input, "annualRate"),
        reqNum(input, "years"),
        reqNum(input, "annualPayment"),
        reqNum(input, "pv"),
      );
    case "matchGapAnalysis":
      return matchGapAnalysis(
        num(input, "grossSalary"),
        num(input, "contributionPct"),
        num(input, "matchMultiplier"),
        num(input, "employeeCeiling"),
      );
    case "taxReservePerPaycheck": {
      const r = taxReservePerPaycheck(
        num(input, "grossAnnual"),
        num(input, "fedRate"),
        num(input, "stateRate"),
        num(input, "payPeriods"),
      );
      return { perPaycheck: r[0], perMonth: r[1] };
    }
    case "incomeGrowthScenario":
      return incomeGrowthScenario(
        num(input, "currentBaseSalary"),
        num(input, "newBaseSalary"),
        num(input, "fedRate"),
        num(input, "stateRate"),
        num(input, "baseNetMonthly"),
        num(input, "monthlyFixedBills"),
      );
    case "incomeReplacementFloor": {
      const r = incomeReplacementFloor(
        reqNum(input, "monthlySavingsTarget"),
        reqNum(input, "monthlyFixedBills"),
        reqNum(input, "variableCap"),
        reqNum(input, "totalTaxRate"),
      );
      return { annualFloor: r[0], monthlyFloorGross: r[1] };
    }
    case "droughtSurvivalRunway":
      return droughtSurvivalRunway(
        reqNum(input, "checkingBalance"),
        reqNum(input, "hysaBalance"),
        reqNum(input, "monthlyFixedBills"),
        reqNum(input, "variableCap"),
        reqNum(input, "baseNetMonthly"),
      );
    case "debtPayoffAnalysis":
      return debtPayoffAnalysis(
        reqNum(input, "balance"),
        reqNum(input, "annualRate"),
        num(input, "standardTermYears"),
        num(input, "extendedTermYears"),
        num(input, "returnAssumption"),
      );
    case "retirementProjection":
      return retirementProjection(
        num(input, "grossSalary"),
        num(input, "contributionPct"),
        num(input, "currentBalance"),
        num(input, "currentAge"),
        num(input, "targetAge"),
        num(input, "returnAssumption"),
        num(input, "matchMultiplier"),
        num(input, "employeeCeiling"),
      );
    case "forwardProjection":
      return serialize(
        forwardProjection({
          currentChecking: reqNum(input, "currentChecking"),
          bills: billArray(input, "bills"),
          today: parseDate(input["today"]),
          nextPaydayNominal: parseDate(input["nextPaydayNominal"]),
          commissions: commissionArray(input, "commissions"),
          cycles: num(input, "cycles") as number | undefined,
          baseNetMonthly: num(input, "baseNetMonthly"),
          variableCap: num(input, "variableCap"),
          mrrTarget: num(input, "mrrTarget"),
          nrrTarget: num(input, "nrrTarget"),
          taxRate: num(input, "taxRate"),
        }),
      );
    case "decisionSandboxCompare":
      return decisionSandboxCompare(
        purchaseOptionArray(input, "options"),
        reqNum(input, "currentDailySafeSpend"),
        reqNum(input, "monthlyFixedBills"),
        reqNum(input, "variableCap"),
        reqNum(input, "baseNetMonthly"),
        reqNum(input, "hysaBalance"),
        num(input, "returnAssumption"),
        num(input, "opportunityCostMonths"),
      );
    case "forwardReserve":
      return forwardReserve(
        billArray(input, "bills"),
        num(input, "variableCap"),
        num(input, "monthLengthDays"),
      );
    case "requiredHold":
      return requiredHold(
        reqNum(input, "billsDueTotal"),
        num(input, "pendingHolds"),
        num(input, "minimumCushion"),
        num(input, "checkingFloor"),
        num(input, "irregularBuffer"),
        num(input, "timingBuffer"),
        num(input, "oneTimeDueTotal"),
      );
    case "safeToSpend":
      return safeToSpend(reqNum(input, "checkingBalance"), reqNum(input, "billsDueTotal"), {
        pendingHolds: num(input, "pendingHolds"),
        minimumCushion: num(input, "minimumCushion"),
        oneTimeDueTotal: num(input, "oneTimeDueTotal"),
        forwardReserveAmount: num(input, "forwardReserveAmount"),
        includeForwardReserveInSts: input["includeForwardReserveInSts"] as boolean | undefined,
      });
    case "monthlySavingsEstimate":
      return monthlySavingsEstimate(
        reqNum(input, "baseNetMonthly"),
        reqNum(input, "confirmedCommission"),
        billArray(input, "includedBills"),
        parseDate(input["nextPaydayNominal"]),
        parseDate(input["today"]),
        oneTimeArray(input, "oneTimeExpenses"),
        reqNum(input, "quicksilverAccrual"),
        billArray(input, "billsForReserve"),
        num(input, "variableCap"),
      );
    case "effectivePayday":
      return serialize(effectivePayday(parseDate(input["nominal"])));
    case "daysUntilPayday":
      return daysUntilPayday(parseDate(input["today"]), parseDate(input["nextPaydayNominal"]));
    case "billsInCurrentCycle":
      return serialize(
        billsInCurrentCycle(
          billArray(input, "bills"),
          parseDate(input["today"]),
          parseDate(input["nextPaydayNominal"]),
        ).map(([b, dueDate]) => ({ bill: { name: b.name, amount: b.amount, dueDay: b.dueDay }, dueDate })),
      );
    case "oneTimeExpensesDueInCycle":
      return oneTimeExpensesDueInCycle(
        oneTimeArray(input, "expenses"),
        parseDate(input["today"]),
        parseDate(input["nextPaydayNominal"]),
      );
    case "hysaGap":
      return hysaGap(reqNum(input, "current"), num(input, "target"));
    default:
      throw new Error(`Unknown engine tool: ${name}`);
  }
}
