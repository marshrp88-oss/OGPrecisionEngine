import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetBalances,
  useGetVariableSpend,
  useGetOneTimeExpenses,
  useGetCommissions,
  getGetBalancesQueryKey,
  getGetVariableSpendQueryKey,
  getGetOneTimeExpensesQueryKey,
  getGetCommissionsQueryKey,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, AlertTriangle, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "reserve.lastChecklistDate";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nextNominalPayday(today: Date): Date {
  const day = today.getDate();
  if (day < 7) return new Date(today.getFullYear(), today.getMonth(), 7);
  if (day < 22) return new Date(today.getFullYear(), today.getMonth(), 22);
  return new Date(today.getFullYear(), today.getMonth() + 1, 7);
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function SessionStartChecklist() {
  const [open, setOpen] = useState(false);
  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const [, navigate] = useLocation();

  const { data: balances } = useGetBalances({
    query: { enabled: open, queryKey: getGetBalancesQueryKey() },
  });
  const { data: vs } = useGetVariableSpend(undefined, {
    query: { enabled: open, queryKey: getGetVariableSpendQueryKey() },
  });
  const { data: oneTimes } = useGetOneTimeExpenses({
    query: { enabled: open, queryKey: getGetOneTimeExpensesQueryKey() },
  });
  const { data: commissions } = useGetCommissions({
    query: { enabled: open, queryKey: getGetCommissionsQueryKey() },
  });

  // Manual trigger only — listen for "reserve:open-checklist" custom event.
  // Auto-open removed to avoid blocking the dashboard view per spec.
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener("reserve:open-checklist", handler);
    return () => window.removeEventListener("reserve:open-checklist", handler);
  }, []);

  const dismissForToday = () => {
    try {
      localStorage.setItem(STORAGE_KEY, todayISO());
    } catch {
      // ignore
    }
    setOpen(false);
    setAcked({});
  };

  // Item 1: checking balance freshness
  const checking = useMemo(() => {
    if (!balances) return null;
    const list = Array.isArray(balances) ? balances : (balances as { items?: unknown[] })?.items;
    if (!Array.isArray(list)) return null;
    const checkingRow = list.find((b) => {
      const r = b as { accountType?: string };
      return r.accountType === "checking";
    }) as { amount?: number | string; asOfDate?: string } | undefined;
    if (!checkingRow) return null;
    const asOf = checkingRow.asOfDate ?? null;
    return {
      amount: typeof checkingRow.amount === "string" ? parseFloat(checkingRow.amount) : (checkingRow.amount ?? 0),
      asOf,
      days: daysSince(asOf),
    };
  }, [balances]);

  // Item 2: variable spend freshness
  const variable = useMemo(() => {
    if (!Array.isArray(vs)) return null;
    if (vs.length === 0) return { lastDate: null, days: null as number | null };
    const dates = (vs as { weekOf?: string }[])
      .map((v) => v.weekOf ?? null)
      .filter((x): x is string => !!x)
      .sort();
    const last = dates[dates.length - 1] ?? null;
    return { lastDate: last, days: daysSince(last) };
  }, [vs]);

  // Item 3: overdue + upcoming one-time
  const oneTimeCounts = useMemo(() => {
    if (!Array.isArray(oneTimes)) return { overdue: 0, upcoming: 0 };
    const now = new Date();
    const in14 = new Date();
    in14.setDate(now.getDate() + 14);
    let overdue = 0;
    let upcoming = 0;
    for (const e of oneTimes as { dueDate?: string | null; paid?: boolean }[]) {
      if (e.paid) continue;
      if (!e.dueDate) continue;
      const due = new Date(e.dueDate);
      if (isNaN(due.getTime())) continue;
      if (due < now) overdue += 1;
      else if (due <= in14) upcoming += 1;
    }
    return { overdue, upcoming };
  }, [oneTimes]);

  // Item 4: commission entry freshness
  const commission = useMemo(() => {
    if (!Array.isArray(commissions) || commissions.length === 0) return { lastDate: null, days: null as number | null };
    const dates = (commissions as { salesMonth?: string; createdAt?: string; updatedAt?: string }[])
      .map((c) => c.updatedAt ?? c.createdAt ?? c.salesMonth ?? null)
      .filter((x): x is string => !!x)
      .sort();
    const last = dates[dates.length - 1] ?? null;
    return { lastDate: last, days: daysSince(last) };
  }, [commissions]);

  // Item 5: next payday
  const payday = useMemo(() => nextNominalPayday(new Date()), []);

  const items = useMemo(
    () => [
      {
        id: "balance",
        title: "Confirm checking balance",
        detail: checking
          ? `$${checking.amount.toFixed(2)} · last updated ${
              checking.days !== null ? `${checking.days} day${checking.days === 1 ? "" : "s"} ago` : "unknown"
            }`
          : "Loading…",
        warn: checking !== null && checking.days !== null && checking.days > 3,
        actionLabel: "Update now",
        onAction: () => {
          dismissForToday();
          navigate("/");
          setTimeout(() => {
            const btn = document.querySelector('[data-testid="button-update-balance"]');
            if (btn instanceof HTMLElement) btn.click();
          }, 250);
        },
      },
      {
        id: "variable",
        title: "Log variable spend since last session",
        detail:
          variable === null
            ? "Loading…"
            : variable.lastDate
              ? `Last entry ${variable.days} day${variable.days === 1 ? "" : "s"} ago`
              : "No variable spend ever logged",
        warn: variable !== null && (variable.days === null || variable.days > 7),
        actionLabel: "Log spend",
        onAction: () => {
          dismissForToday();
          navigate("/");
          setTimeout(() => {
            const btn = document.querySelector('[data-testid="button-log-spend"]');
            if (btn instanceof HTMLElement) btn.click();
          }, 250);
        },
      },
      {
        id: "onetime",
        title: "Review overdue & upcoming one-time expenses",
        detail:
          oneTimeCounts.overdue > 0
            ? `${oneTimeCounts.overdue} overdue · ${oneTimeCounts.upcoming} due in next 14 days`
            : oneTimeCounts.upcoming > 0
              ? `${oneTimeCounts.upcoming} due in next 14 days`
              : "Nothing overdue or upcoming",
        warn: oneTimeCounts.overdue > 0,
        actionLabel: "Review",
        onAction: () => {
          dismissForToday();
          navigate("/one-time");
        },
      },
      {
        id: "commission",
        title: "Update commission pipeline",
        detail: commission.lastDate
          ? `Last entry ${commission.days} day${commission.days === 1 ? "" : "s"} ago`
          : "No commissions logged",
        warn: commission.days !== null && commission.days > 14,
        actionLabel: "Open Commissions",
        onAction: () => {
          dismissForToday();
          navigate("/commissions");
        },
      },
      {
        id: "payday",
        title: "Confirm next payday",
        detail: `Next payday: ${formatDate(payday)} (auto-detected from 7th/22nd schedule)`,
        warn: false,
        actionLabel: null,
        onAction: () => {},
      },
    ],
    [checking, variable, oneTimeCounts, commission, payday, navigate],
  );

  const ackItem = (id: string) => setAcked((s) => ({ ...s, [id]: true }));
  const allAcked = items.every((i) => acked[i.id]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) dismissForToday();
      }}
    >
      <DialogContent className="max-w-lg" data-testid="dialog-session-checklist">
        <DialogHeader>
          <DialogTitle>Daily check-in</DialogTitle>
          <DialogDescription>
            30-second ritual to keep Reserve&apos;s numbers honest. Skips reappear tomorrow.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2 py-2">
          {items.map((item) => {
            const isAcked = !!acked[item.id];
            return (
              <li
                key={item.id}
                data-testid={`checklist-item-${item.id}`}
                className={cn(
                  "rounded-md border p-3 text-sm transition-colors",
                  isAcked
                    ? "border-border bg-muted/30 opacity-60"
                    : item.warn
                      ? "border-warning/40 bg-warning/5"
                      : "border-border",
                )}
              >
                <div className="flex items-start gap-3">
                  {isAcked ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                  ) : item.warn ? (
                    <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
                  ) : (
                    <Circle className="h-5 w-5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{item.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{item.detail}</div>
                  </div>
                </div>
                {!isAcked && (
                  <div className="mt-2 flex gap-2 justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => ackItem(item.id)}
                      data-testid={`checklist-ack-${item.id}`}
                    >
                      Looks good
                    </Button>
                    {item.actionLabel && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={item.onAction}
                        data-testid={`checklist-action-${item.id}`}
                      >
                        {item.actionLabel}
                        <ArrowRight className="ml-1 h-3 w-3" />
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={dismissForToday} data-testid="button-checklist-skip">
            Remind me tomorrow
          </Button>
          <Button
            onClick={dismissForToday}
            disabled={!allAcked}
            data-testid="button-checklist-done"
          >
            {allAcked ? "All set" : `${items.filter((i) => acked[i.id]).length} of ${items.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
