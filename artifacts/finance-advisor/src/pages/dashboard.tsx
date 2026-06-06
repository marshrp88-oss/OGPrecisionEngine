import {
  useGetDashboardCycle,
  getGetDashboardCycleQueryKey,
  useCreateBalance,
  useGetBills,
  getGetBillsQueryKey,
  useGetVariableSpend,
  getGetVariableSpendQueryKey,
  useCreateVariableSpendEntry,
  useUpdateVariableSpendEntry,
  useDeleteVariableSpendEntry,
  useMarkQuicksilverPaid,
  useGetOneTimeExpenses,
  getGetOneTimeExpensesQueryKey,
  useUpdateOneTimeExpense,
  useCreateOneTimeExpense,
  useUpdateAssumption,
  useUpdateBill,
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
  quicksilverOwed: number;
  pendingBillsOwed: number;
  forwardReserveBillsTotal: number;
  safeToSpend: number;
  safeToSpendPreFloor: number;
  overCommittedBy: number;
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
  Pencil,
  Trash2,
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
  paycheckBreakdown: {
    paydayDate: string;
    baseAmount: number;
    overrideAmount: number | null;
    appliedAmount: number;
    received: boolean;
  }[];
  commissionPaidThisMonth: number;
  commissionPendingThisMonth: number;
  totalMonthIncome: number;
  billsThisMonth: number;
  billsPaidThisMonth: number;
  billsLateUnpaidThisMonth: number;
  billsSkippedThisMonth: number;
  variableLoggedThisMonth: number;
  variableExpectedRemaining: number;
  variableExpectedRemainingTrailing: number;
  variableCapRemaining: number;
  monthVariableObligation: number;
  trailingDailyRate: number;
  plannedVariableRemainingOverride: number | null;
  currentMonthKey: string;
  oneTimeThisMonth: number;
  oneTimeMonthObligated: number;
  oneTimePaidThisMonth: number;
  oneTimeDeferredTotal: number;
  oneTimeDetail: {
    id: number;
    description: string;
    amount: number;
    dueDate: string | null;
    paid: boolean;
    deferred: boolean;
  }[];
  totalMonthOutgo: number;
  nextEffectivePayday: string;
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
  billsRemainingDetail: {
    id: number;
    name: string;
    amount: number;
    dueDay: number;
  }[];
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
  const {
    data: cycle,
    isLoading,
    error,
  } = useGetDashboardCycle({
    query: { queryKey: getGetDashboardCycleQueryKey() },
  });
  const { data: bills } = useGetBills({
    query: { queryKey: getGetBillsQueryKey() },
  });

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
      <SituationBlock
        cycle={cycle}
        discretionary={discretionary}
        status={status}
      />

      {discretionary?.discipline && (
        <DisciplineStrip d={discretionary.discipline} />
      )}

      <ActionRow />

      <CashPositionCard />

      <IntegrityStatusBanner />

      {cycle.isStale && (
        <Alert
          variant="destructive"
          className="bg-destructive/10 border-destructive/20 text-destructive-foreground"
        >
          <AlertTriangle className="h-5 w-5" />
          <AlertTitle className="text-lg font-bold">
            Stale Data Warning
          </AlertTitle>
          <AlertDescription className="font-mono text-sm mt-1">
            Balance last updated {cycle.daysSinceUpdate} days ago. Cycle
            calculations may be unreliable. Update your checking balance to
            restore precision.
          </AlertDescription>
        </Alert>
      )}

      {cycle.paydayRisk && (
        <Alert className="bg-amber-50 dark:bg-amber-950/30 border-amber-500/30">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          <AlertTitle className="text-amber-900 dark:text-amber-200">
            Payday on Weekend
          </AlertTitle>
          <AlertDescription className="text-amber-900/80 dark:text-amber-300/80 text-sm">
            Nominal payday falls on a weekend. Effective deposit is the prior
            Friday.
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
                  value="discretionary"
                  data-testid="tab-math-discretionary"
                  disabled={!discretionary}
                >
                  Discretionary
                </TabsTrigger>
              </TabsList>

              <TabsContent
                value="sts"
                className="space-y-3 font-mono text-sm pt-4"
              >
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
                <Row
                  label="− Minimum Cushion"
                  value={cycle.minimumCushion}
                  negative
                />
                <Row
                  label="− One-Time Costs in Cycle"
                  value={cycle.oneTimeDueBeforePayday}
                  negative
                />
                <Row
                  label="− Forward Reserve"
                  value={cycle.forwardReserve}
                  negative
                  sublabel={`${formatCurrency(cycle.forwardReserveBillsTotal)} bills + ${formatCurrency(cycle.forwardReserve - cycle.forwardReserveBillsTotal)} variable, 14d after next payday (one pay cycle)`}
                />
                <Row
                  label="− Pending Bill Payments"
                  value={cycle.pendingBillsOwed}
                  negative
                  sublabel={
                    cycle.pendingBillsOwed > 0
                      ? "Bills marked paid that haven't cleared checking yet — release on Bills page"
                      : undefined
                  }
                />
                <div className="flex items-center justify-between gap-3">
                  <Row
                    label="− QuickSilver Owed"
                    value={cycle.quicksilverOwed}
                    negative
                  />
                  {cycle.quicksilverOwed > 0 && (
                    <MarkQsPaidButton amount={cycle.quicksilverOwed} />
                  )}
                </div>
                <Row label="= Safe to Spend" value={cycle.safeToSpend} bold />
                {cycle.overCommittedBy > 0 && (
                  <p className="text-xs text-destructive font-mono pt-1">
                    pre-floor = {formatCurrency(cycle.safeToSpendPreFloor)} →{" "}
                    {formatCurrency(cycle.overCommittedBy)} short of this
                    cycle&apos;s required hold
                  </p>
                )}
                <p className="text-xs text-muted-foreground pt-2 border-t border-border/30 mt-2">
                  Forward Reserve ({formatCurrency(cycle.forwardReserve)}) and
                  QuickSilver Owed ({formatCurrency(cycle.quicksilverOwed)}) are
                  both subtracted from Safe to Spend so every dollar leaving
                  checking is counted exactly once. Mark QS Paid when the
                  statement settles to release that hold.
                </p>
              </TabsContent>

              {discretionary && (
                <TabsContent
                  value="discretionary"
                  className="space-y-3 font-mono text-sm pt-4"
                >
                  <p className="text-xs text-muted-foreground italic pb-1">
                    Month-anchored flow (v8.0): full-month income vs. full-month
                    obligations through {formatDate(discretionary.monthEnd)}.
                    Paid bills still count (the money already left this month);
                    only <em>skipped this cycle</em> and <em>deferred</em> items
                    are excluded. Forward Reserve and current checking are NOT
                    part of this formula — Forward Reserve is a timing buffer,
                    not a flow item.
                  </p>

                  <p className="text-xs text-muted-foreground uppercase tracking-wider">
                    Month income
                  </p>
                  <Row
                    label={`Paychecks received (${discretionary.paychecksReceivedCount} × ${formatCurrency(discretionary.baseNetIncome / 2)})`}
                    value={discretionary.paychecksReceivedThisMonth}
                  />
                  <Row
                    label={`+ Paychecks remaining (${discretionary.paychecksRemainingCount} × ${formatCurrency(discretionary.baseNetIncome / 2)})`}
                    value={discretionary.expectedRemainingPaychecks}
                  />
                  <Row
                    label="+ Commission paid"
                    value={discretionary.commissionPaidThisMonth}
                  />
                  <Row
                    label="+ Commission pending"
                    value={discretionary.commissionPendingThisMonth}
                  />
                  <Row
                    label="= Total month income"
                    value={discretionary.totalMonthIncome}
                    bold
                  />

                  <p className="text-xs text-muted-foreground uppercase tracking-wider pt-3">
                    Month obligations
                  </p>
                  <Row
                    label={`− Bills this month (${formatCurrency(discretionary.billsPaidThisMonth)} paid · ${formatCurrency(discretionary.billsLateUnpaidThisMonth)} late · skipped ${formatCurrency(discretionary.billsSkippedThisMonth)} excluded)`}
                    value={discretionary.billsThisMonth}
                    negative
                  />
                  <Row
                    label={`− Variable logged so far`}
                    value={discretionary.variableLoggedThisMonth}
                    negative
                  />
                  {/* R-as-truth — this row is the reservation R (what
                      Available-to-Save subtracts). Decoupled from L: cash
                      variable rows are audit-only; QS rows still flow into
                      the hold via the sealed engine path. */}
                  <Row
                    label={`− Variable reserved (R)`}
                    value={discretionary.variableExpectedRemaining}
                    negative
                  />
                  <p className="text-[10px] text-muted-foreground/70 italic -mt-1 pl-2">
                    Edit R via the &ldquo;Variable reserved&rdquo; pill above.
                    Cash variable rows are audit-only; QS rows still flow into
                    the hold.
                  </p>
                  <Row
                    label={`− One-time this month (${formatCurrency(discretionary.oneTimePaidThisMonth)} paid; ${formatCurrency(discretionary.oneTimeDeferredTotal)} deferred excluded)`}
                    value={discretionary.oneTimeMonthObligated}
                    negative
                  />
                  <Row
                    label="= Total month outgo"
                    value={discretionary.totalMonthOutgo}
                    bold
                  />

                  <Row
                    label="= Discretionary This Month"
                    value={discretionary.discretionaryThisMonth}
                    bold
                    negative={discretionary.discretionaryThisMonth < 0}
                  />
                  {discretionary.discretionaryThisMonth < 0 && (
                    <p className="text-xs text-destructive italic pt-2">
                      Negative = the month is running a real deficit.
                      Obligations exceed income by{" "}
                      {formatCurrency(
                        Math.abs(discretionary.discretionaryThisMonth),
                      )}
                      . Cut variable, defer one-times, or skip a bill to this
                      cycle.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground italic pt-2">
                    Forward Reserve (
                    {formatCurrency(discretionary.forwardReserve)}) shown for
                    reference — feeds Safe to Spend, not Discretionary. Distinct
                    from Safe to Spend (current pay cycle, checking-anchored).
                  </p>
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
  const paydayLabel = paydayRelativeLabel(
    cycle.daysUntilPayday,
    cycle.nextPayday,
  );

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
      {/* v8.0 Final Fix — single reserve-aware headline. "Month Production"
          panel removed; the only savings number is Available to Save / Spend. */}
      <div className="grid grid-cols-1">
        <div className="p-6 md:p-8">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest mb-2">
            Safe to Spend (This Cycle)
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
          {cycle.overCommittedBy > 0 ? (
            <p
              className="text-xs text-destructive font-mono mt-2 font-medium"
              data-testid="text-over-committed"
            >
              {formatCurrency(cycle.overCommittedBy)} short of this cycle&apos;s
              required hold
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground font-mono mt-3">
            {formatCurrency(cycle.dailyRateRealTime)}/day · {paydayLabel}
          </p>
          <p className="text-[10px] text-muted-foreground/70 mt-1">
            Reserve-aware cash position — your daily decision number. Every
            dollar leaving checking is counted exactly once.
          </p>
          {discretionary && (
            <div className="mt-4 pt-3 border-t border-border/30 space-y-1.5 text-xs font-mono">
              {/* R-as-truth — editable reservation R. Pill shows R as a
                  single number. Tap to edit; tap Prorate for a time-aware
                  cap × daysRemaining ÷ daysInMonth suggestion. Reset clears
                  the override row → R falls back to variable_spend_cap
                  ($600 default). R subtracts directly from Available-to-Save.
                  Cash variable rows are audit-only; QS rows flow into the
                  hold via sealed engine (quicksilverOwed). */}
              <VariableEstimateEditor
                R={
                  discretionary.plannedVariableRemainingOverride ??
                  discretionary.variableCap
                }
                logged={discretionary.variableLoggedThisMonth}
                isOverridden={
                  discretionary.plannedVariableRemainingOverride !== null
                }
                fallbackCap={discretionary.variableCap}
                daysRemaining={discretionary.daysRemainingInMonth}
                daysInMonth={discretionary.discipline?.daysInMonth ?? 30}
                monthKey={discretionary.currentMonthKey}
              />
            </div>
          )}
        </div>
      </div>

      {/* v9 Fix 1 — strip pared down to the three numbers that drive Safe to
          Spend. "Monthly Savings (theoretical)" was removed: it was a stale
          parallel calculation that contradicted the reserve-aware "Available
          to Save / Invest" headline on the Cash Position card. There are now
          exactly two savings/available numbers in the product:
            (a) Safe to Spend — can-I-spend-today liquidity (this section).
            (b) Available to Save / Invest — reserve-aware month-end position
                (the Cash Position card below). */}
      <div
        className="border-t border-border px-6 md:px-8 py-3 text-xs font-mono text-muted-foreground flex flex-wrap gap-x-6 gap-y-1"
        data-testid="stat-strip"
      >
        <StripItem
          label="Checking"
          value={formatCurrency(cycle.checkingBalance)}
        />
        <StripItem
          label="Required Hold"
          value={formatCurrency(cycle.totalRequiredHold)}
        />
        <StripItem
          label="Forward Reserve"
          value={formatCurrency(cycle.forwardReserve)}
        />
      </div>
    </section>
  );
}

// v8.0 Final Fix — settles the QuickSilver lifecycle. Bulk-stamps every
// unpaid quicksilver variable_spend row as paid-off; the cycle's
// quicksilverOwed hold drops to $0 and Safe to Spend rises by the same
// amount on the next cycle refresh.
function MarkQsPaidButton({ amount }: { amount: number }) {
  const queryClient = useQueryClient();
  const mut = useMarkQuicksilverPaid({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetDashboardCycleQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getGetVariableSpendQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: ["dashboard-discretionary"],
        });
        queryClient.invalidateQueries({
          queryKey: ["dashboard-cash-position"],
        });
      },
    },
  });
  return (
    <button
      type="button"
      onClick={() => mut.mutate()}
      disabled={mut.isPending}
      className="text-[10px] font-medium uppercase tracking-wider text-primary hover:underline disabled:opacity-50 whitespace-nowrap"
      data-testid="button-mark-qs-paid"
      title={`Settles ${formatCurrency(amount)} of unpaid QuickSilver spend`}
    >
      {mut.isPending ? "Settling…" : "Mark QS Paid"}
    </button>
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
      <span
        className={cn("font-mono text-sm font-semibold reserve-animate", color)}
      >
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
      <p className="text-[10px] text-muted-foreground/70 italic -mt-1">
        Bills due before next payday. This is the bills portion only; the full
        Required Hold (incl. one-time, QS owed, cushion, etc.) is broken out in
        the Cash Position math chain above.
      </p>
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
                <td className="py-1 text-right text-muted-foreground">
                  {b.dueDay}
                </td>
                <td className="py-1 text-right">{formatCurrency(b.amount)}</td>
              </tr>
            ))}
            <tr className="border-t border-border/60">
              <td colSpan={2} className="pt-2 text-sm font-semibold">
                Bills portion of hold
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
          queryClient.invalidateQueries({
            queryKey: getGetOneTimeExpensesQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetDashboardCycleQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: ["dashboard-discretionary"],
          });
          queryClient.invalidateQueries({
            queryKey: ["dashboard-cash-position"],
          });
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

// v10 — Variable Spend Log row. Display mode renders date/category/amount + a
// pencil and trash icon. Pencil → inline-edit form (date, amount, category,
// QS toggle). Trash → confirm prompt, then DELETE. Both mutations invalidate
// the same query keys the LogSpendDialog invalidates so headlines refresh.
function VariableSpendRow({
  row,
}: {
  row: {
    id: number;
    weekOf: string;
    amount: number;
    category: string | null;
    quicksilver: boolean;
    notes: string | null;
  };
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMut = useUpdateVariableSpendEntry();
  const deleteMut = useDeleteVariableSpendEntry();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    weekOf:
      typeof row.weekOf === "string"
        ? row.weekOf.slice(0, 10)
        : new Date(row.weekOf).toISOString().slice(0, 10),
    amount: row.amount.toFixed(2),
    category: row.category ?? "other",
    quicksilver: row.quicksilver,
  });

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetVariableSpendQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-cash-position"] });
    queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
  };

  const save = () => {
    const amt = parseFloat(form.amount);
    if (isNaN(amt) || amt <= 0) {
      toast({ title: "Amount must be greater than 0", variant: "destructive" });
      return;
    }
    updateMut.mutate(
      {
        id: row.id,
        data: {
          weekOf: form.weekOf,
          amount: amt,
          category: form.category || null,
          quicksilver: form.quicksilver,
        },
      },
      {
        onSuccess: () => {
          refreshAll();
          setEditing(false);
          toast({ title: "Entry updated" });
        },
        onError: () =>
          toast({ title: "Update failed", variant: "destructive" }),
      },
    );
  };

  const del = () => {
    if (
      !window.confirm(
        `Delete this variable spend entry?\n\n${formatDate(row.weekOf)} · ${row.category ?? "—"} · ${formatCurrency(row.amount)}${row.quicksilver ? " (QS)" : ""}\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    deleteMut.mutate(
      { id: row.id },
      {
        onSuccess: () => {
          refreshAll();
          toast({ title: "Entry deleted" });
        },
        onError: () =>
          toast({ title: "Delete failed", variant: "destructive" }),
      },
    );
  };

  if (editing) {
    return (
      <tr
        data-testid={`row-variable-${row.id}-editing`}
        className="bg-muted/30"
      >
        <td className="py-1">
          <input
            type="date"
            value={form.weekOf}
            onChange={(e) => setForm({ ...form, weekOf: e.target.value })}
            className="w-full bg-background border border-border rounded px-1.5 py-0.5 text-xs font-mono"
            data-testid={`input-edit-date-${row.id}`}
          />
        </td>
        <td className="py-1">
          <div className="flex items-center gap-1">
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className="flex-1 bg-background border border-border rounded px-1 py-0.5 text-xs"
              data-testid={`input-edit-category-${row.id}`}
            >
              <option value="groceries">Groceries</option>
              <option value="dining">Dining</option>
              <option value="fuel">Fuel</option>
              <option value="household">Household</option>
              <option value="entertainment">Entertainment</option>
              <option value="other">Other</option>
            </select>
            <button
              type="button"
              onClick={() =>
                setForm({ ...form, quicksilver: !form.quicksilver })
              }
              className={cn(
                "text-[10px] font-mono uppercase tracking-wider px-1 py-0.5 rounded border",
                form.quicksilver
                  ? "bg-warning/15 text-warning border-warning/30"
                  : "border-border text-muted-foreground",
              )}
              title="Toggle QuickSilver"
              data-testid={`toggle-edit-qs-${row.id}`}
            >
              QS
            </button>
          </div>
        </td>
        <td className="py-1 text-right">
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            className="w-20 text-right bg-background border border-border rounded px-1.5 py-0.5 text-xs font-mono"
            data-testid={`input-edit-amount-${row.id}`}
          />
        </td>
        <td className="py-1 text-right">
          <div className="inline-flex gap-1">
            <button
              type="button"
              onClick={save}
              disabled={updateMut.isPending}
              className="text-[10px] font-medium uppercase tracking-wider text-success hover:underline disabled:opacity-50"
              data-testid={`button-save-${row.id}`}
            >
              save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setForm({
                  weekOf:
                    typeof row.weekOf === "string"
                      ? row.weekOf.slice(0, 10)
                      : new Date(row.weekOf).toISOString().slice(0, 10),
                  amount: row.amount.toFixed(2),
                  category: row.category ?? "other",
                  quicksilver: row.quicksilver,
                });
              }}
              className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
              data-testid={`button-cancel-${row.id}`}
            >
              cancel
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr data-testid={`row-variable-${row.id}`} className="group">
      <td className="py-1 text-muted-foreground">{formatDate(row.weekOf)}</td>
      <td className="py-1 capitalize">
        <span className="inline-flex items-center gap-1.5">
          {row.category ?? ""}
          {row.quicksilver && (
            <span className="text-xs font-mono uppercase tracking-wider px-1 py-0 rounded bg-warning/15 text-warning border border-warning/30">
              QS
            </span>
          )}
        </span>
      </td>
      <td className="py-1 text-right">{formatCurrency(row.amount)}</td>
      <td className="py-1 text-right">
        <div className="inline-flex gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-muted-foreground hover:text-foreground"
            title="Edit"
            data-testid={`button-edit-${row.id}`}
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={del}
            disabled={deleteMut.isPending}
            className="text-muted-foreground hover:text-destructive disabled:opacity-50"
            title="Delete"
            data-testid={`button-delete-${row.id}`}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </td>
    </tr>
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
          onClick={() =>
            window.dispatchEvent(new CustomEvent("reserve:open-log-spend"))
          }
          data-testid="button-log-variable"
        >
          Log
        </Button>
      </div>
      {recent.length === 0 ? (
        <p className="text-xs text-muted-foreground font-mono">
          — No entries yet
        </p>
      ) : (
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="text-muted-foreground uppercase tracking-wide">
              <th className="text-left py-1 font-normal">Date</th>
              <th className="text-left py-1 font-normal">Category</th>
              <th className="text-right py-1 font-normal">Amount</th>
              <th className="text-right py-1 font-normal w-16"></th>
            </tr>
          </thead>
          <tbody>
            {recent.map((v) => (
              <VariableSpendRow
                key={v.id}
                row={{
                  id: v.id,
                  weekOf: v.weekOf as unknown as string,
                  amount: v.amount,
                  category: v.category ?? null,
                  quicksilver: v.quicksilver,
                  notes: v.notes ?? null,
                }}
              />
            ))}
            <tr className="border-t border-border/60">
              <td colSpan={3} className="pt-2 text-sm font-semibold">
                Logged MTD
              </td>
              <td className="pt-2 text-right text-sm font-semibold">
                {formatCurrency(monthTotal)}
              </td>
            </tr>
            <tr>
              <td colSpan={3} className="text-xs text-muted-foreground">
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

// v8.2 — reconcile suggestion shape returned by POST /api/balances/reconcile-suggestions
type ReconcileSuggestion = {
  currentAmount: number;
  newAmount: number;
  delta: number;
  pendingBills: { id: number; name: string; amount: number }[];
  suggestedClearIds: number[];
  suggestedBills: { id: number; name: string; amount: number }[];
  suggestedSum: number;
  confidence: "exact" | "close" | "none";
  tolerance: number;
};

function UpdateBalanceDialog() {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [suggestion, setSuggestion] = useState<ReconcileSuggestion | null>(
    null,
  );
  const [selectedClearIds, setSelectedClearIds] = useState<Set<number>>(
    new Set(),
  );
  const [submitting, setSubmitting] = useState(false);
  const createBalance = useCreateBalance();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // v8.2 — Step 1: peek at the balance change before committing. Calls the
  // reconcile-suggestions endpoint with the proposed amount and shows the
  // user any paid_pending_clear bills whose sum matches the drop, so a
  // single confirm clears the balance AND the pending lifecycle in one go.
  const handlePreview = async () => {
    const parsed = parseFloat(amount);
    if (isNaN(parsed)) return;
    try {
      const r = await fetch("/api/balances/reconcile-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newAmount: parsed }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data: ReconcileSuggestion = await r.json();
      // Short-circuit: nothing pending OR balance went up → skip preview, just commit.
      if (data.pendingBills.length === 0 || data.delta >= 0) {
        commitBalance(parsed, []);
        return;
      }
      setSuggestion(data);
      setSelectedClearIds(new Set(data.suggestedClearIds));
    } catch {
      // Reconcile is best-effort — if the endpoint fails for any reason,
      // fall back to a straight balance update so the user is never blocked.
      commitBalance(parsed, []);
    }
  };

  const commitBalance = (parsedAmount: number, clearIds: number[]) => {
    setSubmitting(true);
    createBalance.mutate(
      {
        data: {
          accountType: "checking",
          amount: parsedAmount,
          asOfDate: new Date().toISOString(),
          source: "manual",
        },
      },
      {
        onSuccess: async () => {
          // Fire mark-cleared in parallel for every selected pending bill.
          // Failures are reported but don't roll back the balance update.
          // IMPORTANT: fetch() resolves on HTTP 4xx/5xx — we must inspect
          // response.ok to count true successes, otherwise we'd over-report.
          const results = await Promise.allSettled(
            clearIds.map((id) =>
              fetch(`/api/bills/${id}/mark-cleared`, { method: "POST" }),
            ),
          );
          let cleared = 0;
          let failed = 0;
          for (const r of results) {
            if (r.status === "fulfilled" && r.value.ok) cleared++;
            else failed++;
          }
          queryClient.invalidateQueries({
            queryKey: getGetDashboardCycleQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: ["dashboard-discretionary"],
          });
          queryClient.invalidateQueries({
            queryKey: ["dashboard-cash-position"],
          });
          queryClient.invalidateQueries({ queryKey: ["dashboard-integrity"] });
          queryClient.invalidateQueries({ queryKey: ["bills"] });
          setOpen(false);
          setAmount("");
          setSuggestion(null);
          setSelectedClearIds(new Set());
          setSubmitting(false);
          const parts: string[] = [];
          if (cleared > 0)
            parts.push(
              `${cleared} pending bill${cleared > 1 ? "s" : ""} cleared`,
            );
          if (failed > 0)
            parts.push(`${failed} clear${failed > 1 ? "s" : ""} failed`);
          toast({
            title: "Balance updated",
            description: parts.length > 0 ? parts.join(" · ") : undefined,
            variant: failed > 0 ? "destructive" : undefined,
          });
        },
        onError: () => {
          setSubmitting(false);
          toast({ title: "Failed to update balance", variant: "destructive" });
        },
      },
    );
  };

  const handleSave = () => handlePreview();
  const handleConfirmWithClears = () => {
    if (!suggestion) return;
    commitBalance(suggestion.newAmount, Array.from(selectedClearIds));
  };
  const toggleClearId = (id: number) => {
    setSelectedClearIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          <DialogTitle>
            {suggestion ? "Reconcile Pending Bills" : "Update Checking Balance"}
          </DialogTitle>
        </DialogHeader>
        {suggestion ? (
          // v8.2 — reconcile prompt: we detected paid_pending_clear bills
          // whose sum matches the balance drop. Let the user pick which to
          // mark cleared, then commit balance + clears atomically.
          <div className="grid gap-4 py-4" data-testid="reconcile-prompt">
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <div className="flex justify-between font-mono">
                <span>Current balance</span>
                <span>{formatCurrency(suggestion.currentAmount)}</span>
              </div>
              <div className="flex justify-between font-mono">
                <span>New balance</span>
                <span>{formatCurrency(suggestion.newAmount)}</span>
              </div>
              <div className="flex justify-between font-mono font-semibold border-t border-border pt-1 mt-1">
                <span>Change</span>
                <span
                  className={
                    suggestion.delta < 0
                      ? "text-destructive"
                      : "text-emerald-600"
                  }
                >
                  {suggestion.delta >= 0 ? "+" : ""}
                  {formatCurrency(suggestion.delta)}
                </span>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              {suggestion.confidence === "exact"
                ? "Detected a pending bill set whose total exactly matches this drop. Clear them?"
                : suggestion.confidence === "close"
                  ? `Detected a pending bill set whose total (${formatCurrency(suggestion.suggestedSum)}) is within $${suggestion.tolerance} of this drop. Clear them?`
                  : "Pending bills detected, but none match this drop. Select any that cleared, or just update the balance."}
            </div>
            <div className="grid gap-1 max-h-64 overflow-y-auto">
              {suggestion.pendingBills.map((b) => (
                <label
                  key={b.id}
                  className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2 cursor-pointer hover:bg-muted/40"
                  data-testid={`reconcile-bill-${b.id}`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selectedClearIds.has(b.id)}
                      onChange={() => toggleClearId(b.id)}
                      className="h-4 w-4"
                    />
                    <span className="text-sm">{b.name}</span>
                  </div>
                  <span className="font-mono text-sm">
                    {formatCurrency(b.amount)}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground font-mono">
              <span>Selected to clear</span>
              <span>
                {formatCurrency(
                  suggestion.pendingBills
                    .filter((b) => selectedClearIds.has(b.id))
                    .reduce((s, b) => s + b.amount, 0),
                )}
              </span>
            </div>
          </div>
        ) : (
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
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (suggestion) {
                setSuggestion(null);
                setSelectedClearIds(new Set());
              } else {
                setOpen(false);
              }
            }}
          >
            {suggestion ? "Back" : "Cancel"}
          </Button>
          <Button
            onClick={suggestion ? handleConfirmWithClears : handleSave}
            disabled={
              submitting || createBalance.isPending || (!suggestion && !amount)
            }
            data-testid="button-save-balance"
          >
            <RefreshCw
              className={cn(
                "mr-2 h-4 w-4",
                (submitting || createBalance.isPending) && "animate-spin",
              )}
            />
            {suggestion
              ? selectedClearIds.size > 0
                ? `Update + Clear ${selectedClearIds.size}`
                : "Update Balance Only"
              : "Save Balance"}
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
          queryClient.invalidateQueries({
            queryKey: getGetVariableSpendQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: ["dashboard-discretionary"],
          });
          // QS variable rows feed quicksilverOwed → totalRequiredHold → headline.
          // Cash rows don't, but a redundant refetch is cheap; invalidate uniformly.
          queryClient.invalidateQueries({
            queryKey: ["dashboard-cash-position"],
          });
          queryClient.invalidateQueries({
            queryKey: getGetDashboardCycleQueryKey(),
          });
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
          queryClient.invalidateQueries({
            queryKey: ["dashboard-discretionary"],
          });
          queryClient.invalidateQueries({
            queryKey: ["dashboard-cash-position"],
          });
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
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
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
            Undated items aren't reserved in Safe-to-Spend. Set a due date to
            include them.
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

// R-as-truth — Variable reserved pill on Overview. Tap the number to edit
// R directly. R is what Available-to-Save subtracts from commitmentBalance.
// The log feeds nothing here; it's an audit history only. When L > R the
// pill surfaces "(spent $L)" in red as awareness. Prorate button sets R to
// cap × daysRemaining / daysInMonth (time-aware suggestion the user can
// then keep, adjust, or override). Reset clears the override → R falls
// back to variable_spend_cap.
function VariableEstimateEditor({
  R,
  logged,
  isOverridden,
  fallbackCap,
  daysRemaining,
  daysInMonth,
  monthKey,
}: {
  R: number;
  logged: number;
  isOverridden: boolean;
  fallbackCap: number;
  daysRemaining: number;
  daysInMonth: number;
  monthKey: string;
}) {
  // MONTH-SCOPED override key (mirrors income_override per-period scoping). The
  // engine reads this exact key for the current month; absent → R auto-resets.
  const overrideKey = `planned_variable_remaining_override:${monthKey}`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(R.toFixed(2));
  const committedRef = useRef(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateMut = useUpdateAssumption();

  useEffect(() => {
    if (!editing) setDraft(R.toFixed(2));
  }, [R, editing]);

  const overBy = Math.max(0, logged - R);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-cash-position"] });
    queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
  };

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = draft.trim();
    const parsed = trimmed === "" ? null : parseFloat(trimmed);
    // R = literal user input. Zero is a deliberate "reserve nothing more"
    // state (headline returns to baseline). Empty field is the explicit
    // reset-to-cap path. Only negative values are rejected.
    if (trimmed !== "" && (parsed === null || isNaN(parsed) || parsed < 0)) {
      toast({
        title: "Enter a non-negative number or leave blank to reset",
        variant: "destructive",
      });
      setDraft(R.toFixed(2));
      setEditing(false);
      return;
    }
    updateMut.mutate(
      {
        key: overrideKey,
        data: { value: trimmed === "" ? "" : String(parsed) },
      },
      {
        onSuccess: () => {
          invalidateAll();
          setEditing(false);
        },
        onError: () => {
          toast({ title: "Update failed", variant: "destructive" });
          setDraft(R.toFixed(2));
          setEditing(false);
        },
      },
    );
  };

  const reset = () => {
    updateMut.mutate(
      {
        key: overrideKey,
        data: { value: "" },
      },
      {
        onSuccess: () => {
          invalidateAll();
          toast({ title: `Reset to cap (${formatCurrency(fallbackCap)})` });
        },
      },
    );
  };

  const prorate = () => {
    // Time-aware suggestion: cap × (days remaining / days in month).
    // Floor at $0. Round to cents.
    const safeDays = Math.max(1, daysInMonth);
    const prorated =
      Math.round(Math.max(0, (fallbackCap * daysRemaining) / safeDays) * 100) /
      100;
    updateMut.mutate(
      {
        key: overrideKey,
        data: { value: String(prorated) },
      },
      {
        onSuccess: () => {
          invalidateAll();
          toast({
            title: `Prorated to ${formatCurrency(prorated)} (${daysRemaining}/${daysInMonth} days × cap)`,
          });
        },
        onError: () =>
          toast({ title: "Prorate failed", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-muted-foreground">Variable reserved</span>
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
                setDraft(R.toFixed(2));
                setEditing(false);
              }
            }}
            className="w-24 text-right font-mono bg-background border border-border rounded px-2 py-0.5 text-xs"
            data-testid="input-variable-R"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="font-mono hover:underline decoration-dotted underline-offset-4 text-foreground"
            data-testid="button-edit-variable-R"
            title="Tap to edit how much you've reserved for variable spending"
          >
            {formatCurrency(R)}
          </button>
        )}
        {overBy > 0 && !editing && (
          <span
            className="text-destructive font-mono text-[10px] ml-1"
            data-testid="text-variable-overspend"
          >
            (spent {formatCurrency(logged)})
          </span>
        )}
        {!editing && (
          <button
            type="button"
            onClick={prorate}
            className="text-[9px] text-muted-foreground hover:text-foreground uppercase tracking-wider ml-1 border border-border rounded px-1.5 py-0.5"
            data-testid="button-prorate-variable-R"
            title={`Set R to cap × days remaining ÷ days in month (${daysRemaining}/${daysInMonth})`}
          >
            prorate
          </button>
        )}
        {isOverridden && !editing && (
          <button
            type="button"
            onClick={reset}
            className="text-[9px] text-muted-foreground hover:text-foreground uppercase tracking-wider ml-1"
            data-testid="button-reset-variable-R"
          >
            reset
          </button>
        )}
      </span>
    </div>
  );
}

function Row({
  label,
  value,
  negative,
  bold,
  sublabel,
}: {
  label: string;
  value: number;
  negative?: boolean;
  bold?: boolean;
  sublabel?: string;
}) {
  return (
    <div
      className={cn(
        "py-1",
        bold
          ? "border-t-2 border-border pt-2 font-bold"
          : "border-b border-border/40",
        negative ? "text-destructive" : "",
      )}
    >
      <div className="flex justify-between">
        <span className={negative ? "" : "text-muted-foreground"}>{label}</span>
        <span>{formatCurrency(value)}</span>
      </div>
      {sublabel && (
        <p className="text-[10px] text-muted-foreground/70 italic mt-0.5">
          {sublabel}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v8.3 — Cash Position Card
//
// Answers: "What will my checking ACTUALLY look like at month end, given some
// 'paid' bills haven't actually debited yet?" Per-bill toggle lets the user
// flip a bill between "cleared" (money already left checking) and "not yet"
// (still pending debit) in one click — no need to navigate to the Bills page.
// ---------------------------------------------------------------------------

interface CashPositionResp {
  asOf: string;
  monthEnd: string;
  currentChecking: number;
  lastBalanceUpdate: string | null;
  daysSinceUpdate: number | null;
  incomeStillToReceive: number;
  paychecksStillExpected: { date: string; amount: number }[];
  pendingCommissionUnreceived: number;
  billsAlreadyDebited: number;
  billsAlreadyDebitedDetail: CashBillRow[];
  billsNotYetDebited: number;
  billsNotYetDebitedDetail: CashBillRow[];
  variableExpectedRemaining: number;
  variableExpectedRemainingCash: number;
  variableExpectedRemainingQs: number;
  quicksilverAccruedRatio: number;
  oneTimeStillToPay: number;
  oneTimeStillToPayDetail: {
    id: number;
    description: string;
    amount: number;
    dueDate: string | null;
  }[];
  commitmentOutflowsRemaining: number;
  commitmentBalance: number;
  availableToInvest: number;
  earlyNextMonthVariable: number;
  totalCashOutflowsRemaining: number;
  projectedEndOfMonthChecking: number;
  isDeficit: boolean;
  isTight: boolean;
}

interface CashBillRow {
  id: number;
  name: string;
  amount: number;
  dueDay: number;
  paymentState: string;
  paidDate: string | null;
  clearedDate: string | null;
  cashStatus: "debited" | "pending" | "late" | "scheduled";
}

function CashPositionCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateBill = useUpdateBill();
  const { data, isLoading } = useQuery<CashPositionResp>({
    queryKey: ["dashboard-cash-position"],
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/dashboard/cash-position`);
      if (!r.ok) throw new Error("Failed to load cash position");
      return r.json();
    },
  });
  // A+E hint — pull trailingDailyRate + daysRemainingInMonth from the
  // discretionary query that's already loaded by the parent Dashboard.
  // React Query dedupes on key — no extra network round-trip.
  const { data: discretionary } = useQuery<DiscretionaryResp>({
    queryKey: ["dashboard-discretionary"],
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/dashboard/discretionary`);
      if (!r.ok) throw new Error("Failed to load discretionary");
      return r.json();
    },
  });
  // D1 reconciliation — also pull cycle so the math chain can mirror
  // head = commitmentBalance − F = (currentChecking − totalRequiredHold) − F
  // using cycle.* addends as labeled rows. React Query dedupes on key —
  // parent Dashboard already fetched, so this is a cache hit.
  const { data: cycle } = useGetDashboardCycle({
    query: { queryKey: getGetDashboardCycleQueryKey() },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dashboard-cash-position"] });
    qc.invalidateQueries({ queryKey: ["dashboard-discretionary"] });
    qc.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
    qc.invalidateQueries({ queryKey: getGetBillsQueryKey() });
  };

  const setBillCashStatus = (bill: CashBillRow, debited: boolean) => {
    const today = new Date().toISOString().split("T")[0];
    // debited=true → state=paid (server stamps clearedDate=now)
    // debited=false → keep obligation but mark unclear:
    //   if was paid → flip to paid_pending_clear (server clears clearedDate)
    //   if was late_unpaid → keep late_unpaid (already represents un-debited)
    const next: "paid" | "paid_pending_clear" | "late_unpaid" = debited
      ? "paid"
      : bill.paymentState === "late_unpaid"
        ? "late_unpaid"
        : "paid_pending_clear";
    updateBill.mutate(
      {
        id: bill.id,
        data: {
          paymentState: next,
          paidDate:
            next === "paid" || next === "paid_pending_clear" ? today : null,
        },
      },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: debited
              ? `Marked ${bill.name} as debited`
              : `Marked ${bill.name} as not yet debited`,
          });
        },
        onError: () =>
          toast({ title: "Failed to update bill", variant: "destructive" }),
      },
    );
  };

  if (isLoading || !data) {
    return <Skeleton className="h-48 w-full rounded-xl" />;
  }

  // v10 — Headline = availableToInvest = commitmentBalance − F.
  // F (estimated future variable, full) is folded into the save-decision
  // number. F never enters totalRequiredHold; the cycle's quicksilverOwed
  // carries the hold side. Projected EOM still uses F_cash only — it's a
  // cash-trajectory number, not a save-decision number.
  const head = data.availableToInvest;
  const eom = data.projectedEndOfMonthChecking;
  const headColor =
    head < 0
      ? "text-destructive"
      : head < 100
        ? "text-warning"
        : "text-success";
  const eomColor =
    eom < 0 ? "text-destructive" : eom < 100 ? "text-warning" : "text-success";
  const borderColor =
    head < 0
      ? "border-l-destructive"
      : head < 100
        ? "border-l-warning"
        : "border-l-success";

  // A+E pace hint — informational only. Headline math unchanged; this sublabel
  // tells the user how F compares to trailing burn so they can decide whether
  // to lower E. Suppressed when:
  //   • discretionary cache hasn't loaded (paceImpliedF null)
  //   • pace and reserved F are within $1 (noise; no signal)
  //   • pace > reserved F (no over-reservation; pill surfaces overspend separately)
  // When dayOfMonth < 7 OR L = 0, the route's trailingDailyRate falls back to
  // variableCap/monthLengthDays; label that "Cap-rate pace" so it isn't sold
  // as observed burn.
  const trailingRate = discretionary?.trailingDailyRate ?? null;
  const daysLeft = discretionary?.daysRemainingInMonth ?? null;
  const logged = discretionary?.variableLoggedThisMonth ?? null;
  const localDayOfMonth = new Date().getDate();
  const isCapRateFallback =
    logged !== null && (localDayOfMonth < 7 || logged === 0);
  const paceImpliedF =
    trailingRate !== null && daysLeft !== null ? trailingRate * daysLeft : null;
  const reservedF = data.variableExpectedRemaining;
  const showPaceHint =
    paceImpliedF !== null &&
    Math.abs(paceImpliedF - reservedF) >= 1 &&
    paceImpliedF < reservedF;

  return (
    <section
      className={cn(
        "rounded-xl bg-card overflow-hidden border border-border border-l-4",
        borderColor,
      )}
      data-testid="cash-position-card"
    >
      <div className="p-6">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-widest">
              Available to Move to HYSA / Investments
            </p>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              The dollar amount you can safely sweep to savings or brokerage
              right now without bouncing a known obligation AND while still
              funding the planned variable spend for the rest of the month.
            </p>
          </div>
          <div className="text-right">
            <h3
              className={cn(
                "text-4xl font-bold font-mono tracking-tighter",
                headColor,
              )}
              data-testid="text-commitment-balance"
            >
              {formatCurrency(head)}
            </h3>
            {data.isDeficit && (
              <p
                className="text-xs text-destructive font-mono mt-1"
                data-testid="text-available-deficit"
              >
                can&apos;t save this month — {formatCurrency(Math.abs(head))}{" "}
                short of your reserve
              </p>
            )}
            {data.isTight && (
              <p className="text-xs text-warning font-mono mt-1">
                tight — under $100 cushion
              </p>
            )}
          </div>
        </div>

        {/* D1 — reconciled math chain. Mirrors the headline EXACTLY:
            availableToInvest = checking − commitmentOutflowsRemaining − R.
            Only these three rows; each reads data.* the headline uses, so the
            chain sums to head. The full-hold "Reserve-aware balance (Checking −
            Required Hold)" line and the "Early next-month variable" line were
            removed — they belong to the cycle / Safe-to-Spend view, not this
            savable headline, and made the chain contradict head. */}
        <div className="space-y-1.5 font-mono text-sm border-t border-border/30 pt-3">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Checking now</span>
            <span>{formatCurrency(data.currentChecking)}</span>
          </div>
          <div className="flex justify-between text-destructive">
            <span>− Bills still to pay this month</span>
            <span>−{formatCurrency(data.commitmentOutflowsRemaining)}</span>
          </div>
          <div className="flex justify-between text-destructive">
            <span>− Variable reserved (R)</span>
            <span>−{formatCurrency(data.variableExpectedRemaining)}</span>
          </div>
          {showPaceHint && (
            <p
              className="text-[10px] text-muted-foreground/70 italic -mt-1 pl-2"
              data-testid="text-pace-hint"
            >
              {isCapRateFallback ? "Cap-rate pace" : "Trailing pace"}:{" "}
              {formatCurrency(trailingRate!)}/day · {daysLeft} day
              {daysLeft === 1 ? "" : "s"} left · pace-implied R ≈{" "}
              {formatCurrency(paceImpliedF!)}. R currently reserves{" "}
              {formatCurrency(reservedF)}. Tap <strong>Prorate</strong> on the
              pill to set R to the pace-implied value.
            </p>
          )}
          <div
            className={cn(
              "flex justify-between font-bold border-t border-border/30 pt-2 mt-1",
              headColor,
            )}
          >
            <span>= Available to move to HYSA / investments</span>
            <span>{formatCurrency(head)}</span>
          </div>
        </div>

        {/* Secondary projection — including future variable */}
        {data.variableExpectedRemainingCash > 0 && (
          <div className="mt-4 pt-3 border-t border-border/30 space-y-1.5 font-mono text-sm">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
              If you also spend the planned variable budget
            </p>
            <div className="flex justify-between text-destructive">
              <span>
                − Variable still to spend from checking
                {data.quicksilverAccruedRatio > 0 && (
                  <span className="text-[10px] text-muted-foreground ml-1">
                    ({Math.round((1 - data.quicksilverAccruedRatio) * 100)}%
                    cash, rest on QS card)
                  </span>
                )}
              </span>
              <span>−{formatCurrency(data.variableExpectedRemainingCash)}</span>
            </div>
            <div className={cn("flex justify-between font-medium", eomColor)}>
              <span>= Projected end-of-month checking</span>
              <span>{formatCurrency(eom)}</span>
            </div>
            <p className="text-[10px] text-muted-foreground/70 italic">
              Variable reservation (R) editable via the &ldquo;Variable
              reserved&rdquo; pill on the Overview headline above. Cash portion
              shown here is R split by the logged QS:cash mix so the projection
              stays in sync with the headline.
            </p>
          </div>
        )}

        {/* Per-bill toggles — the actual fix the user asked for */}
        {data.billsNotYetDebitedDetail.length > 0 && (
          <div className="mt-5 pt-4 border-t border-border/30">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
              Bills this month, not yet debited — toggle if money already left
            </p>
            <p className="text-[10px] text-muted-foreground/70 italic mb-2 normal-case tracking-normal">
              Calendar-month informational list. The cycle hold above is what
              drives the headline.
            </p>
            <ul className="space-y-1.5">
              {data.billsNotYetDebitedDetail
                .sort((a, b) => a.dueDay - b.dueDay)
                .map((b) => (
                  <li
                    key={b.id}
                    className="flex items-center justify-between gap-3 text-sm font-mono py-1.5 px-2 rounded hover:bg-muted/50"
                    data-testid={`cash-bill-row-${b.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <span className="truncate">{b.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">
                        day {b.dueDay}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] uppercase tracking-wider ml-2 px-1.5 py-0.5 rounded",
                          b.cashStatus === "late"
                            ? "bg-destructive/20 text-destructive"
                            : "bg-warning/20 text-warning",
                        )}
                      >
                        {b.cashStatus === "late" ? "late" : "pending"}
                      </span>
                    </div>
                    <span className="text-right tabular-nums w-20">
                      −{formatCurrency(b.amount)}
                    </span>
                    <div className="flex items-center gap-0.5 border rounded overflow-hidden text-[10px] uppercase tracking-wider">
                      <button
                        onClick={() => setBillCashStatus(b, true)}
                        className="px-2 py-0.5 hover-elevate text-success"
                        data-testid={`button-mark-debited-${b.id}`}
                        title="Money has actually left checking"
                      >
                        Debited
                      </button>
                      <button
                        disabled
                        className={cn(
                          "px-2 py-0.5",
                          b.cashStatus === "late"
                            ? "bg-destructive/20 text-destructive"
                            : "bg-warning/20 text-warning",
                        )}
                      >
                        Not yet
                      </button>
                    </div>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {data.billsAlreadyDebitedDetail.length > 0 && (
          <div className="mt-4 pt-3 border-t border-border/30">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
              Bills already paid this month (
              {formatCurrency(data.billsAlreadyDebited)})
            </p>
            <p className="text-[10px] text-muted-foreground/70 italic mb-2 normal-case tracking-normal">
              Already reflected in &ldquo;Checking now&rdquo; — not subtracted
              again.
            </p>
            <ul className="space-y-1">
              {data.billsAlreadyDebitedDetail
                .sort((a, b) => a.dueDay - b.dueDay)
                .map((b) => (
                  <li
                    key={b.id}
                    className="flex items-center justify-between gap-3 text-xs font-mono text-muted-foreground"
                  >
                    <span className="flex-1 truncate">
                      {b.name}{" "}
                      <span className="text-[10px]">(day {b.dueDay})</span>
                    </span>
                    <span className="tabular-nums w-20 text-right">
                      {formatCurrency(b.amount)}
                    </span>
                    <button
                      onClick={() => setBillCashStatus(b, false)}
                      className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border hover-elevate"
                      data-testid={`button-mark-pending-${b.id}`}
                      title="Money has NOT actually left checking yet"
                    >
                      Undo
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
