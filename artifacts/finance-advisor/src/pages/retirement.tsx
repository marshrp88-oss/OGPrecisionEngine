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
import { AlertTriangle, Save } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatPercent } from "@/lib/utils";

function computeFV(pv: number, pmt: number, rate: number, years: number): number {
  if (rate === 0) return pv + pmt * years * 12;
  const monthlyRate = rate / 12;
  const months = years * 12;
  return pv * Math.pow(1 + monthlyRate, months) + pmt * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
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
    employerMatchRate: string;
    employerMatchCap: string;
    currentBalance: string;
    currentAge: string;
    targetAge: string;
    returnAssumption: string;
  } | null>(null);

  if (isLoading) return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );

  const p = plan ?? {
    id: 0, grossSalary: 54000, contributionRate: 0.03, employerMatchRate: 0.04,
    employerMatchCap: 0.04, currentBalance: 1550, currentAge: 30, targetAge: 65,
    returnAssumption: 0.07, updatedAt: new Date().toISOString(),
  };

  const editValues = form ?? {
    grossSalary: String(p.grossSalary),
    contributionRate: String(p.contributionRate),
    employerMatchRate: String(p.employerMatchRate),
    employerMatchCap: String(p.employerMatchCap),
    currentBalance: String(p.currentBalance),
    currentAge: String(p.currentAge),
    targetAge: String(p.targetAge),
    returnAssumption: String(p.returnAssumption),
  };

  const grossSalary = parseFloat(editValues.grossSalary) || 0;
  const contribRate = parseFloat(editValues.contributionRate) || 0;
  const matchRate = parseFloat(editValues.employerMatchRate) || 0;
  const matchCap = parseFloat(editValues.employerMatchCap) || 0;
  const currentBalance = parseFloat(editValues.currentBalance) || 0;
  const currentAge = parseInt(editValues.currentAge) || 0;
  const targetAge = parseInt(editValues.targetAge) || 65;
  const returnRate = parseFloat(editValues.returnAssumption) || 0.07;

  const yearsToRetirement = Math.max(0, targetAge - currentAge);
  const employeeContrib = (grossSalary * contribRate) / 12;
  const employerContrib = (grossSalary * Math.min(contribRate, matchCap)) / 12;
  const totalMonthlyContrib = employeeContrib + employerContrib;

  const matchGapActive = contribRate < matchCap;
  const matchGapContrib = grossSalary * (matchCap - contribRate);

  const fvCurrent = computeFV(currentBalance, totalMonthlyContrib, returnRate, yearsToRetirement);
  const fvAtMatchCap = computeFV(
    currentBalance,
    ((grossSalary * matchCap) + (grossSalary * matchRate)) / 12,
    returnRate,
    yearsToRetirement
  );
  const fvAggressive = computeFV(
    currentBalance,
    ((grossSalary * 0.10) + employerContrib) / 12,
    returnRate,
    yearsToRetirement
  );

  const TARGET = 1_000_000;
  const pmt_needed = TARGET > currentBalance * Math.pow(1 + returnRate / 12, yearsToRetirement * 12)
    ? (TARGET - currentBalance * Math.pow(1 + returnRate / 12, yearsToRetirement * 12)) *
      (returnRate / 12) / (Math.pow(1 + returnRate / 12, yearsToRetirement * 12) - 1)
    : 0;

  const requiredSalaryPct = grossSalary > 0 ? (pmt_needed * 12) / grossSalary : 0;

  const handleSave = () => {
    upsert.mutate({
      data: {
        grossSalary: parseFloat(editValues.grossSalary),
        contributionRate: parseFloat(editValues.contributionRate),
        employerMatchRate: parseFloat(editValues.employerMatchRate),
        employerMatchCap: parseFloat(editValues.employerMatchCap),
        currentBalance: parseFloat(editValues.currentBalance),
        currentAge: parseInt(editValues.currentAge),
        targetAge: parseInt(editValues.targetAge),
        returnAssumption: parseFloat(editValues.returnAssumption),
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetRetirementQueryKey() });
        setForm(null);
        toast({ title: "Retirement plan saved" });
      },
    });
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold tracking-tight">Retirement Planning</h1>

      {matchGapActive && (
        <Alert variant="destructive" className="border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200">
          <AlertTriangle className="h-5 w-5" />
          <AlertTitle className="font-bold">401(k) Match Gap Active</AlertTitle>
          <AlertDescription>
            Contributing {formatPercent(contribRate)} vs {formatPercent(matchCap)} match cap.{" "}
            {formatCurrency(matchGapContrib)}/year ({formatCurrency(matchGapContrib / 12)}/mo) in free employer match uncaptured.
          </AlertDescription>
        </Alert>
      )}

      {monthlySavings && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Monthly Savings Estimate</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono">{formatCurrency(monthlySavings.estimatedMonthlySavings)}</div>
              {monthlySavings.canAffordMatchBump && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">Can afford 401(k) match bump</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Savings After Match Bump</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono">{formatCurrency(monthlySavings.savingsAfterMatchBump)}</div>
              <p className="text-xs text-muted-foreground mt-1">If contribution bumped to {formatPercent(matchCap)}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="md:col-span-3">
          <CardHeader>
            <CardTitle>FV Projections at Retirement (Age {targetAge})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-muted/50 p-4 rounded text-center">
                <div className="text-xs text-muted-foreground uppercase mb-2">Current ({formatPercent(contribRate)})</div>
                <div className="text-2xl font-bold font-mono">{formatCurrency(fvCurrent)}</div>
              </div>
              <div className="bg-emerald-50 dark:bg-emerald-950/30 p-4 rounded text-center border-2 border-emerald-500/30">
                <div className="text-xs text-muted-foreground uppercase mb-2">At Match Cap ({formatPercent(matchCap)})</div>
                <div className="text-2xl font-bold font-mono text-emerald-700 dark:text-emerald-400">{formatCurrency(fvAtMatchCap)}</div>
              </div>
              <div className="bg-blue-50 dark:bg-blue-950/30 p-4 rounded text-center">
                <div className="text-xs text-muted-foreground uppercase mb-2">Aggressive (10%)</div>
                <div className="text-2xl font-bold font-mono text-blue-700 dark:text-blue-400">{formatCurrency(fvAggressive)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>$1M Target Calculator</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 font-mono text-sm">
            <div className="p-3 bg-muted/50 rounded">
              <div className="text-xs text-muted-foreground uppercase mb-1">Years to Retirement</div>
              <div className="text-xl font-bold">{yearsToRetirement} years</div>
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
          <CardTitle>Plan Parameters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {Object.entries({
              grossSalary: "Gross Salary ($)",
              contributionRate: "Your Contribution Rate",
              employerMatchRate: "Employer Match Rate",
              employerMatchCap: "Match Cap",
              currentBalance: "Current Balance ($)",
              currentAge: "Current Age",
              targetAge: "Target Retirement Age",
              returnAssumption: "Return Assumption",
            }).map(([key, label]) => (
              <div key={key}>
                <Label className="text-xs">{label}</Label>
                <Input
                  type="number"
                  step="0.0001"
                  value={editValues[key as keyof typeof editValues]}
                  onChange={(e) => setForm((prev) => ({
                    ...(prev ?? editValues),
                    [key]: e.target.value,
                  }))}
                  className="font-mono"
                  data-testid={`input-retirement-${key}`}
                />
              </div>
            ))}
          </div>
          <Button onClick={handleSave} disabled={upsert.isPending} data-testid="button-save-retirement">
            <Save className="mr-2 h-4 w-4" />Save Parameters
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
