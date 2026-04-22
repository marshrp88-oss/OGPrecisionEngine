import { useState } from "react";
import {
  useGetIntegrityStatus,
  getGetIntegrityStatusQueryKey,
} from "@workspace/api-client-react";
import { AlertTriangle, ShieldAlert, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface IntegrityCheck {
  checkNumber: number;
  description: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

export function IntegrityStatusBanner({ className }: { className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useGetIntegrityStatus({
    query: {
      queryKey: getGetIntegrityStatusQueryKey(),
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
      staleTime: 5_000,
    },
  });

  if (isLoading || !data) return null;
  if (data.overallStatus === "pass") return null;

  const isFail = data.overallStatus === "fail";
  const checks = (data.checks ?? []) as IntegrityCheck[];
  const issues = checks.filter((c) => c.status === "fail" || c.status === "warn");
  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;

  return (
    <div
      role={isFail ? "alert" : "status"}
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        isFail
          ? "border-destructive/50 bg-destructive/10 text-destructive-foreground"
          : "border-amber-500/40 bg-amber-500/10 text-amber-200",
        className,
      )}
      data-testid="integrity-banner"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {isFail ? (
            <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
          ) : (
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          )}
          <div className="min-w-0">
            <div className={cn("font-semibold", isFail ? "text-destructive" : "text-amber-300")}>
              {isFail
                ? "Integrity check FAILED — decisions are locked"
                : "Integrity warnings present"}
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
          aria-label={expanded ? "Hide failure details" : "Show failure details"}
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
      {expanded && issues.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-current/20 pt-3 text-xs">
          {issues.map((c) => (
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
  );
}
