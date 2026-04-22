import {
  useGetDashboardCycle,
  getGetDashboardCycleQueryKey,
  useCreateBalance,
  useGetMonthlySavings,
  getGetMonthlySavingsQueryKey,
  useGetBills,
  getGetBillsQueryKey,
  useGetVariableSpend,
  getGetVariableSpendQueryKey,
  useCreateVariableSpendEntry,
  useGetAssumptions,
  getGetAssumptionsQueryKey,
  useUpdateAssumption,
  useGetOneTimeExpenses,
  getGetOneTimeExpensesQueryKey,
  useUpdateOneTimeExpense,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { AlertTriangle, RefreshCw, FlaskConical, CheckCircle2, Plus, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { IntegrityStatusBanner } from "@/components/integrity-status-banner";

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

interface DiscretionaryResp {
  discretionaryThisMonth: number;
  monthEnd: string;
  checking: number;
  remainingPaychecksThisMonth: number;
  paychecksRemainingCount: number;
  baseNetIncome: number;
  confirmedCommissionUnreceived: number;
  confirmedCommissionAlready: number;
  totalInflowsAvailable: number;
  billsRemainingThisMonth: number;
  billsRemainingDetail: { id: number; name: string; amount: number; dueDay: number }[];
  oneTimeDatedThisMonth: number;
  oneTimeUndatedAdvisory: number;
  variableCap: number;
  variableSpentThisMonth: number;
  variableRemainingThisMonth: number;
  quicksilverBalanceOwed: number;
  quicksilverAccruedThisMonth: number;
  minimumCushion: number;
  totalReservationsRequired: number;
  safeToSpend: number;
  cycleStatus: string;
  discipline?: {
    fixedMonthlyTotal: number;
    fixedRatio: number;
    fixedRatioStatus: "green" | "amber" | "red";
    variableBurnPace: number;
    variableBurnPaceStatus: "green" | "amber" | "red";
    expectedVariableByNow: number;
    savingsRate: number;
    savingsRateStatus: "green" | "amber" | "red";
    dayOfMonth: number;
    daysInMonth: number;
  };
}

interface IntegritySummary {
  overall: "pass" | "warn" | "fail";
  failCount: number;
  warnCount: number;
  checks: { name: string; status: "pass" | "warn" | "fail"; detail: string }[];
}

function paydayCountdownLabel(days: number | null | undefined, paydayIso: string | null | undefined): string {
  if (days === null || days === undefined) return "Payday unknown";
  if (days === 0) return "Today is payday";
  if (days === 1) return `1 day until payday${paydayIso ? ` (${formatDate(paydayIso)})` : ""}`;
  return `${days} days until payday${paydayIso ? ` (${formatDate(paydayIso)})` : ""}`;
}

export default function Dashboard() {
  const { data: cycle, isLoading, error } = useGetDashboardCycle({ query: { queryKey: getGetDashboardCycleQueryKey() } });
  const { data: savings } = useGetMonthlySavings({ query: { queryKey: getGetMonthlySavingsQueryKey() } });
  const { data: bills } = useGetBills({ query: { queryKey: getGetBillsQueryKey() } });

  const { data: discretionary } = useQuery<DiscretionaryResp>({
    queryKey: ["dashboard-discretionary"],
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/dashboard/discretionary`);
      if (!r.ok) throw new Error("Failed to load discretionary");
      return r.json();
    },
  });

  const { data: integrity } = useQuery<IntegritySummary>({
    queryKey: ["dashboard-integrity"],
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/dashboard/integrity-summary`);
      if (!r.ok) throw new Error("Failed to load integrity");
      return r.json();
    },
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (error || !cycle) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>Could not load dashboard data.</AlertDescription>
      </Alert>
    );
  }

  const isStale = cycle.isStale;
  const billsInCycle = (bills ?? []).filter((b) => b.countsThisCycle);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <IntegrityStatusBanner />
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cycle Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm font-mono">
            {paydayCountdownLabel(cycle.daysUntilPayday, cycle.nextPayday)}
          </p>
        </div>
        <UpdateBalanceDialog />
      </div>

      {isStale && (
        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive-foreground">
          <AlertTriangle className="h-5 w-5" />
          <AlertTitle className="text-lg font-bold">Stale Data Warning</AlertTitle>
          <AlertDescription className="font-mono text-sm mt-1">
            Balance last updated {cycle.daysSinceUpdate} days ago. Cycle calculations may be unreliable. Update your checking balance to restore precision.
          </AlertDescription>
        </Alert>
      )}

      {cycle.paydayRisk && (
        <Alert className="bg-amber-50 dark:bg-amber-950/30 border-amber-500/30">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-900 dark:text-amber-200">Payday on Weekend</AlertTitle>
          <AlertDescription className="text-amber-900/80 dark:text-amber-300/80 text-sm">
            Nominal payday falls on a weekend. Effective deposit is the prior Friday.
          </AlertDescription>
        </Alert>
      )}

      {integrity && integrity.overall !== "pass" && (
        <Alert
          variant={integrity.overall === "fail" ? "destructive" : "default"}
          className={integrity.overall === "warn" ? "bg-amber-50 dark:bg-amber-950/30 border-amber-500/30" : ""}
          data-testid="banner-integrity"
        >
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            Session Integrity: {integrity.overall.toUpperCase()}
            {integrity.failCount > 0 && ` (${integrity.failCount} failure${integrity.failCount === 1 ? "" : "s"})`}
            {integrity.warnCount > 0 && ` (${integrity.warnCount} warning${integrity.warnCount === 1 ? "" : "s"})`}
          </AlertTitle>
          <AlertDescription className="text-sm mt-1">
            <ul className="space-y-0.5 mt-1 font-mono text-xs">
              {integrity.checks.filter((c) => c.status !== "pass").map((c, idx) => (
                <li key={idx}>• {c.name}: {c.detail}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Big status banner — playbook traffic light */}
      <div
        className={`rounded-xl border-2 px-6 py-4 flex items-center justify-between gap-4 ${
          cycle.status === "GREEN"
            ? "border-success/40 bg-success/10"
            : cycle.status === "YELLOW"
              ? "border-warning/40 bg-warning/10"
              : "border-destructive/40 bg-destructive/10"
        }`}
        data-testid="banner-cycle-status"
      >
        <div className="flex items-center gap-4">
          <div
            className={`h-3 w-3 rounded-full ${
              cycle.status === "GREEN" ? "bg-success" : cycle.status === "YELLOW" ? "bg-warning" : "bg-destructive"
            } animate-pulse`}
          />
          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground font-medium">Cycle Status</p>
            <p className="text-2xl font-bold tracking-tight">
              {cycle.status === "GREEN"
                ? "GREEN — Spend safely"
                : cycle.status === "YELLOW"
                  ? "YELLOW — Tighten variable spend"
                  : "RED — Hold all discretionary spend"}
            </p>
          </div>
        </div>
        <div className="text-right font-mono">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Safe to Spend</p>
          <p className="text-3xl font-bold tracking-tighter">{formatCurrency(cycle.safeToSpend)}</p>
        </div>
      </div>

      {/* Top hero: Safe to Spend + Discretionary side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border-2 shadow-xl overflow-hidden relative">
          <div className={`absolute top-0 left-0 w-2 h-full ${cycle.status === "GREEN" ? "bg-success" : cycle.status === "YELLOW" ? "bg-warning" : "bg-destructive"}`} />
          <CardContent className="p-6 md:p-8 pl-8 md:pl-10">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-2">Safe to Spend</p>
            <h2 className="text-5xl md:text-6xl font-bold tracking-tighter font-mono">{formatCurrency(cycle.safeToSpend)}</h2>
            <div className="flex items-center gap-3 mt-3">
              <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full border ${cycle.status === "GREEN" ? "bg-success/20 text-success border-success/30" : cycle.status === "YELLOW" ? "bg-warning/20 text-warning border-warning/30" : "bg-destructive/20 text-destructive border-destructive/30"}`}>{cycle.status}</span>
              <span className="text-xs text-muted-foreground font-mono">Daily rate {formatCurrency(cycle.dailyRateRealTime)}/day</span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-2 shadow-xl overflow-hidden">
          <CardContent className="p-6 md:p-8">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-2">Discretionary This Month</p>
            <h2 className="text-5xl md:text-6xl font-bold tracking-tighter font-mono" data-testid="text-discretionary-month">
              {discretionary ? formatCurrency(discretionary.discretionaryThisMonth) : "—"}
            </h2>
            {discretionary && (
              <>
                <p className="text-xs text-muted-foreground font-mono mt-3">
                  Through {formatDate(discretionary.monthEnd)} — after bills, one-times, gas+food cap, and CC payoff
                </p>
                <div className="grid grid-cols-2 gap-2 mt-3 text-xs font-mono">
                  <div className="rounded border border-border/40 px-2 py-1">
                    <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Variable cap left</div>
                    <div className="font-bold">{formatCurrency(discretionary.variableRemainingThisMonth)} <span className="text-muted-foreground font-normal">of {formatCurrency(discretionary.variableCap)}</span></div>
                  </div>
                  <div className="rounded border border-border/40 px-2 py-1">
                    <div className="text-[10px] uppercase text-muted-foreground tracking-wider">CC balance owed</div>
                    <div className="font-bold">{formatCurrency(discretionary.quicksilverBalanceOwed)}</div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Checking</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{formatCurrency(cycle.checkingBalance)}</div>
            <p className="text-xs text-muted-foreground mt-1">Updated {cycle.daysSinceUpdate} {cycle.daysSinceUpdate === 1 ? "day" : "days"} ago</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Required Hold</CardTitle></CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold font-mono ${cycle.totalRequiredHold === 0 ? "text-muted-foreground" : ""}`}>{formatCurrency(cycle.totalRequiredHold)}</div>
            <p className="text-xs text-muted-foreground mt-1">{billsInCycle.length} bill{billsInCycle.length === 1 ? "" : "s"} in cycle</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Forward Reserve</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{formatCurrency(cycle.forwardReserve)}</div>
            <p className="text-xs text-muted-foreground mt-1">Next-month 1st-7th + 7d variable</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Monthly Savings Est.</CardTitle></CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{savings ? formatCurrency(savings.estimatedMonthlySavings) : "—"}</div>
            <p className="text-xs text-muted-foreground mt-1">Forward-looking after reserve</p>
          </CardContent>
        </Card>
      </div>

      {discretionary?.discipline && <DisciplineCard d={discretionary.discipline} />}

      <CycleSettingsInline />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium uppercase tracking-wider">Bills In Current Cycle</CardTitle></CardHeader>
          <CardContent>
            {billsInCycle.length === 0 ? (
              <p className="text-sm text-muted-foreground font-mono">None. All Include=TRUE bills due before the next payday have cleared.</p>
            ) : (
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs uppercase">
                    <th className="text-left py-2">Bill</th>
                    <th className="text-right py-2">Day</th>
                    <th className="text-right py-2">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {billsInCycle.map((b) => (
                    <tr key={b.id} className="border-b border-border/40">
                      <td className="py-2 truncate max-w-[120px]">{b.name}</td>
                      <td className="text-right py-2">{b.dueDay}</td>
                      <td className="text-right py-2 font-bold">{formatCurrency(b.amount)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td colSpan={2} className="py-2 text-right">Total</td>
                    <td className="text-right py-2">{formatCurrency(cycle.billsDueBeforePayday)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <OneTimeInlineWidget />

        <VariableSpendWidget />
      </div>

      <Accordion type="multiple" className="w-full space-y-3">
        <AccordionItem value="math" className="border rounded-xl px-4 bg-card">
          <AccordionTrigger className="hover:no-underline font-mono text-sm py-4">
            <span className="flex items-center gap-2"><FlaskConical className="h-4 w-4" />Safe to Spend — math breakdown</span>
          </AccordionTrigger>
          <AccordionContent className="pt-2 pb-6 space-y-3 font-mono text-sm">
            <Row label="Checking Balance" value={cycle.checkingBalance} />
            <Row label="− Bills Due Before Payday" value={cycle.billsDueBeforePayday} negative />
            <Row label="− Pending Holds" value={cycle.pendingHoldsReserve} negative />
            <Row label="− Minimum Cushion" value={cycle.minimumCushion} negative />
            <Row label="− One-Time Costs in Cycle" value={cycle.oneTimeDueBeforePayday} negative />
            <Row label="= Safe to Spend" value={cycle.safeToSpend} bold />
            <p className="text-xs text-muted-foreground pt-2 border-t border-border/30 mt-2">
              Forward Reserve ({formatCurrency(cycle.forwardReserve)}) is excluded from Safe to Spend per spec — it factors into Monthly Savings only.
            </p>
          </AccordionContent>
        </AccordionItem>

        {savings && (
          <AccordionItem value="savings" className="border rounded-xl px-4 bg-card">
            <AccordionTrigger className="hover:no-underline font-mono text-sm py-4">
              <span className="flex items-center gap-2"><FlaskConical className="h-4 w-4" />Monthly Savings — math breakdown</span>
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-6 space-y-3 font-mono text-sm">
              <Row label="Base Net Income" value={savings.baseNetIncome} />
              <Row label="+ Confirmed Commission This Month" value={savings.confirmedCommission} />
              <Row label="= Total Month Income" value={savings.totalMonthIncome} bold />
              <Row label="− Full-Month Fixed Bills (Include=TRUE)" value={savings.fullMonthFixedBills} negative />
              <Row label="− Variable Spend (prorated remaining)" value={savings.remainingVariableSpendProrated} negative />
              <Row label="− Known One-Time Costs (unpaid)" value={savings.knownOneTimeCosts} negative />
              <Row label="− QuickSilver Balance Owed (manual CC payoff)" value={(savings as unknown as { quicksilverBalanceOwed?: number }).quicksilverBalanceOwed ?? 0} negative />
              <Row label="− Forward Reserve" value={savings.forwardReserve} negative />
              <Row label="= Estimated Monthly Savings" value={savings.estimatedMonthlySavings} bold />
              <p className="text-[10px] text-muted-foreground italic pt-1">
                Context: QuickSilver charges this month total {formatCurrency(savings.quicksilverAccrual)} (logged gas/food on card). They are already inside the variable-cap reservation; only the carry-over balance owed is reserved separately.
              </p>
              {savings.matchGapActive && (
                <div className="mt-3 pt-3 border-t border-border/30">
                  <p className="text-amber-700 dark:text-amber-400">401(k) Match Gap Active: {formatCurrency(savings.monthlyMatchGapCost)}/mo to capture full match.</p>
                  <p className="text-xs text-muted-foreground mt-1">Savings after match bump: {formatCurrency(savings.savingsAfterMatchBump)} ({savings.canAffordMatchBump ? "affordable" : "would tighten cycle"})</p>
                </div>
              )}
            </AccordionContent>
          </AccordionItem>
        )}

        {discretionary && (
          <AccordionItem value="discretionary" className="border rounded-xl px-4 bg-card">
            <AccordionTrigger className="hover:no-underline font-mono text-sm py-4">
              <span className="flex items-center gap-2"><FlaskConical className="h-4 w-4" />Discretionary This Month — math breakdown</span>
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-6 space-y-3 font-mono text-sm">
              <p className="text-xs text-muted-foreground italic pb-1">
                Horizon: today through {formatDate(discretionary.monthEnd)}. Mirrors the workbook B62 model, reframed as remaining spending capability.
              </p>
              <Row label="Checking Balance" value={discretionary.checking} />
              <Row label={`+ Remaining Paychecks This Month (${discretionary.paychecksRemainingCount} × ${formatCurrency(discretionary.baseNetIncome / 2)})`} value={discretionary.remainingPaychecksThisMonth} />
              <Row label="+ Confirmed Commission (not yet received)" value={discretionary.confirmedCommissionUnreceived} />
              <Row label="= Total Inflows Available" value={discretionary.totalInflowsAvailable} bold />
              <Row label="− Bills Remaining This Month (Include=TRUE)" value={discretionary.billsRemainingThisMonth} negative />
              <Row label="− One-Time Expenses dated through month end" value={discretionary.oneTimeDatedThisMonth} negative />
              <Row label="− Variable Cap Remaining (gas + food reserve)" value={discretionary.variableRemainingThisMonth} negative />
              <Row label="− QuickSilver Balance Owed (CC payoff)" value={discretionary.quicksilverBalanceOwed} negative />
              <Row label="− Minimum Cushion" value={discretionary.minimumCushion} negative />
              <Row label="= Discretionary This Month" value={discretionary.discretionaryThisMonth} bold />

              <div className="pt-3 border-t border-border/30 space-y-2 mt-2">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Context</p>
                <Row label="Variable spent this month (logged gas + food)" value={discretionary.variableSpentThisMonth} />
                <Row label="Of which charged on QuickSilver this month" value={discretionary.quicksilverAccruedThisMonth} />
                <Row label="Confirmed commission already received this month" value={discretionary.confirmedCommissionAlready} />
                <Row label="Cycle Safe-to-Spend (paycheck horizon, for reference)" value={discretionary.safeToSpend} />
                {discretionary.oneTimeUndatedAdvisory > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400 pt-2">
                    Advisory: {formatCurrency(discretionary.oneTimeUndatedAdvisory)} of one-time expenses are unpaid without a due date — set due dates so they're reserved.
                  </p>
                )}
                {discretionary.billsRemainingDetail.length > 0 && (
                  <div className="pt-2">
                    <p className="text-xs text-muted-foreground mb-1">Remaining bills this month:</p>
                    <ul className="text-xs space-y-0.5">
                      {discretionary.billsRemainingDetail.map((b) => (
                        <li key={b.id} className="flex justify-between">
                          <span>{b.name} (day {b.dueDay})</span>
                          <span>{formatCurrency(b.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>
    </div>
  );
}

function Row({ label, value, negative, bold }: { label: string; value: number; negative?: boolean; bold?: boolean }) {
  return (
    <div className={`flex justify-between py-1 ${bold ? "border-t-2 border-border pt-2 font-bold" : "border-b border-border/40"} ${negative ? "text-destructive" : ""}`}>
      <span className={negative ? "" : "text-muted-foreground"}>{label}</span>
      <span>{formatCurrency(value)}</span>
    </div>
  );
}

function CycleSettingsInline() {
  const { data: assumps } = useGetAssumptions({ query: { queryKey: getGetAssumptionsQueryKey() } });
  const updateMut = useUpdateAssumption();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!assumps) return;
    const next: Record<string, string> = {};
    for (const key of ["minimum_cushion", "pending_holds_reserve", "alert_threshold", "variable_spend_until_payday", "quicksilver_balance_owed"]) {
      const a = assumps.find((x) => x.key === key);
      if (a && drafts[key] === undefined) next[key] = a.value;
    }
    if (Object.keys(next).length > 0) setDrafts((d) => ({ ...next, ...d }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assumps]);

  const save = (key: string) => {
    const val = drafts[key];
    if (val === undefined) return;
    updateMut.mutate({ key, data: { value: val } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAssumptionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
        toast({ title: `Saved: ${key}` });
      },
    });
  };

  const fields: { key: string; label: string; help: string }[] = [
    { key: "minimum_cushion", label: "Min Cushion", help: "Always-hold reserve" },
    { key: "pending_holds_reserve", label: "Pending Holds", help: "In-flight charges buffer" },
    { key: "alert_threshold", label: "Yellow Threshold", help: "Triggers YELLOW status" },
    { key: "variable_spend_until_payday", label: "Spent Variable", help: "Already-spent this cycle" },
    { key: "quicksilver_balance_owed", label: "QuickSilver Balance", help: "CC balance to pay mid-next-month" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-medium uppercase tracking-wider">Cycle Settings (inline edit)</CardTitle></CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {fields.map((f) => (
            <div key={f.key} className="grid gap-1">
              <Label className="text-xs">{f.label}</Label>
              <div className="flex gap-1">
                <Input
                  className="font-mono text-sm h-9"
                  value={drafts[f.key] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                  data-testid={`input-cycle-${f.key}`}
                />
                <Button size="sm" variant="outline" onClick={() => save(f.key)} data-testid={`button-save-cycle-${f.key}`}>Save</Button>
              </div>
              <p className="text-[10px] text-muted-foreground">{f.help}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function VariableSpendWidget() {
  const { data: vs } = useGetVariableSpend(undefined, { query: { queryKey: getGetVariableSpendQueryKey() } });
  const createMut = useCreateVariableSpendEntry();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    weekOf: new Date().toISOString().split("T")[0],
    amount: "",
    category: "groceries",
    quicksilver: true,
    notes: "",
  });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const monthEntries = (vs ?? []).filter((v) => new Date(v.weekOf as unknown as string) >= monthStart);
  const monthTotal = monthEntries.reduce((s, v) => s + v.amount, 0);
  const quicksilverTotal = monthEntries.filter((v) => v.quicksilver).reduce((s, v) => s + v.amount, 0);
  const recent = (vs ?? []).slice(0, 6);

  const handleSave = () => {
    const amt = parseFloat(form.amount);
    if (isNaN(amt) || amt <= 0) { toast({ title: "Amount required", variant: "destructive" }); return; }
    createMut.mutate({
      data: {
        weekOf: form.weekOf,
        amount: amt,
        category: form.category || null,
        quicksilver: form.quicksilver,
        notes: form.notes.trim() || null,
      },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetVariableSpendQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMonthlySavingsQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
        setOpen(false);
        setForm((f) => ({ ...f, amount: "", notes: "" }));
        toast({ title: "Variable entry logged" });
      },
    });
  };

  return (
    <Card>
      <CardHeader className="pb-2 flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium uppercase tracking-wider">Variable Spend Log</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" data-testid="button-add-variable"><Plus className="h-3 w-3 mr-1" />Log</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Log Variable Spend</DialogTitle></DialogHeader>
            <div className="grid gap-3 py-2">
              <div><Label>Date</Label><Input type="date" value={form.weekOf} onChange={(e) => setForm({ ...form, weekOf: e.target.value })} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Amount</Label><Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="input-variable-amount" /></div>
                <div><Label>Category</Label>
                  <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    <option value="groceries">Groceries</option>
                    <option value="dining">Dining</option>
                    <option value="fuel">Fuel</option>
                    <option value="household">Household</option>
                    <option value="entertainment">Entertainment</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center justify-between rounded border p-3">
                <div><Label>Charged on QuickSilver</Label><p className="text-xs text-muted-foreground">Accrues into Monthly Savings statement reserve.</p></div>
                <Switch checked={form.quicksilver} onCheckedChange={(v) => setForm({ ...form, quicksilver: v })} />
              </div>
              <div><Label>Notes</Label><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={createMut.isPending} data-testid="button-save-variable">Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="rounded border p-2">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Logged this month</div>
            <div className="text-xl font-bold font-mono">{formatCurrency(monthTotal)}</div>
          </div>
          <div className="rounded border p-2">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wider">QuickSilver blind spot</div>
            <div className="text-xl font-bold font-mono">{formatCurrency(quicksilverTotal)}</div>
          </div>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries yet. Log spend to track variable burn rate.</p>
        ) : (
          <ul className="space-y-1 text-sm font-mono">
            {recent.map((v) => (
              <li key={v.id} className="flex items-center justify-between py-1 border-b border-border/40" data-testid={`row-variable-${v.id}`}>
                <span className="flex items-center gap-2 min-w-0">
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">{formatDate(v.weekOf as unknown as string)}</span>
                  <span className="text-xs capitalize">{v.category ?? ""}</span>
                  {v.quicksilver && <Badge variant="secondary" className="text-[10px] px-1 py-0">QS</Badge>}
                </span>
                <span>{formatCurrency(v.amount)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[10px] text-muted-foreground mt-2 italic">QuickSilver accrual is your statement reserve — it's already deducted from Monthly Savings even before the bill posts.</p>
      </CardContent>
    </Card>
  );
}

function OneTimeInlineWidget() {
  const { data: oneTimes } = useGetOneTimeExpenses({ query: { queryKey: getGetOneTimeExpensesQueryKey() } });
  const updateOte = useUpdateOneTimeExpense();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const unpaid = (oneTimes ?? []).filter((o) => !o.paid);
  const datedThisMonth = unpaid.filter((o) => {
    if (!o.dueDate) return false;
    const d = new Date(o.dueDate as unknown as string);
    return d >= today && d <= monthEnd;
  });
  const undated = unpaid.filter((o) => !o.dueDate);
  const totalThisMonth = datedThisMonth.reduce((s, o) => s + o.amount, 0);
  const totalUndated = undated.reduce((s, o) => s + o.amount, 0);

  const togglePaid = (id: number, paid: boolean) => {
    updateOte.mutate({ id, data: { paid: !paid } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetOneTimeExpensesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMonthlySavingsQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
        toast({ title: paid ? "Marked unpaid" : "Marked paid" });
      },
    });
  };

  return (
    <Card>
      <CardHeader className="pb-2 flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium uppercase tracking-wider">One-Time This Month</CardTitle>
        <a href="one-time" className="text-xs text-muted-foreground hover:text-foreground">All →</a>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 mb-3 text-sm font-mono">
          <div className="rounded border p-2">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Dated this month</div>
            <div className="text-lg font-bold">{formatCurrency(totalThisMonth)}</div>
          </div>
          <div className="rounded border p-2">
            <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Undated unpaid</div>
            <div className={`text-lg font-bold ${totalUndated > 0 ? "text-warning" : ""}`}>{formatCurrency(totalUndated)}</div>
          </div>
        </div>
        {unpaid.length === 0 ? (
          <p className="text-sm text-muted-foreground font-mono">All clear — no unpaid one-times.</p>
        ) : (
          <ul className="space-y-1 text-sm font-mono">
            {[...datedThisMonth, ...undated].slice(0, 6).map((o) => (
              <li key={o.id} className="flex items-center justify-between py-1 border-b border-border/40">
                <span className="flex items-center gap-2 min-w-0">
                  <input
                    type="checkbox"
                    checked={o.paid}
                    onChange={() => togglePaid(o.id, o.paid)}
                    data-testid={`check-onetime-${o.id}`}
                    className="h-3.5 w-3.5"
                  />
                  <span className="truncate text-xs">{o.description}</span>
                  {!o.dueDate && <Badge variant="secondary" className="text-[10px] px-1 py-0">undated</Badge>}
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  {o.dueDate && <span className="text-xs text-muted-foreground">{formatDate(o.dueDate as unknown as string)}</span>}
                  <span>{formatCurrency(o.amount)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {totalUndated > 0 && (
          <p className="text-[10px] text-warning mt-2 italic">
            Undated unpaid items aren't reserved in Safe-to-Spend. Set due dates to include them.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function UpdateBalanceDialog() {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const createBalance = useCreateBalance();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) return;

    createBalance.mutate({
      data: { accountType: "checking", amount: parsedAmount, asOfDate: new Date().toISOString(), source: "manual" },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMonthlySavingsQueryKey() });
        queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
        queryClient.invalidateQueries({ queryKey: ["dashboard-integrity"] });
        setOpen(false);
        setAmount("");
        toast({ title: "Balance updated" });
      },
      onError: () => toast({ title: "Failed to update balance", variant: "destructive" }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="w-full md:w-auto font-bold tracking-wide" data-testid="button-update-balance">
          <RefreshCw className="mr-2 h-4 w-4" />UPDATE BALANCE
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Update Checking Balance</DialogTitle></DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="amount">Current Balance</Label>
            <Input id="amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="text-2xl font-mono" autoFocus data-testid="input-balance-amount" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createBalance.isPending || !amount} data-testid="button-save-balance">Save Balance</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DisciplineProps {
  d: NonNullable<DiscretionaryResp["discipline"]>;
}

function DisciplineCard({ d }: DisciplineProps) {
  const colorOf = (s: "green" | "amber" | "red") =>
    s === "red"
      ? "text-red-500"
      : s === "amber"
      ? "text-amber-500"
      : "text-emerald-500";
  const dotOf = (s: "green" | "amber" | "red") =>
    s === "red" ? "bg-red-500" : s === "amber" ? "bg-amber-500" : "bg-emerald-500";

  const fixedPct = Math.round(d.fixedRatio * 100);
  const pacePct = Math.round(d.variableBurnPace * 100);
  const savePct = Math.round(d.savingsRate * 100);

  return (
    <Card data-testid="discipline-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Playbook Discipline · day {d.dayOfMonth}/{d.daysInMonth}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div data-testid="discipline-fixed-ratio">
            <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider">
              <span className={`h-2 w-2 rounded-full ${dotOf(d.fixedRatioStatus)}`} />
              Fixed-to-Income
            </div>
            <div className={`mt-1 text-3xl font-bold font-mono ${colorOf(d.fixedRatioStatus)}`}>
              {fixedPct}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              ${d.fixedMonthlyTotal.toLocaleString()}/mo fixed · target ≤ 50%
            </p>
          </div>
          <div data-testid="discipline-burn-pace">
            <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider">
              <span className={`h-2 w-2 rounded-full ${dotOf(d.variableBurnPaceStatus)}`} />
              Variable Burn Pace
            </div>
            <div className={`mt-1 text-3xl font-bold font-mono ${colorOf(d.variableBurnPaceStatus)}`}>
              {pacePct}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              vs ${d.expectedVariableByNow.toLocaleString()} expected by now · ≤ 110% on pace
            </p>
          </div>
          <div data-testid="discipline-savings-rate">
            <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider">
              <span className={`h-2 w-2 rounded-full ${dotOf(d.savingsRateStatus)}`} />
              Savings Rate (Budgeted)
            </div>
            <div className={`mt-1 text-3xl font-bold font-mono ${colorOf(d.savingsRateStatus)}`}>
              {savePct}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              of net income after fixed + variable cap · target ≥ 20%
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
