import {
  useGetDashboardCycle,
  getGetDashboardCycleQueryKey,
  useGetMonthlySavings,
  getGetMonthlySavingsQueryKey,
  useRunIntegrityCheck,
} from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Activity, RefreshCw, Database, AlertTriangle, CheckCircle2, AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

interface DiscretionaryResponse {
  discretionaryThisMonth: number;
  checking?: number;
  remainingPaychecksThisMonth?: number;
  baseNetIncome?: number;
  confirmedCommissionUnreceived?: number;
  totalInflowsAvailable?: number;
  billsRemainingThisMonth?: number;
  oneTimeDatedThisMonth?: number;
  variableCapRemainingThisMonth?: number;
  quicksilverBalanceOwed?: number;
  minimumCushion?: number;
  monthEnd?: string;
}

const fmt = (n: number | null | undefined) =>
  typeof n === "number"
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    : "—";

const fmtCompact = (n: number | null | undefined) =>
  typeof n === "number"
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
    : "—";

export function AdvisorSnapshotDrawer() {
  const [open, setOpen] = useState(false);
  const [discretionary, setDiscretionary] = useState<DiscretionaryResponse | null>(null);
  const [integrity, setIntegrity] = useState<{
    overallStatus: string;
    failures: { name: string; message: string }[];
    warnings: { name: string; message: string }[];
  } | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: cycle } = useGetDashboardCycle({
    query: { queryKey: getGetDashboardCycleQueryKey(), enabled: open },
  });
  const { data: savings } = useGetMonthlySavings({
    query: { queryKey: getGetMonthlySavingsQueryKey(), enabled: open },
  });
  const runIntegrity = useRunIntegrityCheck();

  useEffect(() => {
    if (!open) return;
    fetch(`${BASE_URL}/api/dashboard/discretionary`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDiscretionary(d))
      .catch(() => setDiscretionary(null));
  }, [open]);

  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
    await queryClient.invalidateQueries({ queryKey: getGetMonthlySavingsQueryKey() });
    fetch(`${BASE_URL}/api/dashboard/discretionary`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDiscretionary(d));
    runIntegrity.mutate(undefined, {
      onSuccess: (r) => {
        setIntegrity({
          overallStatus: r.overallStatus,
          failures: r.checks.filter((c) => c.status === "fail").map((c) => ({ name: c.description, message: c.detail ?? "" })),
          warnings: r.checks.filter((c) => c.status === "warn").map((c) => ({ name: c.description, message: c.detail ?? "" })),
        });
      },
    });
    toast({ title: "Snapshot refreshed" });
  };

  const stale = cycle?.daysSinceUpdate != null && cycle.daysSinceUpdate > 3;
  const safeToSpendColor =
    !cycle || cycle.safeToSpend == null
      ? "text-muted-foreground"
      : cycle.safeToSpend < 0
      ? "text-destructive"
      : cycle.safeToSpend < 100
      ? "text-amber-500"
      : "text-emerald-500";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-snapshot-drawer">
          <Database className="mr-2 h-3.5 w-3.5" />
          Snapshot
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Live Data Snapshot
          </SheetTitle>
          <SheetDescription className="text-xs">
            What the advisor sees right now. Refresh after updating balances.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6 space-y-4">
          <Button onClick={refreshAll} variant="outline" size="sm" className="w-full" disabled={runIntegrity.isPending}>
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${runIntegrity.isPending ? "animate-spin" : ""}`} />
            Refresh snapshot &amp; integrity
          </Button>

          {/* Cycle metrics */}
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider font-mono text-muted-foreground">Cycle</h3>
            <div className="grid grid-cols-2 gap-2">
              <SnapshotStat
                label="Safe to Spend"
                value={fmt(cycle?.safeToSpend)}
                valueClassName={`text-lg font-semibold ${safeToSpendColor}`}
              />
              <SnapshotStat label="Days of Coverage" value={cycle?.daysOfCoverage != null ? `${cycle.daysOfCoverage.toFixed(1)} d` : "—"} />
              <SnapshotStat label="Daily Rate" value={cycle?.dailyRateRealTime != null ? fmt(cycle.dailyRateRealTime) + "/d" : "—"} />
              <SnapshotStat label="Required Hold" value={fmt(cycle?.totalRequiredHold)} />
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Checking</span>
              <span className="font-mono">{fmt(cycle?.checkingBalance)}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Last update</span>
              <Badge variant={stale ? "destructive" : "secondary"} className="font-mono text-[10px]">
                {cycle?.daysSinceUpdate != null ? `${cycle.daysSinceUpdate}d ago` : "never"}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Next payday</span>
              <span className="font-mono">{cycle?.nextPayday ? new Date(cycle.nextPayday).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}</span>
            </div>
          </div>

          <Separator />

          {/* Monthly metrics */}
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider font-mono text-muted-foreground">Month</h3>
            <div className="grid grid-cols-2 gap-2">
              <SnapshotStat label="Discretionary (Mo)" value={fmt(discretionary?.discretionaryThisMonth)} />
              <SnapshotStat label="Est. Monthly Savings" value={fmt(savings?.estimatedMonthlySavings)} />
            </div>
            {discretionary && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Show breakdown</summary>
                <div className="mt-2 space-y-1 pl-2 border-l border-border font-mono text-[11px]">
                  <Row label="Total inflows available" value={fmtCompact(discretionary.totalInflowsAvailable)} valueClass="font-mono" />
                  <Row label="− Bills remaining" value={fmtCompact(discretionary.billsRemainingThisMonth)} valueClass="font-mono" />
                  <Row label="− One-time dated" value={fmtCompact(discretionary.oneTimeDatedThisMonth)} valueClass="font-mono" />
                  <Row label="− Variable cap remaining" value={fmtCompact(discretionary.variableCapRemainingThisMonth)} valueClass="font-mono" />
                  <Row label="− QuickSilver owed" value={fmtCompact(discretionary.quicksilverBalanceOwed)} valueClass="font-mono" />
                  <Row label="− Min cushion" value={fmtCompact(discretionary.minimumCushion)} valueClass="font-mono" />
                </div>
              </details>
            )}
          </div>

          <Separator />

          {/* Income context */}
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider font-mono text-muted-foreground">Income context</h3>
            <div className="space-y-1 text-xs">
              <Row label="Base net (mo)" value={fmt(savings?.baseNetIncome)} />
              <Row label="Confirmed commission" value={fmt(savings?.confirmedCommission)} />
              <Row label="Total month income" value={fmt(savings?.totalMonthIncome)} />
              <Row label="Forward reserve" value={fmt(savings?.forwardReserve)} />
            </div>
          </div>

          <Separator />

          {/* Integrity */}
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wider font-mono text-muted-foreground flex items-center justify-between">
              <span>Integrity</span>
              {integrity ? (
                integrity.overallStatus === "pass" ? (
                  <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-0">
                    <CheckCircle2 className="mr-1 h-3 w-3" />PASS
                  </Badge>
                ) : integrity.overallStatus === "fail" ? (
                  <Badge variant="destructive">
                    <AlertTriangle className="mr-1 h-3 w-3" />FAIL
                  </Badge>
                ) : (
                  <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-0">
                    <AlertCircle className="mr-1 h-3 w-3" />WARN
                  </Badge>
                )
              ) : (
                <span className="text-[10px] text-muted-foreground">not run</span>
              )}
            </h3>
            {integrity?.failures.map((f, i) => (
              <div key={`f-${i}`} className="text-xs p-2 rounded bg-destructive/10 text-destructive">
                <div className="font-medium">{f.name}</div>
                {f.message && <div className="text-[11px] opacity-80">{f.message}</div>}
              </div>
            ))}
            {integrity?.warnings.map((w, i) => (
              <div key={`w-${i}`} className="text-xs p-2 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <div className="font-medium">{w.name}</div>
                {w.message && <div className="text-[11px] opacity-80">{w.message}</div>}
              </div>
            ))}
            {integrity && integrity.failures.length === 0 && integrity.warnings.length === 0 && (
              <p className="text-xs text-muted-foreground">All checks passing.</p>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SnapshotStat({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">{label}</div>
      <div className={valueClassName ?? "text-sm font-mono font-semibold mt-0.5"}>{value}</div>
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${valueClass ?? ""}`}>{value}</span>
    </div>
  );
}
