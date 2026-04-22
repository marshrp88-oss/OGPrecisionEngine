import { useState } from "react";
import {
  useGetIntegrityStatus,
  getGetIntegrityStatusQueryKey,
} from "@workspace/api-client-react";
import { AlertTriangle, ShieldAlert, ChevronDown, ChevronUp, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface IntegrityCheck {
  checkNumber: number;
  description: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

// Engine: data + math + discipline (real-time signals you must act on).
// Advisory: standing configuration & known decisions.
const ENGINE_CHECKS = new Set([1, 2, 3, 4, 11, 12, 13]);

function pickWorst(
  checks: IntegrityCheck[],
): "pass" | "warn" | "fail" {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

export function IntegrityStatusBanner({ className }: { className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showAdvisory, setShowAdvisory] = useState(false);
  const { data, isLoading } = useGetIntegrityStatus({
    query: {
      queryKey: getGetIntegrityStatusQueryKey(),
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
      staleTime: 5_000,
    },
  });

  if (isLoading || !data) return null;

  const checks = (data.checks ?? []) as IntegrityCheck[];
  const engineChecks = checks.filter((c) => ENGINE_CHECKS.has(c.checkNumber));
  const advisoryChecks = checks.filter((c) => !ENGINE_CHECKS.has(c.checkNumber));

  const engineStatus = pickWorst(engineChecks);
  const advisoryIssues = advisoryChecks.filter(
    (c) => c.status === "fail" || c.status === "warn",
  );
  const engineIssues = engineChecks.filter(
    (c) => c.status === "fail" || c.status === "warn",
  );

  const hasEngineIssue = engineStatus !== "pass";
  const hasAdvisoryIssue = advisoryIssues.length > 0;

  // Nothing to show at all.
  if (!hasEngineIssue && !hasAdvisoryIssue) return null;

  const isFail = engineStatus === "fail";
  const failCount = engineChecks.filter((c) => c.status === "fail").length;
  const warnCount = engineChecks.filter((c) => c.status === "warn").length;

  return (
    <div className={cn("space-y-2", className)} data-testid="integrity-banner">
      {hasEngineIssue && (
        <div
          role={isFail ? "alert" : "status"}
          className={cn(
            "rounded-lg border px-4 py-3 text-sm",
            isFail
              ? "border-destructive/50 bg-destructive/10 text-destructive-foreground"
              : "border-amber-500/40 bg-amber-500/10 text-amber-200",
          )}
          data-testid="integrity-banner-engine"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {isFail ? (
                <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
              ) : (
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              )}
              <div className="min-w-0">
                <div
                  className={cn(
                    "font-semibold",
                    isFail ? "text-destructive" : "text-amber-300",
                  )}
                >
                  {isFail
                    ? "Engine integrity FAILED — decisions are locked"
                    : "Engine attention needed"}
                </div>
                <div className="text-xs opacity-80 truncate">
                  {failCount > 0 && `${failCount} failure${failCount === 1 ? "" : "s"}`}
                  {failCount > 0 && warnCount > 0 && " · "}
                  {warnCount > 0 && `${warnCount} warning${warnCount === 1 ? "" : "s"}`}
                  {" · last checked "}
                  {new Date(data.runAt).toLocaleTimeString("en-US", {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 h-7 text-xs"
              onClick={() => setExpanded((e) => !e)}
              aria-label={expanded ? "Hide details" : "Show details"}
            >
              {expanded ? (
                <>
                  Hide <ChevronUp className="h-3 w-3 ml-1" />
                </>
              ) : (
                <>
                  Details <ChevronDown className="h-3 w-3 ml-1" />
                </>
              )}
            </Button>
          </div>
          {expanded && engineIssues.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-current/20 pt-3 text-xs">
              {engineIssues.map((c) => (
                <li key={c.checkNumber} className="flex gap-2">
                  <span
                    className={cn(
                      "shrink-0 font-mono font-semibold",
                      c.status === "fail" ? "text-destructive" : "text-amber-400",
                    )}
                  >
                    #{c.checkNumber}
                  </span>
                  <span className="opacity-90">
                    <span className="font-semibold">{c.description}:</span> {c.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {hasAdvisoryIssue && (
        <div
          className="rounded-lg border border-muted-foreground/20 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          data-testid="integrity-banner-advisory"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Info className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                {advisoryIssues.length} advisory note
                {advisoryIssues.length === 1 ? "" : "s"} (standing configuration)
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 h-6 text-xs"
              onClick={() => setShowAdvisory((s) => !s)}
              aria-label={showAdvisory ? "Hide advisory" : "Show advisory"}
            >
              {showAdvisory ? "Hide" : "View"}
            </Button>
          </div>
          {showAdvisory && (
            <ul className="mt-2 space-y-1 border-t border-current/20 pt-2">
              {advisoryIssues.map((c) => (
                <li key={c.checkNumber} className="flex gap-2">
                  <span className="shrink-0 font-mono opacity-60">
                    #{c.checkNumber}
                  </span>
                  <span>
                    <span className="font-semibold">{c.description}:</span> {c.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
