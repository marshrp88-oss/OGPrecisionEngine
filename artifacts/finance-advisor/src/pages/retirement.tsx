import { useState } from "react";
import {
  useGetRetirement,
  getGetRetirementQueryKey,
  useUpsertRetirement,
  useGetMonthlySavings,
  getGetMonthlySavingsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Save, Info } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { fv, matchGapAnalysis, retirementProjection } from "@/lib/finance-adapter";

/** Future value with monthly compounding via the shared engine `fv`. */
function fvMonthly(pv: number, monthlyPayment: number, annualRate: number, years: number): number {
  return fv(annualRate / 12, years * 12, monthlyPayment, pv);
}

export default function Retirement() {
  const { data: plan, isLoading } = useGetRetirement({ query: { queryKey: getGetRetirementQueryKey() } });
  const { data: monthlySavings } = useGetMonthlySavings({ query: { queryKey: getGetMonthlySavingsQueryKey() } });
  const upsert = useUpsertRetirement();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [form, setForm] = useState<{
    grossSalary: string;
    contributionRate: string;
    matchMultiplier: string;
    employeeContributionCeiling: string;
    currentBalance: string;
    currentAge: string;
    targetAge: string;
    returnAssumption: string;
  } | null>(null);

  if (isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );

  const p = plan ?? {
    id: 0,
    grossSalary: 54000,
    contributionRate: 0.04,
    employerMatchRate: 0.5,
    employerMatchCap: 0.08,
    currentBalance: 2200,
    currentAge: 30,
    targetAge: 65,
    returnAssumption: 0.07,
    updatedAt: new Date().toISOString(),
  };

  // employerMatchRate field repurposed as matchMultiplier (e.g., 0.50 = 50% of employee %)
  // employerMatchCap field repurposed as employee contribution ceiling (e.g., 0.08 = 8% of gross)
  const editValues = form ?? {
    grossSalary: String(p.grossSalary),
    contributionRate: String(p.contributionRate),
    matchMultiplier: String(p.employerMatchRate),
    employeeContributionCeiling: String(p.employerMatchCap),
    currentBalance: String(p.currentBalance),
    currentAge: String(p.currentAge),
    targetAge: String(p.targetAge),
    returnAssumption: String(p.returnAssumption),
  };

  const grossSalary = parseFloat(editValues.grossSalary) || 0;
  const contribRate = parseFloat(editValues.contributionRate) || 0;
  const matchMultiplier = parseFloat(editValues.matchMultiplier) || 0;
  const ceiling = parseFloat(editValues.employeeContributionCeiling) || 0;
  const currentBalance = parseFloat(editValues.currentBalance) || 0;
  const currentAge = parseInt(editValues.currentAge) || 0;
  const targetAge = parseInt(editValues.targetAge) || 65;
  const returnRate = parseFloat(editValues.returnAssumption) || 0.07;

  const yearsToRetirement = Math.max(0, targetAge - currentAge);

  // 401(k) match math via shared engine — single source of truth.
  const matchGap = matchGapAnalysis(grossSalary, contribRate, matchMultiplier, ceiling);
  const matchPctOfGross = matchGap.employerMatchPct;
  const maxMatchPctOfGross = matchGap.maxPossibleMatchPct;
  const annualCaptured = matchGap.annualCaptured;
  const annualAvailable = matchGap.annualAvailable;
  const annualGap = matchGap.annualGap;
  const monthlyGap = matchGap.monthlyGap;
  const matchGapActive = !matchGap.atCeiling && annualGap > 0.01;

  // FV columns: Current / At Match Cap (=ceiling) / Aggressive (12%)
  const monthlyContribAt = (employeePct: number) => {
    const matched = Math.min(employeePct, ceiling) * matchMultiplier;
    return ((grossSalary * employeePct) + (grossSalary * matched)) / 12;
  };

  const fvCurrent = fvMonthly(currentBalance, monthlyContribAt(contribRate), returnRate, yearsToRetirement);
  const fvAtMatchCap = fvMonthly(currentBalance, monthlyContribAt(ceiling), returnRate, yearsToRetirement);
  const fvAggressive = fvMonthly(currentBalance, monthlyContribAt(0.12), returnRate, yearsToRetirement);

  // $1M Target — use the engine's `retirementProjection.million_monthly_needed`
  // so the same canonical PMT formula (and rounding) is used everywhere.
  const projection = retirementProjection(
    grossSalary,
    contribRate,
    currentBalance,
    currentAge,
    targetAge,
    returnRate,
    matchMultiplier,
    ceiling,
  );
  const pmt_needed = projection.million_monthly_needed;
  const requiredSalaryPct = grossSalary > 0 ? (pmt_needed * 12) / grossSalary : 0;

  // Estimated take-home reduction from bumping contribution to ceiling
  const additionalContribPct = Math.max(0, ceiling - contribRate);
  const additionalMonthlyPretax = (grossSalary * additionalContribPct) / 12;
  const marginalRate = 0.285;
  const takeHomeReduction = additionalMonthlyPretax * (1 - marginalRate);

  const handleSave = () => {
    upsert.mutate(
      {
        data: {
          grossSalary,
          contributionRate: contribRate,
          // Persist with original field names (semantics reinterpreted)
          employerMatchRate: matchMultiplier,
          employerMatchCap: ceiling,
          currentBalance,
          currentAge,
          targetAge,
          returnAssumption: returnRate,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetRetirementQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetMonthlySavingsQueryKey() });
          setForm(null);
          toast({ title: "Retirement plan saved" });
        },
      }
    );
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold tracking-tight">Retirement Planning</h1>

      {matchGapActive && (
        <Alert className="border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200">
          <AlertTriangle className="h-5 w-5" />
          <AlertTitle className="font-bold">401(k) Match Gap Active</AlertTitle>
          <AlertDescription className="font-mono text-sm space-y-1 mt-1">
            <div>
              Contributing {formatPercent(contribRate)} vs {formatPercent(ceiling)} employee contribution ceiling.
            </div>
            <div>
              <span className="font-bold">{formatCurrency(annualGap)}/year</span> ({formatCurrency(monthlyGap)}/mo) in
              free employer match uncaptured.
            </div>
            <div>To capture the full match, increase your contribution to {formatPercent(ceiling)} of gross.</div>
            <div className="text-xs text-amber-800/70 dark:text-amber-300/70 pt-1">
              Bumping from {formatPercent(contribRate)} to {formatPercent(ceiling)} adds{" "}
              {formatCurrency(additionalMonthlyPretax)}/mo pre-tax. Estimated take-home reduction:{" "}
              {formatCurrency(takeHomeReduction)}/mo (at 28.5% marginal rate).
            </div>
          </AlertDescription>
        </Alert>
      )}

      {monthlySavings && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Monthly Savings Estimate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono">
                {formatCurrency(monthlySavings.estimatedMonthlySavings)}
              </div>
              <p className="text-xs text-muted-foreground mt-1">After all bills, variable, one-time, forward reserve</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                Savings After Match Bump
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono">{formatCurrency(monthlySavings.savingsAfterMatchBump)}</div>
              <p className="text-xs text-muted-foreground mt-1">If contribution bumped to {formatPercent(ceiling)}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>FV Projections at Retirement (Age {targetAge})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-muted/50 p-4 rounded text-center">
              <div className="text-xs text-muted-foreground uppercase mb-2 font-mono">
                Current ({formatPercent(contribRate)} + {formatPercent(matchPctOfGross)} match)
              </div>
              <div className="text-2xl font-bold font-mono">{formatCurrency(fvCurrent)}</div>
            </div>
            <div className="bg-emerald-50 dark:bg-emerald-950/30 p-4 rounded text-center border-2 border-emerald-500/30">
              <div className="text-xs text-muted-foreground uppercase mb-2 font-mono">
                At Match Cap ({formatPercent(ceiling)} + {formatPercent(maxMatchPctOfGross)} match)
              </div>
              <div className="text-2xl font-bold font-mono text-emerald-700 dark:text-emerald-400">
                {formatCurrency(fvAtMatchCap)}
              </div>
            </div>
            <div className="bg-blue-50 dark:bg-blue-950/30 p-4 rounded text-center">
              <div className="text-xs text-muted-foreground uppercase mb-2 font-mono">
                Aggressive (12% + {formatPercent(maxMatchPctOfGross)} capped match)
              </div>
              <div className="text-2xl font-bold font-mono text-blue-700 dark:text-blue-400">
                {formatCurrency(fvAggressive)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>$1M Target Calculator</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 font-mono text-sm">
            <div className="p-3 bg-muted/50 rounded">
              <div className="text-xs text-muted-foreground uppercase mb-1">Years to Retirement</div>
              <div className="text-xl font-bold">
                {yearsToRetirement} year{yearsToRetirement === 1 ? "" : "s"}
              </div>
            </div>
            <div className="p-3 bg-muted/50 rounded">
              <div className="text-xs text-muted-foreground uppercase mb-1">Required Monthly Contribution</div>
              <div className="text-xl font-bold">{formatCurrency(pmt_needed)}</div>
            </div>
            <div className="p-3 bg-muted/50 rounded">
              <div className="text-xs text-muted-foreground uppercase mb-1">Required Salary %</div>
              <div className="text-xl font-bold">{formatPercent(requiredSalaryPct)}</div>
            </div>
            <div className="p-3 bg-muted/50 rounded">
              <div className="text-xs text-muted-foreground uppercase mb-1">Current Balance</div>
              <div className="text-xl font-bold">{formatCurrency(currentBalance)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Roth IRA</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="flex items-start gap-2 text-muted-foreground">
            <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div>
              Roth IRA opened at Schwab — not yet funded. 2025 contribution deadline has passed. 2026 contribution
              window: Jan 1, 2026 – Apr 15, 2027. Limit: $7,000.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plan Parameters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {(
              [
                ["grossSalary", "Gross Salary ($)"],
                ["contributionRate", "Your Contribution Rate (e.g. 0.04 = 4%)"],
                ["matchMultiplier", "Employer Match Multiplier (e.g. 0.50 = 50% of employee %)"],
                ["employeeContributionCeiling", "Employee Contribution Ceiling (e.g. 0.08 = match up to 8%)"],
                ["currentBalance", "Current Balance ($)"],
                ["currentAge", "Current Age"],
                ["targetAge", "Target Retirement Age"],
                ["returnAssumption", "Return Assumption (e.g. 0.07 = 7%)"],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                <Label className="text-xs">{label}</Label>
                <Input
                  type="number"
                  step="0.0001"
                  value={editValues[key]}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...(prev ?? editValues),
                      [key]: e.target.value,
                    }))
                  }
                  className="font-mono"
                  data-testid={`input-retirement-${key}`}
                />
              </div>
            ))}
          </div>
          <Button onClick={handleSave} disabled={upsert.isPending} data-testid="button-save-retirement">
            <Save className="mr-2 h-4 w-4" />
            Save Parameters
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
