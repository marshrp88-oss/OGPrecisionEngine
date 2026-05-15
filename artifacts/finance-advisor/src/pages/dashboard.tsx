import {
  useGetDashboardCycle,
  getGetDashboardCycleQueryKey,
  useCreateBalance,
  useGetBills,
  getGetBillsQueryKey,
  useGetVariableSpend,
  getGetVariableSpendQueryKey,
  useCreateVariableSpendEntry,
  useGetOneTimeExpenses,
  getGetOneTimeExpensesQueryKey,
  useUpdateOneTimeExpense,
  useCreateOneTimeExpense,
  useUpdateAssumption,
} from "@workspace/api-client-react";
// Local mirror of GetDashboardCycleResponse — kept in sync with
// lib/api-zod GetDashboardCycleResponse / api-server dashboard.ts. Inlined
// rather than imported because finance-advisor does not currently depend on
// @workspace/api-zod and we don't want to widen the dep graph for a typing.
interface CycleData {
  checkingBalance: number;
  lastBalanceUpdate?: Date | string | null;
  nextPayday?: Date | string | null;
  daysSinceUpdate?: number | null;
  isStale: boolean;
  daysUntilPayday?: number | null;
  billsDueBeforePayday: number;
  pendingHoldsReserve: number;
  minimumCushion: number;
  oneTimeDueBeforePayday: number;
  totalRequiredHold: number;
  safeToSpend: number;
  dailyRateFromUpdate: number;
  dailyRateRealTime: number;
  daysOfCoverage?: number | null;
  variableSpendUntilPayday: number;
  remainingDiscretionary: number;
  status: "GREEN" | "YELLOW" | "RED";
  paydayRisk: boolean;
  forwardReserve: number;
  alertThreshold: number;
}
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  RefreshCw,
  Plus,
  ArrowUpCircle,
  CalendarPlus,
  MessageSquare,
  ChevronDown,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useState, useRef } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IntegrityStatusBanner } from "@/components/integrity-status-banner";
import { useEffect } from "react";
import { useLocation } from "wouter";

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

interface DiscretionaryResp {
  discretionaryThisMonth: number;
  monthlySavings: number;
  monthEnd: string;
  paychecksReceivedThisMonth: number;
  paychecksReceivedCount: number;
  expectedRemainingPaychecks: number;
  commissionPaidThisMonth: number;
  commissionPendingThisMonth: number;
  totalMonthIncome: number;
  billsThisMonth: number;
  variableLoggedThisMonth: number;
  variableExpectedRemaining: number;
  plannedVariableRemainingOverride: number | null;
  oneTimeThisMonth: number;
  totalMonthOutgo: number;
  forwardReserve: number;
  proratedVariableRemainingThisMonth: number;
  daysRemainingInMonth: number;
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

// ---------------------------------------------------------------------------
// Status helpers — Spec §4.2 colored border + semantic STS color
// ---------------------------------------------------------------------------

type CycleStatus = "GREEN" | "YELLOW" | "RED";

function asCycleStatus(s: string | undefined | null): CycleStatus {
  if (s === "YELLOW" || s === "RED") return s;
  return "GREEN";
}

function statusBorderClass(s: CycleStatus): string {
  return s === "GREEN"
    ? "border-l-success"
    : s === "YELLOW"
      ? "border-l-warning"
      : "border-l-destructive";
}

function statusTextClass(s: CycleStatus): string {
  return s === "GREEN"
    ? "text-foreground"
    : s === "YELLOW"
      ? "text-warning"
      : "text-destructive";
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { data: cycle, isLoading, error } = useGetDashboardCycle({
    query: { queryKey: getGetDashboardCycleQueryKey() },
  });
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
      <div className="space-y-4 max-w-6xl mx-auto">
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

  const status = asCycleStatus(cycle.status);
  const billsInCycle = (bills ?? []).filter((b) => b.countsThisCycle);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* ZONE 1 — SITUATION (above the fold, first primary content) */}
      <SituationBlock cycle={cycle} discretionary={discretionary} status={status} />

      {discretionary?.discipline && (
        <DisciplineStrip d={discretionary.discipline} />
      )}

      <ActionRow />

      <IntegrityStatusBanner />

      {cycle.isStale && (
        <Alert
          variant="destructive"
          className="bg-destructive/10 border-destructive/20 text-destructive-foreground"
        >
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
          className={
            integrity.overall === "warn"
              ? "bg-amber-50 dark:bg-amber-950/30 border-amber-500/30"
              : ""
          }
          data-testid="banner-integrity"
        >
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            Session Integrity: {integrity.overall.toUpperCase()}
            {integrity.failCount > 0 &&
              ` (${integrity.failCount} failure${integrity.failCount === 1 ? "" : "s"})`}
            {integrity.warnCount > 0 &&
              ` (${integrity.warnCount} warning${integrity.warnCount === 1 ? "" : "s"})`}
          </AlertTitle>
          <AlertDescription className="text-sm mt-1">
            <ul className="space-y-0.5 mt-1 font-mono text-xs">
              {integrity.checks
                .filter((c) => c.status !== "pass")
                .map((c, idx) => (
                  <li key={idx}>
                    • {c.name}: {c.detail}
                  </li>
                ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* ZONE 2 — SUPPORTING CONTEXT */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <BillsCycleColumn
          rows={billsInCycle.map((b) => ({
            id: b.id,
            name: b.name,
            dueDay: b.dueDay,
            amount: b.amount,
          }))}
          totalHold={cycle.billsDueBeforePayday}
        />
        <OneTimeColumn />
        <VariableSpendColumn />
      </div>

      {/* ZONE 3 — MATH DRILL-DOWN (single accordion) */}
      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="math" className="border rounded-xl px-4 bg-card">
          <AccordionTrigger
            className="hover:no-underline font-mono text-sm py-4"
            data-testid="trigger-engine-math"
          >
            <span className="flex items-center gap-2">
              <ChevronDown className="h-4 w-4" />
              Show engine math
            </span>
          </AccordionTrigger>
          <AccordionContent className="pt-2 pb-6">
            <Tabs defaultValue="sts" className="w-full">
              <TabsList className="w-full justify-start overflow-x-auto">
                <TabsTrigger value="sts" data-testid="tab-math-sts">
                  Safe to Spend
                </TabsTrigger>
                <TabsTrigger
                  value="monthly-savings"
                  data-testid="tab-math-monthly-savings"
                  disabled={!discretionary}
                >
                  Monthly Savings
                </TabsTrigger>
                <TabsTrigger
                  value="discretionary"
                  data-testid="tab-math-discretionary"
                  disabled={!discretionary}
                >
                  Discretionary
                </TabsTrigger>
              </TabsList>

              <TabsContent value="sts" className="space-y-3 font-mono text-sm pt-4">
                <Row label="Checking Balance" value={cycle.checkingBalance} />
                <Row
                  label="− Bills Due Before Payday"
                  value={cycle.billsDueBeforePayday}
                  negative
                />
                <Row
                  label="− Pending Holds"
                  value={cycle.pendingHoldsReserve}
                  negative
                />
                <Row label="− Minimum Cushion" value={cycle.minimumCushion} negative />
                <Row
                  label="− One-Time Costs in Cycle"
                  value={cycle.oneTimeDueBeforePayday}
                  negative
                />
                <Row label="= Safe to Spend" value={cycle.safeToSpend} bold />
                <p className="text-xs text-muted-foreground pt-2 border-t border-border/30 mt-2">
                  Forward Reserve ({formatCurrency(cycle.forwardReserve)}) is excluded from Safe to Spend per spec — it is reserved for next-cycle bills.
                </p>
              </TabsContent>

              {discretionary && (
                <TabsContent
                  value="discretionary"
                  className="space-y-3 font-mono text-sm pt-4"
                >
                  <p className="text-xs text-muted-foreground italic pb-1">
                    Cash-anchored: cash you have <em>right now</em> + income still coming this month, minus every obligation between today and {formatDate(discretionary.monthEnd)}, minus the Forward Reserve savings goal. Negative = this month consumes reserves.
                  </p>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Cash + Income</p>
                  <Row label="Checking balance (today)" value={discretionary.checking} />
                  <Row
                    label={`+ Remaining paychecks this month (${discretionary.paychecksRemainingCount} × ${formatCurrency(discretionary.baseNetIncome / 2)})`}
                    value={discretionary.expectedRemainingPaychecks}
                  />
                  <Row label="+ Commission pending" value={discretionary.commissionPendingThisMonth} />
                  <Row
                    label="= Total cash + income"
                    value={discretionary.checking + discretionary.expectedRemainingPaychecks + discretionary.commissionPendingThisMonth}
                    bold
                  />

                  <p className="text-xs text-muted-foreground uppercase tracking-wider pt-3">Subtractions (today → month end)</p>
                  <Row
                    label={`− Bills remaining (due ${new Date().getDate()}–${new Date(discretionary.monthEnd).getDate()})`}
                    value={discretionary.billsRemainingThisMonth}
                    negative
                  />
                  <EditableOutgoRow
                    label="− Variable expected (remaining of cap)"
                    assumptionKey="planned_variable_remaining_override"
                    value={discretionary.variableExpectedRemaining}
                    fallback={Math.max(0, discretionary.variableCap - discretionary.variableLoggedThisMonth)}
                    isOverridden={discretionary.plannedVariableRemainingOverride !== null}
                    hint={`Default = max(0, cap ${formatCurrency(discretionary.variableCap)} − logged ${formatCurrency(discretionary.variableLoggedThisMonth)}) = ${formatCurrency(Math.max(0, discretionary.variableCap - discretionary.variableLoggedThisMonth))}. Override anytime.`}
                  />
                  <Row
                    label="− One-time remaining (dated today–month-end + undated)"
                    value={discretionary.oneTimeDatedThisMonth + discretionary.oneTimeUndatedAdvisory}
                    negative
                  />
                  <EditableOutgoRow
                    label="− Extra CC balance owed (beyond CC bills)"
                    assumptionKey="quicksilver_balance_owed"
                    value={discretionary.quicksilverBalanceOwed}
                    fallback={0}
                    isOverridden={discretionary.quicksilverBalanceOwed > 0}
                    hint="Use only if you owe MORE on the card than what's already in your bills list. Don't double-count the QuickSilver bill — it's already subtracted above."
                  />
                  <Row
                    label="− Forward Reserve (savings goal contribution)"
                    value={discretionary.forwardReserve}
                    negative
                  />

                  <Row
                    label="= Discretionary This Month"
                    value={discretionary.discretionaryThisMonth}
                    bold
                  />
                  <p className="text-xs text-muted-foreground italic pt-2">
                    What's truly safe to spend on top of bills, planned variable, and savings. Distinct from Safe to Spend (current pay cycle only, no Forward Reserve subtracted).
                  </p>
                </TabsContent>
              )}

              {discretionary && (
                <TabsContent
                  value="monthly-savings"
                  className="space-y-3 font-mono text-sm pt-4"
                >
                  <p className="text-xs text-muted-foreground italic pb-1">
                    Estimated cash that survives to month end. Inflows already in checking + future-cash credits, vs. every reservation between today and end of month. Headline = Discretionary − $100 conservative buffer (per Playbook B62 placeholder).
                  </p>
                  <Row
                    label="= Monthly Savings (estimated)"
                    value={discretionary.monthlySavings}
                    bold
                  />
                  <p className="text-xs text-muted-foreground uppercase tracking-wider pt-3">
                    Inflows / Reservations breakdown
                  </p>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider pt-1">
                    Inflows
                  </p>
                  <Row label="Checking Balance" value={discretionary.checking} />
                  <Row
                    label={`Remaining Paychecks This Month (${discretionary.paychecksRemainingCount} × ${formatCurrency(discretionary.baseNetIncome / 2)})`}
                    value={discretionary.remainingPaychecksThisMonth}
                  />
                  <Row
                    label="Confirmed Commission (not yet received)"
                    value={discretionary.confirmedCommissionUnreceived}
                  />
                  <Row
                    label="= Total Inflows Available"
                    value={discretionary.totalInflowsAvailable}
                    bold
                  />

                  <p className="text-xs text-muted-foreground uppercase tracking-wider pt-3">
                    Reservations
                  </p>
                  <Row
                    label="Bills remaining this month"
                    value={discretionary.billsRemainingThisMonth}
                  />
                  <Row
                    label="One-time expenses dated through month end"
                    value={discretionary.oneTimeDatedThisMonth}
                  />
                  <Row
                    label="Variable expected this month (editable above)"
                    value={discretionary.variableRemainingThisMonth}
                  />
                  <Row
                    label="QuickSilver Owed"
                    value={discretionary.quicksilverBalanceOwed}
                  />
                  <Row label="Minimum cushion" value={discretionary.minimumCushion} />
                  <Row
                    label="= Total Reservations Required"
                    value={discretionary.totalReservationsRequired}
                    bold
                  />

                  {discretionary.oneTimeUndatedAdvisory > 0 && (
                    <p className="text-xs text-amber-700 dark:text-amber-400 pt-2 border-t border-border/30 mt-2">
                      Advisory: {formatCurrency(discretionary.oneTimeUndatedAdvisory)} of one-time expenses are unpaid without a due date — set due dates so they're reserved.
                    </p>
                  )}

                  {discretionary.billsRemainingDetail.length > 0 && (
                    <div className="pt-3 border-t border-border/30 mt-2">
                      <p className="text-xs text-muted-foreground mb-1">
                        Remaining bills this month:
                      </p>
                      <ul className="text-xs space-y-0.5">
                        {discretionary.billsRemainingDetail.map((b) => (
                          <li key={b.id} className="flex justify-between">
                            <span>
                              {b.name} (day {b.dueDay})
                            </span>
                            <span>{formatCurrency(b.amount)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </TabsContent>
              )}
            </Tabs>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone 1 — Situation Block (Spec §4.2)
// ---------------------------------------------------------------------------

function SituationBlock({
  cycle,
  discretionary,
  status,
}: {
  cycle: CycleData;
  discretionary: DiscretionaryResp | undefined;
  status: CycleStatus;
}) {
  const paydayLabel = paydayRelativeLabel(cycle.daysUntilPayday, cycle.nextPayday);

  return (
    <section
      className={cn(
        "rounded-xl bg-card overflow-hidden border border-border",
        "border-l-4",
        statusBorderClass(status),
        status !== "GREEN" && "reserve-status-pulse-once",
      )}
      data-testid="situation-block"
      data-status={status}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border">
        {/* LEFT — Safe to Spend */}
        <div className="p-6 md:p-8">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-2">
            Safe to Spend
          </p>
          <h2
            className={cn(
              "text-5xl md:text-6xl font-bold tracking-tighter font-mono reserve-animate",
              statusTextClass(status),
            )}
            data-testid="text-safe-to-spend"
          >
            {formatCurrency(cycle.safeToSpend)}
          </h2>
          <p className="text-xs text-muted-foreground font-mono mt-3">
            {formatCurrency(cycle.dailyRateRealTime)}/day · {paydayLabel}
          </p>
        </div>

        {/* RIGHT — Discretionary This Month */}
        <div className="p-6 md:p-8">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-2">
            Discretionary This Month
          </p>
          <h3
            className="text-3xl md:text-4xl font-bold tracking-tighter font-mono"
            data-testid="text-discretionary-month"
          >
            {discretionary ? formatCurrency(discretionary.discretionaryThisMonth) : "—"}
          </h3>
          {discretionary && (
            <div className="mt-3 space-y-1.5 text-xs font-mono">
              <InlineAssumptionEditor
                label="Variable remaining"
                assumptionKey="planned_variable_remaining_override"
                value={discretionary.variableExpectedRemaining}
                fallback={discretionary.variableCap}
                isOverridden={discretionary.plannedVariableRemainingOverride !== null}
                suffix={`of ${formatCurrency(discretionary.variableCap)}`}
              />
              <InlineAssumptionEditor
                label="QuickSilver / CC Owed"
                assumptionKey="quicksilver_balance_owed"
                value={discretionary.quicksilverBalanceOwed}
                fallback={0}
                isOverridden={discretionary.quicksilverBalanceOwed > 0}
              />
              <p className="text-[10px] text-muted-foreground/70 italic pt-1">
                Tap a number to edit. Updates Discretionary instantly.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 4-up stat strip — single line on desktop, wraps on mobile */}
      <div
        className="border-t border-border px-6 md:px-8 py-3 text-xs font-mono text-muted-foreground flex flex-wrap gap-x-6 gap-y-1"
        data-testid="stat-strip"
      >
        <StripItem label="Checking" value={formatCurrency(cycle.checkingBalance)} />
        <StripItem
          label="Required Hold"
          value={formatCurrency(cycle.totalRequiredHold)}
        />
        <StripItem label="Forward Reserve" value={formatCurrency(cycle.forwardReserve)} />
        <StripItem
          label="Monthly Savings"
          value={formatCurrency(discretionary?.monthlySavings ?? 0)}
        />
      </div>
    </section>
  );
}

function StripItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-muted-foreground/70">{label}</span>
      <span className="text-foreground font-medium">{value}</span>
    </span>
  );
}

function paydayRelativeLabel(
  days: number | null | undefined,
  payday: string | Date | null | undefined,
): string {
  const datePart = payday ? formatDate(payday) : "—";
  if (days === null || days === undefined) return `payday ${datePart}`;
  if (days === 0) return `payday today (${datePart})`;
  if (days === 1) return `1 day to ${datePart}`;
  return `${days} days to ${datePart}`;
}

// ---------------------------------------------------------------------------
// Zone 1 — Discipline Strip (Spec §4.3) — single line, three metrics
// ---------------------------------------------------------------------------

function DisciplineStrip({
  d,
}: {
  d: NonNullable<DiscretionaryResp["discipline"]>;
}) {
  return (
    <div
      className="rounded-lg border border-border bg-card px-4 md:px-6 py-3 flex flex-wrap items-center gap-x-8 gap-y-3"
      data-testid="discipline-strip"
    >
      <DisciplineMetric
        label="Fixed / Income"
        value={`${Math.round(d.fixedRatio * 100)}%`}
        status={d.fixedRatioStatus}
        badge={
          d.fixedRatioStatus === "red"
            ? "TIGHTEN"
            : d.fixedRatioStatus === "amber"
              ? "MONITOR"
              : "ON TRACK"
        }
        testid="discipline-fixed-ratio"
      />
      <DisciplineMetric
        label="Variable Pace"
        value={`${Math.round(d.variableBurnPace * 100)}%`}
        status={d.variableBurnPaceStatus}
        badge={
          d.variableBurnPaceStatus === "red"
            ? "OVER PACE"
            : d.variableBurnPaceStatus === "amber"
              ? "MONITOR"
              : "ON PACE"
        }
        testid="discipline-burn-pace"
      />
      <DisciplineMetric
        label="Savings Rate"
        value={`${Math.round(d.savingsRate * 100)}%`}
        status={d.savingsRateStatus}
        badge={
          d.savingsRateStatus === "red"
            ? "BELOW TARGET"
            : d.savingsRateStatus === "amber"
              ? "MONITOR"
              : "ON TARGET"
        }
        testid="discipline-savings-rate"
      />
      <span className="ml-auto text-xs text-muted-foreground font-mono">
        day {d.dayOfMonth}/{d.daysInMonth}
      </span>
    </div>
  );
}

function DisciplineMetric({
  label,
  value,
  status,
  badge,
  testid,
}: {
  label: string;
  value: string;
  status: "green" | "amber" | "red";
  badge: string;
  testid: string;
}) {
  const color =
    status === "red"
      ? "text-destructive"
      : status === "amber"
        ? "text-warning"
        : "text-success";
  const badgeBg =
    status === "red"
      ? "bg-destructive/15 text-destructive border-destructive/30"
      : status === "amber"
        ? "bg-warning/15 text-warning border-warning/30"
        : "bg-success/15 text-success border-success/30";
  return (
    <span className="inline-flex items-baseline gap-2" data-testid={testid}>
      <span className="text-xs text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span className={cn("font-mono text-sm font-semibold reserve-animate", color)}>
        {value}
      </span>
      <span
        className={cn(
          "text-xs font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border reserve-animate",
          badgeBg,
        )}
      >
        {badge}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Zone 1 — Action Row (Spec §4.4) — 4 ghost buttons
// ---------------------------------------------------------------------------

function ActionRow() {
  const [, navigate] = useLocation();
  return (
    <div
      className="grid grid-cols-2 md:grid-cols-4 gap-2"
      data-testid="action-row"
    >
      <UpdateBalanceDialog />
      <LogSpendDialog />
      <OneTimeQuickAddDialog />
      <Button
        variant="ghost"
        className="justify-start font-medium border border-border"
        onClick={() => navigate("/advisor")}
        data-testid="button-ask-advisor"
      >
        <MessageSquare className="mr-2 h-4 w-4" />
        Ask Advisor
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zone 2 columns
// ---------------------------------------------------------------------------

function BillsCycleColumn({
  rows,
  totalHold,
}: {
  rows: { id: number; name: string; dueDay: number; amount: number }[];
  totalHold: number;
}) {
  return (
    <section data-testid="bills-cycle-column" className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Bills in Cycle
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground font-mono">
          — No bills in current cycle.
        </p>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-muted-foreground uppercase tracking-wide">
              <th className="text-left py-1 font-normal">Bill</th>
              <th className="text-right py-1 font-normal">Day</th>
              <th className="text-right py-1 font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="text-foreground">
                <td className="py-1 truncate max-w-[140px]">{b.name}</td>
                <td className="py-1 text-right text-muted-foreground">{b.dueDay}</td>
                <td className="py-1 text-right">{formatCurrency(b.amount)}</td>
              </tr>
            ))}
            <tr className="border-t border-border/60">
              <td colSpan={2} className="pt-2 text-sm font-semibold">
                Total hold
              </td>
              <td className="pt-2 text-right text-sm font-semibold">
                {formatCurrency(totalHold)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}

function OneTimeColumn() {
  const { data: oneTimes } = useGetOneTimeExpenses({
    query: { queryKey: getGetOneTimeExpensesQueryKey() },
  });
  const updateOte = useUpdateOneTimeExpense();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const unpaid = (oneTimes ?? []).filter((o) => !o.paid);
  const datedThisMonth = unpaid.filter((o) => {
    if (!o.dueDate) return false;
    const d = new Date(o.dueDate as unknown as string);
    return d >= today && d <= monthEnd;
  });
  const undated = unpaid.filter((o) => !o.dueDate);
  const totalThisMonth = datedThisMonth.reduce((s, o) => s + o.amount, 0);
  const items = [...datedThisMonth, ...undated].slice(0, 6);

  const togglePaid = (id: number, paid: boolean) => {
    updateOte.mutate(
      { id, data: { paid: !paid } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetOneTimeExpensesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
          queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
          toast({ title: paid ? "Marked unpaid" : "Marked paid" });
        },
      },
    );
  };

  return (
    <section data-testid="one-time-column" className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        One-Time This Month
      </h3>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground font-mono">— All clear</p>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-muted-foreground uppercase tracking-wide">
              <th className="text-left py-1 font-normal">Item</th>
              <th className="text-right py-1 font-normal">Due</th>
              <th className="text-right py-1 font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id}>
                <td className="py-1 truncate max-w-[140px]">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={o.paid}
                      onChange={() => togglePaid(o.id, o.paid)}
                      className="h-3.5 w-3.5"
                      data-testid={`check-onetime-${o.id}`}
                    />
                    <span className="truncate">{o.description}</span>
                  </label>
                </td>
                <td className="py-1 text-right text-muted-foreground">
                  {o.dueDate ? formatDate(o.dueDate as unknown as string) : "—"}
                </td>
                <td className="py-1 text-right">{formatCurrency(o.amount)}</td>
              </tr>
            ))}
            {datedThisMonth.length > 0 && (
              <tr className="border-t border-border/60">
                <td colSpan={2} className="pt-2 text-sm font-semibold">
                  Total dated
                </td>
                <td className="pt-2 text-right text-sm font-semibold">
                  {formatCurrency(totalThisMonth)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

function VariableSpendColumn() {
  const { data: vs } = useGetVariableSpend(undefined, {
    query: { queryKey: getGetVariableSpendQueryKey() },
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

  const monthEntries = (vs ?? []).filter(
    (v) => new Date(v.weekOf as unknown as string) >= monthStart,
  );
  const monthTotal = monthEntries.reduce((s, v) => s + v.amount, 0);
  const quicksilverTotal = monthEntries
    .filter((v) => v.quicksilver)
    .reduce((s, v) => s + v.amount, 0);
  const recent = (vs ?? []).slice(0, 6);

  return (
    <section data-testid="variable-spend-column" className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Variable Spend Log
        </h3>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => window.dispatchEvent(new CustomEvent("reserve:open-log-spend"))}
          data-testid="button-log-variable"
        >
          Log
        </Button>
      </div>
      {recent.length === 0 ? (
        <p className="text-xs text-muted-foreground font-mono">— No entries yet</p>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-muted-foreground uppercase tracking-wide">
              <th className="text-left py-1 font-normal">Date</th>
              <th className="text-left py-1 font-normal">Category</th>
              <th className="text-right py-1 font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((v) => (
              <tr key={v.id} data-testid={`row-variable-${v.id}`}>
                <td className="py-1 text-muted-foreground">
                  {formatDate(v.weekOf as unknown as string)}
                </td>
                <td className="py-1 capitalize">
                  <span className="inline-flex items-center gap-1.5">
                    {v.category ?? ""}
                    {v.quicksilver && (
                      <span className="text-xs font-mono uppercase tracking-wider px-1 py-0 rounded bg-warning/15 text-warning border border-warning/30">
                        QS
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-1 text-right">{formatCurrency(v.amount)}</td>
              </tr>
            ))}
            <tr className="border-t border-border/60">
              <td colSpan={2} className="pt-2 text-sm font-semibold">
                Logged MTD
              </td>
              <td className="pt-2 text-right text-sm font-semibold">
                {formatCurrency(monthTotal)}
              </td>
            </tr>
            <tr>
              <td colSpan={2} className="text-xs text-muted-foreground">
                QuickSilver Owed
              </td>
              <td className="text-right text-xs text-muted-foreground">
                {formatCurrency(quicksilverTotal)}
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Action Row dialogs
// ---------------------------------------------------------------------------

function UpdateBalanceDialog() {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const createBalance = useCreateBalance();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    const parsed = parseFloat(amount);
    if (isNaN(parsed)) return;
    createBalance.mutate(
      {
        data: {
          accountType: "checking",
          amount: parsed,
          asOfDate: new Date().toISOString(),
          source: "manual",
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
          queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
          queryClient.invalidateQueries({ queryKey: ["dashboard-integrity"] });
          setOpen(false);
          setAmount("");
          toast({ title: "Balance updated" });
        },
        onError: () =>
          toast({ title: "Failed to update balance", variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="justify-start font-medium border border-border"
          data-testid="button-update-balance"
        >
          <ArrowUpCircle className="mr-2 h-4 w-4" />
          Update Balance
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Checking Balance</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="amount">Current Balance</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="text-2xl font-mono"
              autoFocus
              data-testid="input-balance-amount"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={createBalance.isPending || !amount}
            data-testid="button-save-balance"
          >
            <RefreshCw
              className={cn(
                "mr-2 h-4 w-4",
                createBalance.isPending && "animate-spin",
              )}
            />
            Save Balance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LogSpendDialog() {
  const createMut = useCreateVariableSpendEntry();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("reserve:open-log-spend", handler);
    return () => window.removeEventListener("reserve:open-log-spend", handler);
  }, []);
  const [form, setForm] = useState({
    weekOf: new Date().toISOString().split("T")[0],
    amount: "",
    category: "groceries",
    quicksilver: true,
    notes: "",
  });

  const handleSave = () => {
    const amt = parseFloat(form.amount);
    if (isNaN(amt) || amt <= 0) {
      toast({ title: "Amount required", variant: "destructive" });
      return;
    }
    createMut.mutate(
      {
        data: {
          weekOf: form.weekOf,
          amount: amt,
          category: form.category || null,
          quicksilver: form.quicksilver,
          notes: form.notes.trim() || null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetVariableSpendQueryKey() });
          queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
          setOpen(false);
          setForm((f) => ({ ...f, amount: "", notes: "" }));
          toast({ title: "Variable entry logged" });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="justify-start font-medium border border-border"
          data-testid="button-log-spend"
        >
          <Plus className="mr-2 h-4 w-4" />
          Log Spend
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log Variable Spend</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              value={form.weekOf}
              onChange={(e) => setForm({ ...form, weekOf: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Amount</Label>
              <Input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                data-testid="input-variable-amount"
              />
            </div>
            <div>
              <Label>Category</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
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
            <div>
              <Label>Charged on QuickSilver</Label>
              <p className="text-xs text-muted-foreground">
                Accrues into Monthly Savings statement reserve.
              </p>
            </div>
            <Switch
              checked={form.quicksilver}
              onCheckedChange={(v) => setForm({ ...form, quicksilver: v })}
            />
          </div>
          <div>
            <Label>Notes</Label>
            <Input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={createMut.isPending}
            data-testid="button-save-variable"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OneTimeQuickAddDialog() {
  const createMut = useCreateOneTimeExpense();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    description: "",
    amount: "",
    dueDate: "",
    notes: "",
  });

  const handleSave = () => {
    const amt = parseFloat(form.amount);
    if (!form.description.trim() || isNaN(amt) || amt <= 0) {
      toast({
        title: "Description and amount required",
        variant: "destructive",
      });
      return;
    }
    createMut.mutate(
      {
        data: {
          description: form.description.trim(),
          amount: amt,
          dueDate: form.dueDate || null,
          paid: false,
          notes: form.notes.trim() || null,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetOneTimeExpensesQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDashboardCycleQueryKey(),
          });
          queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
          setOpen(false);
          setForm({ description: "", amount: "", dueDate: "", notes: "" });
          toast({ title: "One-time expense added" });
        },
        onError: () =>
          toast({
            title: "Failed to add one-time expense",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="justify-start font-medium border border-border"
          data-testid="button-add-one-time"
        >
          <CalendarPlus className="mr-2 h-4 w-4" />
          One-Time
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add One-Time Expense</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div>
            <Label>Description</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="e.g. Dentist co-pay"
              data-testid="input-one-time-description"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Amount</Label>
              <Input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                data-testid="input-one-time-amount"
              />
            </div>
            <div>
              <Label>Due date</Label>
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                data-testid="input-one-time-due-date"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Undated items aren't reserved in Safe-to-Spend. Set a due date to include them.
          </p>
          <div>
            <Label>Notes</Label>
            <Input
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={createMut.isPending}
            data-testid="button-save-one-time"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shared math row (used by Zone 3 tabs)
// ---------------------------------------------------------------------------

function InlineAssumptionEditor({
  label,
  assumptionKey,
  value,
  fallback,
  isOverridden,
  suffix,
}: {
  label: string;
  assumptionKey: string;
  value: number;
  fallback: number;
  isOverridden: boolean;
  suffix?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value.toFixed(2));
  const committedRef = useRef(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMut = useUpdateAssumption();

  useEffect(() => {
    if (!editing) setDraft(value.toFixed(2));
  }, [value, editing]);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? null : parseFloat(trimmed);
    if (trimmed !== "" && (parsed === null || isNaN(parsed) || parsed < 0)) {
      toast({ title: "Enter a non-negative number or leave blank to reset", variant: "destructive" });
      setDraft(value.toFixed(2));
      setEditing(false);
      return;
    }
    updateMut.mutate(
      { key: assumptionKey, data: { value: trimmed === "" ? "" : String(parsed) } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
          queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
          setEditing(false);
        },
        onError: () => {
          toast({ title: "Update failed", variant: "destructive" });
          setDraft(value.toFixed(2));
          setEditing(false);
        },
      },
    );
  };

  const reset = () => {
    updateMut.mutate(
      { key: assumptionKey, data: { value: "" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
          queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
          toast({ title: `Reset to default (${formatCurrency(fallback)})` });
        },
      },
    );
  };

  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        {editing ? (
          <input
            type="number"
            step="0.01"
            min="0"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => {
              committedRef.current = false;
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Escape") {
                committedRef.current = true;
                setDraft(value.toFixed(2));
                setEditing(false);
              }
            }}
            className="w-24 text-right font-mono bg-background border border-border rounded px-2 py-0.5 text-xs"
            data-testid={`inline-input-${assumptionKey}`}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="font-mono hover:underline decoration-dotted underline-offset-4 text-foreground"
            data-testid={`inline-edit-${assumptionKey}`}
          >
            {formatCurrency(value)}
          </button>
        )}
        {suffix && !editing && (
          <span className="text-muted-foreground">{suffix}</span>
        )}
        {isOverridden && !editing && (
          <button
            type="button"
            onClick={reset}
            className="text-[9px] text-muted-foreground hover:text-foreground uppercase tracking-wider ml-1"
            data-testid={`inline-reset-${assumptionKey}`}
          >
            reset
          </button>
        )}
      </span>
    </div>
  );
}

function EditableOutgoRow({
  label,
  assumptionKey,
  value,
  fallback,
  isOverridden,
  hint,
}: {
  label: string;
  assumptionKey: string;
  value: number;
  fallback: number;
  isOverridden: boolean;
  hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value.toFixed(2));
  const committedRef = useRef(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMut = useUpdateAssumption();

  useEffect(() => {
    if (!editing) setDraft(value.toFixed(2));
  }, [value, editing]);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? null : parseFloat(trimmed);
    if (trimmed !== "" && (parsed === null || isNaN(parsed) || parsed < 0)) {
      toast({ title: "Enter a non-negative number or leave blank", variant: "destructive" });
      setDraft(value.toFixed(2));
      setEditing(false);
      return;
    }
    updateMut.mutate(
      { key: assumptionKey, data: { value: trimmed === "" ? "" : String(parsed) } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
          setEditing(false);
          toast({ title: "Updated" });
        },
        onError: () => {
          toast({ title: "Update failed", variant: "destructive" });
          setDraft(value.toFixed(2));
          setEditing(false);
        },
      },
    );
  };

  const reset = () => {
    updateMut.mutate(
      { key: assumptionKey, data: { value: "" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
          toast({ title: `Reset to default (${formatCurrency(fallback)})` });
        },
      },
    );
  };

  return (
    <div className="border-b border-border/40 py-1.5">
      <div className="flex justify-between items-center gap-2 text-destructive">
        <span className="flex-1">{label}</span>
        {editing ? (
          <input
            type="number"
            step="0.01"
            min="0"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => {
              committedRef.current = false;
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Escape") {
                committedRef.current = true;
                setDraft(value.toFixed(2));
                setEditing(false);
              }
            }}
            className="w-28 text-right font-mono bg-background border border-border rounded px-2 py-0.5 text-sm"
            data-testid={`input-${assumptionKey}`}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="font-mono hover:underline decoration-dotted underline-offset-4"
            data-testid={`edit-${assumptionKey}`}
          >
            {formatCurrency(value)}
          </button>
        )}
      </div>
      <div className="flex justify-between items-center gap-2 mt-0.5">
        {hint ? (
          <span className="text-[11px] text-muted-foreground/80 italic flex-1">{hint}</span>
        ) : (
          <span className="flex-1" />
        )}
        {isOverridden && !editing && (
          <button
            type="button"
            onClick={reset}
            className="text-[10px] text-muted-foreground hover:text-foreground uppercase tracking-wider"
            data-testid={`reset-${assumptionKey}`}
          >
            reset
          </button>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  negative,
  bold,
}: {
  label: string;
  value: number;
  negative?: boolean;
  bold?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex justify-between py-1",
        bold ? "border-t-2 border-border pt-2 font-bold" : "border-b border-border/40",
        negative ? "text-destructive" : "",
      )}
    >
      <span className={negative ? "" : "text-muted-foreground"}>{label}</span>
      <span>{formatCurrency(value)}</span>
    </div>
  );
}
