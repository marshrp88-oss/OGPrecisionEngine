import { useState } from "react";
import {
  useGetIntegrityStatus,
  getGetIntegrityStatusQueryKey,
  useRunIntegrityCheck,
  getGetDashboardCycleQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, AlertTriangle, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

interface IntegrityCheck {
  checkNumber: number;
  description: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

// v9 Fix 4 — every emitted check counts toward the pill. Previously a
// hardcoded subset {1,2,3,4,11,12,13} silently hid failures from other
// checks (e.g. stale-payday FAIL was invisible). The set now contains
// every check number actually emitted so the badge can never undercount.
const ENGINE_CHECKS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

export function IntegrityChip({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading } = useGetIntegrityStatus({
    query: {
      queryKey: getGetIntegrityStatusQueryKey(),
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
      staleTime: 5_000,
    },
  });
  const runIntegrity = useRunIntegrityCheck();

  if (isLoading || !data) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground",
          className,
        )}
        aria-busy="true"
      >
        <RefreshCw className="h-3 w-3 animate-spin" />
        Checking…
      </span>
    );
  }

  const checks = (data.checks ?? []) as IntegrityCheck[];
  const engineChecks = checks.filter((c) => ENGINE_CHECKS.has(c.checkNumber));
  const failCount = engineChecks.filter((c) => c.status === "fail").length;
  const warnCount = engineChecks.filter((c) => c.status === "warn").length;

  const status: "pass" | "warn" | "fail" =
    failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";

  const styles = {
    pass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    fail: "border-destructive/50 bg-destructive/15 text-destructive",
  } as const;

  const icon =
    status === "fail" ? (
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
    ) : status === "warn" ? (
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
    ) : (
      <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
    );

  const label =
    status === "fail"
      ? `${failCount} engine fail`
      : status === "warn"
        ? `${warnCount} warn`
        : "Engine clean";

  const handleRefresh = () => {
    runIntegrity.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetIntegrityStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
      },
    });
  };

  const issuesEngine = engineChecks.filter(
    (c) => c.status === "fail" || c.status === "warn",
  );
  const advisory = checks.filter((c) => !ENGINE_CHECKS.has(c.checkNumber));
  const issuesAdvisory = advisory.filter(
    (c) => c.status === "fail" || c.status === "warn",
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label={`Open integrity details — ${label}`}
          data-testid="integrity-chip"
          className={cn(
            "reserve-animate inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
            "hover:opacity-80 active:opacity-70",
            styles[status],
            className,
          )}
        >
          {icon}
          <span data-testid="integrity-chip-label">{label}</span>
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[92vw] max-w-md flex flex-col p-0">
        <SheetHeader className="border-b border-border px-4 py-3 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            {icon}
            Integrity status
          </SheetTitle>
          <p className="text-xs text-muted-foreground">
            Last checked{" "}
            {new Date(data.runAt).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Engine ({issuesEngine.length} issue{issuesEngine.length === 1 ? "" : "s"})
            </h3>
            {issuesEngine.length === 0 ? (
              <p className="text-sm text-emerald-400">All engine checks pass.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {issuesEngine.map((c) => (
                  <li
                    key={c.checkNumber}
                    className="rounded border border-border/60 px-3 py-2"
                    data-testid={`chip-issue-${c.checkNumber}`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "font-mono text-xs font-semibold",
                          c.status === "fail" ? "text-destructive" : "text-amber-400",
                        )}
                      >
                        #{c.checkNumber}
                      </span>
                      <span className="font-semibold">{c.description}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{c.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {issuesAdvisory.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Advisory ({issuesAdvisory.length})
              </h3>
              <ul className="space-y-2 text-sm">
                {issuesAdvisory.map((c) => (
                  <li
                    key={c.checkNumber}
                    className="rounded border border-muted-foreground/20 bg-muted/30 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs opacity-60">#{c.checkNumber}</span>
                      <span className="font-semibold">{c.description}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{c.detail}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={runIntegrity.isPending}
            data-testid="chip-refresh"
            className="flex-1"
          >
            <RefreshCw className={cn("mr-2 h-3.5 w-3.5", runIntegrity.isPending && "animate-spin")} />
            Re-run check
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
