import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useGetBalances,
  getGetBalancesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2 } from "lucide-react";
import { formatCurrency, formatPercent } from "@/lib/utils";
import {
  decisionSandboxCompare,
  PurchaseOption,
  type PurchaseComparisonResult,
} from "@/lib/finance-adapter";

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");
const MAX_OPTIONS = 4;

// Editable form shape (all strings — converted to numbers at compute time).
// annualRate is entered as a percent for humans; we divide by 100 for the engine.
interface OptionForm {
  name: string;
  totalPrice: string;
  downPayment: string;
  annualRatePct: string;
  termMonths: string;
  monthlyAddons: string;
  oneTimeCost: string;
}

const blankOption = (n: number): OptionForm => ({
  name: `Option ${String.fromCharCode(64 + n)}`,
  totalPrice: "",
  downPayment: "",
  annualRatePct: "",
  termMonths: "60",
  monthlyAddons: "",
  oneTimeCost: "",
});

// Sensible starter pair so the comparison is populated on first load.
const SEED: OptionForm[] = [
  { name: "Finance new", totalPrice: "35000", downPayment: "5000", annualRatePct: "6.5", termMonths: "60", monthlyAddons: "150", oneTimeCost: "" },
  { name: "Finance used", totalPrice: "24000", downPayment: "3000", annualRatePct: "7.4", termMonths: "72", monthlyAddons: "120", oneTimeCost: "" },
];

/** Parse a form field to a number, treating blank/garbage as 0 (0 is valid). */
function num(s: string): number {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

interface CycleResp {
  dailyRateRealTime: number;
}
interface DiscretionaryResp {
  billsThisMonth: number;
  variableCap: number;
  baseNetIncome: number;
}

export default function Decisions() {
  const [options, setOptions] = useState<OptionForm[]>(SEED);

  const { data: cycle } = useQuery<CycleResp>({
    queryKey: ["dashboard-cycle"],
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/dashboard/cycle`);
      if (!r.ok) throw new Error("Failed to load cycle");
      return r.json();
    },
  });
  const { data: discretionary } = useQuery<DiscretionaryResp>({
    queryKey: ["dashboard-discretionary"],
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/dashboard/discretionary`);
      if (!r.ok) throw new Error("Failed to load discretionary");
      return r.json();
    },
  });
  const { data: balances } = useGetBalances({ query: { queryKey: getGetBalancesQueryKey() } });

  const ready = cycle && discretionary && balances;

  const updateOption = (i: number, patch: Partial<OptionForm>) =>
    setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  const addOption = () =>
    setOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, blankOption(prev.length + 1)]));
  const removeOption = (i: number) =>
    setOptions((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));

  if (!ready) {
    return (
      <div className="space-y-4 max-w-5xl mx-auto">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // Live context the engine prices each option against.
  const currentDailySafeSpend = cycle.dailyRateRealTime ?? 0;
  const monthlyFixedBills = discretionary.billsThisMonth ?? 0;
  const variableCap = discretionary.variableCap ?? 0;
  const baseNetMonthly = discretionary.baseNetIncome ?? 0;

  // Latest HYSA balance (balances arrive desc by asOfDate, so first wins).
  const hysaBalance = balances.find((b) => b.accountType === "hysa")?.amount ?? 0;

  // The engine does all the math — monthly payment, opportunity cost, runway.
  const purchaseOptions = options.map(
    (o) =>
      new PurchaseOption(
        o.name.trim() || "Option",
        num(o.totalPrice),
        num(o.downPayment),
        num(o.annualRatePct) / 100,
        Math.max(0, Math.round(num(o.termMonths))),
        num(o.monthlyAddons),
        num(o.oneTimeCost),
      ),
  );
  const results: PurchaseComparisonResult[] = decisionSandboxCompare(
    purchaseOptions,
    currentDailySafeSpend,
    monthlyFixedBills,
    variableCap,
    baseNetMonthly,
    hysaBalance,
  );

  const fmtRunway = (m: number) =>
    Number.isFinite(m) ? `${m.toFixed(1)} mo` : "∞";

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Purchase Comparison</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Compare up to {MAX_OPTIONS} financed purchases against your live cash position. Each option is
          priced by the engine using current bills ({formatCurrency(monthlyFixedBills)}/mo), variable cap
          ({formatCurrency(variableCap)}), net income ({formatCurrency(baseNetMonthly)}/mo), and HYSA
          balance ({formatCurrency(hysaBalance)}). Opportunity cost assumes 7% over 10 years on any down payment.
        </p>
      </div>

      {/* Option inputs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {options.map((o, i) => (
          <Card key={i} data-testid={`option-card-${i}`}>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <Input
                value={o.name}
                onChange={(e) => updateOption(i, { name: e.target.value })}
                className="h-8 font-semibold max-w-[60%]"
                data-testid={`input-name-${i}`}
              />
              {options.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => removeOption(i)}
                  data-testid={`button-remove-${i}`}
                  aria-label="Remove option"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <Field label="Total price" value={o.totalPrice} onChange={(v) => updateOption(i, { totalPrice: v })} testid={`input-price-${i}`} />
              <Field label="Down payment" value={o.downPayment} onChange={(v) => updateOption(i, { downPayment: v })} testid={`input-down-${i}`} />
              <Field label="APR %" value={o.annualRatePct} onChange={(v) => updateOption(i, { annualRatePct: v })} testid={`input-apr-${i}`} />
              <Field label="Term (months)" value={o.termMonths} onChange={(v) => updateOption(i, { termMonths: v })} testid={`input-term-${i}`} />
              <Field label="Monthly add-ons" value={o.monthlyAddons} onChange={(v) => updateOption(i, { monthlyAddons: v })} testid={`input-addons-${i}`} hint="insurance, fuel, etc." />
              <Field label="One-time cost" value={o.oneTimeCost} onChange={(v) => updateOption(i, { oneTimeCost: v })} testid={`input-onetime-${i}`} hint="if not financed" />
            </CardContent>
          </Card>
        ))}
      </div>

      {options.length < MAX_OPTIONS && (
        <Button variant="outline" onClick={addOption} data-testid="button-add-option">
          <Plus className="h-4 w-4 mr-2" /> Add option
        </Button>
      )}

      {/* Results comparison */}
      <Card data-testid="comparison-results">
        <CardHeader>
          <CardTitle>Comparison</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-4 font-medium text-muted-foreground">Metric</th>
                {results.map((r, i) => (
                  <th key={i} className="py-2 px-3 font-semibold text-right">{r.name}</th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono">
              <MetricRow label="Monthly payment" results={results} render={(r) => formatCurrency(r.monthlyPayment)} />
              <MetricRow label="Total monthly cost" results={results} render={(r) => formatCurrency(r.totalMonthlyCost)} bold />
              <MetricRow label="Daily lifestyle cost" results={results} render={(r) => formatCurrency(r.dailyLifestyleCost)} />
              <MetricRow label="New daily safe-spend" results={results} render={(r) => formatCurrency(r.newDailySafeSpend)} warnNegative />
              <MetricRow label="Annual cost" results={results} render={(r) => formatCurrency(r.annualCost)} />
              <MetricRow label="Interest + opportunity cost" results={results} render={(r) => formatCurrency(r.totalInterestWithOpportunityCost)} />
              <MetricRow label="HYSA after down payment" results={results} render={(r) => formatCurrency(r.hysaAfterDown)} warnNegative />
              <MetricRow label="HYSA runway" results={results} render={(r) => fmtRunway(r.hysaRunwayMonths)} />
              <MetricRow label="% of annual income" results={results} render={(r) => formatPercent(r.incomeCoveragePct)} />
              <tr>
                <td className="py-3 pr-4 font-sans text-muted-foreground align-middle">Affordability</td>
                {results.map((r, i) => (
                  <td key={i} className="py-3 px-3 text-right">
                    <AffordabilityBadge value={r.affordability} />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  testid,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testid: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 font-mono"
        data-testid={testid}
      />
      {hint && <p className="text-[10px] text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

function MetricRow({
  label,
  results,
  render,
  bold,
  warnNegative,
}: {
  label: string;
  results: PurchaseComparisonResult[];
  render: (r: PurchaseComparisonResult) => string;
  bold?: boolean;
  warnNegative?: boolean;
}) {
  return (
    <tr className="border-b border-border/40">
      <td className="py-2 pr-4 font-sans text-muted-foreground">{label}</td>
      {results.map((r, i) => {
        const text = render(r);
        const negative = warnNegative && text.trim().startsWith("-");
        return (
          <td
            key={i}
            className={`py-2 px-3 text-right ${bold ? "font-bold" : ""} ${negative ? "text-destructive" : ""}`}
          >
            {text}
          </td>
        );
      })}
    </tr>
  );
}

function AffordabilityBadge({ value }: { value: string }) {
  const variant =
    value === "Yes"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
      : value === "Tight"
      ? "bg-amber-400/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
      : "bg-destructive/15 text-destructive border-destructive/30";
  return (
    <Badge variant="outline" className={variant} data-testid="affordability-badge">
      {value}
    </Badge>
  );
}
