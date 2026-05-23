import { useState } from "react";
import {
  useGetBills,
  getGetBillsQueryKey,
  useUpdateBill,
  useDeleteBill,
  useCreateBill,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Plus, Trash2, Pencil, Zap, Clock, TrendingUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

// v9 Fix — single source of truth for how a bill's payment state should be
// DISPLAYED. Mirrors `displayPaymentState()` in
// artifacts/api-server/src/lib/paymentState.ts. A bill marked `paid` without a
// `clearedDate` still shows as "pending" because the money hasn't actually
// left checking yet — the same rule the Overview's cash-position card uses.
type DisplayState =
  | "scheduled"
  | "pending"
  | "cleared"
  | "late_unpaid"
  | "skipped_cycle";

function displayBillState(
  paymentState: string,
  clearedDate: string | Date | null,
): DisplayState {
  if (paymentState === "scheduled") return "scheduled";
  if (paymentState === "skipped_cycle") return "skipped_cycle";
  if (paymentState === "late_unpaid") return "late_unpaid";
  if (paymentState === "paid_pending_clear") return "pending";
  if (paymentState === "paid") return clearedDate ? "cleared" : "pending";
  return "scheduled";
}

const DISPLAY_LABEL: Record<DisplayState, string> = {
  scheduled: "Scheduled",
  pending: "Pending",
  cleared: "Cleared",
  late_unpaid: "Late",
  skipped_cycle: "Skipped",
};

const DISPLAY_HINT: Record<DisplayState, string> = {
  scheduled: "Not yet paid; money still expected to leave checking.",
  pending: "Paid by you, but the money hasn't actually left checking yet — held against checking.",
  cleared: "Money has actually left checking this cycle.",
  late_unpaid: "Past due, still owed.",
  skipped_cycle: "Skipped this cycle only — auto-reverts next cycle.",
};

const DISPLAY_PILL_CLASS: Record<DisplayState, string> = {
  scheduled: "bg-muted text-muted-foreground border-border",
  pending: "bg-warning/15 text-warning border-warning/30",
  cleared: "bg-success/15 text-success border-success/30",
  late_unpaid: "bg-destructive/15 text-destructive border-destructive/30",
  skipped_cycle: "bg-muted text-muted-foreground/70 border-border",
};

/** Stored states the user can pick from the menu. */
type StoredState =
  | "scheduled"
  | "paid_pending_clear"
  | "paid"
  | "late_unpaid"
  | "skipped_cycle";

const STORED_OPTIONS: { value: StoredState; label: string; hint: string }[] = [
  { value: "scheduled", label: "Scheduled", hint: "Reset — money still expected to leave." },
  { value: "paid_pending_clear", label: "Paid (pending)", hint: "Paid, but money hasn't actually left checking yet." },
  { value: "paid", label: "Cleared", hint: "Money has actually left checking." },
  { value: "late_unpaid", label: "Late", hint: "Past due, still owed." },
  { value: "skipped_cycle", label: "Skip this cycle", hint: "Auto-reverts next cycle." },
];

function BillStatePill({
  paymentState,
  clearedDate,
  onChange,
  testidBase,
}: {
  paymentState: string;
  clearedDate: string | Date | null;
  onChange: (next: StoredState) => void;
  testidBase: string;
}) {
  const display = displayBillState(paymentState, clearedDate);
  // The radio-group value is the STORED state, so flipping a "paid w/o
  // clearedDate" row back to "Paid (pending)" is a no-op (already there).
  const currentStored: StoredState =
    paymentState === "paid" && !clearedDate
      ? "paid_pending_clear"
      : (paymentState as StoredState);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={DISPLAY_HINT[display]}
          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider hover-elevate ${DISPLAY_PILL_CLASS[display]}`}
          data-testid={`${testidBase}-state-pill`}
        >
          {DISPLAY_LABEL[display]}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs font-medium">
          Payment status
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={currentStored}
          onValueChange={(v) => onChange(v as StoredState)}
        >
          {STORED_OPTIONS.map((o) => (
            <DropdownMenuRadioItem
              key={o.value}
              value={o.value}
              className="flex flex-col items-start gap-0.5 py-2"
              data-testid={`${testidBase}-state-${o.value}`}
            >
              <span className="text-sm">{o.label}</span>
              <span className="text-[10px] text-muted-foreground">
                {o.hint}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

interface BillsSummary {
  asOf: string;
  nextPayday: string;
  totals: {
    monthlyIncluded: number;
    monthlyAll: number;
    annualIncluded: number;
    activeCount: number;
    excludedCount: number;
    percentOfNetIncome: number;
  };
  income: {
    baseNetIncome: number;
    commissionThisMonth: number;
    totalMonthIncome: number;
  };
  categoryBreakdown: {
    category: string;
    count: number;
    monthly: number;
    annual: number;
    percentOfBills: number;
    percentOfIncome: number;
  }[];
  autopayAudit: {
    autopayCount: number;
    autopayMonthly: number;
    manualCount: number;
    manualMonthly: number;
    manualPct: number;
    upcomingManual: { id: number; name: string; amount: number; nextDueDate: string; daysUntilDue: number }[];
  };
  upcomingTimeline: {
    id: number;
    name: string;
    amount: number;
    category: string;
    autopay: boolean;
    dueDay: number;
    nextDueDate: string;
    daysUntilDue: number;
    inCycle: boolean;
    risk: "low" | "medium" | "high";
  }[];
  incomeVsObligations: {
    totalMonthIncome: number;
    fixedBills: number;
    variableCap: number;
    residualAfterFixed: number;
    residualAfterAll: number;
    residualPct: number;
  };
}

interface BillFormState {
  name: string;
  amount: string;
  dueDay: string;
  category: string;
  autopay: boolean;
  includeInCycle: boolean;
  notes: string;
}

const EMPTY_FORM: BillFormState = {
  name: "",
  amount: "",
  dueDay: "1",
  category: "essential",
  autopay: false,
  includeInCycle: true,
  notes: "",
};

export default function Bills() {
  const { data: bills, isLoading, error } = useGetBills({ query: { queryKey: getGetBillsQueryKey() } });
  const { data: summary } = useQuery<BillsSummary>({
    queryKey: ["bills-summary"],
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/bills/summary`);
      if (!r.ok) throw new Error("Failed to load bills summary");
      return r.json();
    },
  });
  const updateBill = useUpdateBill();
  const deleteBill = useDeleteBill();
  const createBill = useCreateBill();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<BillFormState>(EMPTY_FORM);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getGetBillsQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["bills-summary"] });
  };

  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  };
  const openEdit = (b: NonNullable<typeof bills>[number]) => {
    setEditingId(b.id);
    setForm({
      name: b.name,
      amount: String(b.amount),
      dueDay: String(b.dueDay),
      category: b.category,
      autopay: b.autopay,
      includeInCycle: b.includeInCycle,
      notes: b.notes ?? "",
    });
    setOpen(true);
  };

  const handleToggleInclude = (id: number, current: boolean) => {
    updateBill.mutate(
      { id, data: { includeInCycle: !current } },
      { onSuccess: () => { refresh(); toast({ title: "Bill updated" }); } },
    );
  };

  const handleToggleAutopay = (id: number, current: boolean) => {
    updateBill.mutate(
      { id, data: { autopay: !current } },
      { onSuccess: () => { refresh(); toast({ title: current ? "Marked manual" : "Marked autopay" }); } },
    );
  };

  const handleSetPaymentState = (
    id: number,
    next: "scheduled" | "paid_pending_clear" | "paid" | "late_unpaid" | "skipped_cycle",
  ) => {
    const today = new Date().toISOString().split("T")[0];
    updateBill.mutate(
      {
        id,
        data: {
          paymentState: next,
          paidDate: next === "paid" || next === "paid_pending_clear" ? today : null,
        },
      },
      {
        onSuccess: () => {
          refresh();
          toast({
            title:
              next === "paid"
                ? "Marked paid"
                : next === "skipped_cycle"
                  ? "Skipped this cycle"
                  : next === "late_unpaid"
                    ? "Marked late"
                    : "Reset to scheduled",
          });
        },
      },
    );
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    deleteBill.mutate({ id }, { onSuccess: () => { refresh(); toast({ title: "Bill deleted" }); } });
  };

  const handleSave = () => {
    const data = {
      name: form.name.trim(),
      amount: parseFloat(form.amount),
      dueDay: parseInt(form.dueDay),
      frequency: "monthly" as const,
      category: form.category as "essential" | "discretionary" | "debt" | "variable",
      autopay: form.autopay,
      includeInCycle: form.includeInCycle,
      notes: form.notes.trim() || undefined,
    };
    if (!data.name || isNaN(data.amount) || isNaN(data.dueDay) || data.dueDay < 1 || data.dueDay > 31) {
      toast({ title: "Invalid bill data", variant: "destructive" });
      return;
    }
    const onSuccess = () => {
      refresh();
      setOpen(false);
      toast({ title: editingId ? "Bill updated" : "Bill added" });
    };
    if (editingId) {
      updateBill.mutate({ id: editingId, data }, { onSuccess });
    } else {
      createBill.mutate({ data }, { onSuccess });
    }
  };

  if (isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (error || !bills)
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>Could not load bills.</AlertDescription>
      </Alert>
    );

  const inCycleCount = bills.filter((b) => b.countsThisCycle).length;
  const inCycleTotal = bills.filter((b) => b.countsThisCycle).reduce((s, b) => s + b.amount, 0);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Bills Engine</h1>
          <p className="text-muted-foreground mt-1 text-sm font-mono">
            {summary
              ? `${summary.totals.activeCount} active bills · ${formatCurrency(summary.totals.monthlyIncluded)}/mo · ${summary.totals.percentOfNetIncome}% of net income`
              : "Loading…"}
          </p>
        </div>
        <Button onClick={openAdd} data-testid="button-add-bill">
          <Plus className="h-4 w-4 mr-2" /> Add Bill
        </Button>
      </div>

      {/* Bill Totals strip */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Monthly</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(summary.totals.monthlyIncluded)}</div>
              <p className="text-xs text-muted-foreground mt-1">Include=TRUE bills</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Annual Run-Rate</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(summary.totals.annualIncluded)}</div>
              <p className="text-xs text-muted-foreground mt-1">12 × monthly</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">% of Net Income</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold font-mono ${summary.totals.percentOfNetIncome > 60 ? "text-destructive" : summary.totals.percentOfNetIncome > 45 ? "text-warning" : ""}`}>
                {summary.totals.percentOfNetIncome.toFixed(1)}%
              </div>
              <p className="text-xs text-muted-foreground mt-1">of {formatCurrency(summary.income.totalMonthIncome)}/mo</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">In Current Cycle</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(inCycleTotal)}</div>
              <p className="text-xs text-muted-foreground mt-1">{inCycleCount} bill{inCycleCount === 1 ? "" : "s"} before payday</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Income vs Obligations */}
      {summary && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium uppercase tracking-wider flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Income vs Obligations
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 font-mono text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Total Month Income</span><span className="font-bold">{formatCurrency(summary.incomeVsObligations.totalMonthIncome)}</span></div>
            <div className="flex justify-between text-destructive"><span>− Fixed Bills</span><span>{formatCurrency(summary.incomeVsObligations.fixedBills)}</span></div>
            <div className="flex justify-between border-t border-border pt-2"><span className="text-muted-foreground">= Residual After Fixed</span><span className="font-bold">{formatCurrency(summary.incomeVsObligations.residualAfterFixed)}</span></div>
            <div className="flex justify-between text-destructive"><span>− Variable Cap (gas + food)</span><span>{formatCurrency(summary.incomeVsObligations.variableCap)}</span></div>
            <div className={`flex justify-between border-t-2 border-foreground pt-2 font-bold text-base ${summary.incomeVsObligations.residualAfterAll < 0 ? "text-destructive" : "text-success"}`}>
              <span>Residual After All Obligations</span>
              <span>{formatCurrency(summary.incomeVsObligations.residualAfterAll)} <span className="text-xs font-normal opacity-70">({summary.incomeVsObligations.residualPct.toFixed(1)}%)</span></span>
            </div>
            {summary.incomeVsObligations.residualAfterAll < 0 && (
              <Alert variant="destructive" className="mt-3">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  Fixed obligations + variable cap exceed monthly net income. Either income must rise (commission), variable cap must shrink, or a bill must be cut.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* Two-column grid: Category + Autopay */}
      {summary && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium uppercase tracking-wider">Category Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto -mx-2 sm:mx-0">
              <table className="w-full min-w-[480px] text-sm font-mono">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs uppercase">
                    <th className="text-left py-2 px-2 sm:px-0">Category</th>
                    <th className="text-right py-2">#</th>
                    <th className="text-right py-2">Monthly</th>
                    <th className="text-right py-2">% Bills</th>
                    <th className="text-right py-2 px-2 sm:px-0">% Income</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.categoryBreakdown.map((c) => (
                    <tr key={c.category} className="border-b border-border/40">
                      <td className="py-2 capitalize">{c.category}</td>
                      <td className="text-right py-2">{c.count}</td>
                      <td className="text-right py-2 font-bold">{formatCurrency(c.monthly)}</td>
                      <td className="text-right py-2 text-muted-foreground">{c.percentOfBills.toFixed(1)}%</td>
                      <td className="text-right py-2 text-muted-foreground">{c.percentOfIncome.toFixed(1)}%</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="py-2">Total</td>
                    <td className="text-right py-2">{summary.totals.activeCount}</td>
                    <td className="text-right py-2">{formatCurrency(summary.totals.monthlyIncluded)}</td>
                    <td className="text-right py-2">100.0%</td>
                    <td className="text-right py-2">{summary.totals.percentOfNetIncome.toFixed(1)}%</td>
                  </tr>
                </tbody>
              </table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium uppercase tracking-wider flex items-center gap-2">
                <Zap className="h-4 w-4" /> Autopay Audit
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm font-mono">
                <div className="rounded border border-border/40 px-3 py-2">
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Autopay</div>
                  <div className="font-bold">{summary.autopayAudit.autopayCount} bills</div>
                  <div className="text-xs text-muted-foreground">{formatCurrency(summary.autopayAudit.autopayMonthly)}/mo</div>
                </div>
                <div className="rounded border border-warning/40 px-3 py-2 bg-warning/5">
                  <div className="text-[10px] uppercase text-warning tracking-wider">Manual ({summary.autopayAudit.manualPct.toFixed(0)}%)</div>
                  <div className="font-bold">{summary.autopayAudit.manualCount} bills</div>
                  <div className="text-xs text-muted-foreground">{formatCurrency(summary.autopayAudit.manualMonthly)}/mo</div>
                </div>
              </div>
              {summary.autopayAudit.upcomingManual.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No manual bills due in the next 14 days.</p>
              ) : (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground tracking-wider mb-1">Manual bills due ≤14d (action required)</p>
                  <ul className="text-sm font-mono space-y-1">
                    {summary.autopayAudit.upcomingManual.map((b) => (
                      <li key={b.id} className="flex justify-between border-b border-border/30 pb-1">
                        <span>{b.name}</span>
                        <span className="text-muted-foreground">
                          {formatDate(b.nextDueDate)} · <span className={b.daysUntilDue <= 3 ? "text-destructive font-bold" : "text-warning"}>{b.daysUntilDue}d</span> · {formatCurrency(b.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Upcoming Timeline */}
      {summary && summary.upcomingTimeline.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium uppercase tracking-wider flex items-center gap-2">
              <Clock className="h-4 w-4" /> Upcoming Timeline (next 14 days)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto -mx-2 sm:mx-0">
            <table className="w-full min-w-[680px] text-sm font-mono">
              <thead>
                <tr className="border-b text-muted-foreground text-xs uppercase">
                  <th className="text-left py-2 px-2 sm:px-0">Bill</th>
                  <th className="text-left py-2">Cat</th>
                  <th className="text-right py-2">Day</th>
                  <th className="text-right py-2">Date</th>
                  <th className="text-right py-2">Days</th>
                  <th className="text-right py-2">Amount</th>
                  <th className="text-right py-2">Pay</th>
                  <th className="text-right py-2 px-2 sm:px-0">Cycle</th>
                </tr>
              </thead>
              <tbody>
                {summary.upcomingTimeline.map((b) => (
                  <tr key={b.id} className="border-b border-border/30">
                    <td className="py-2 truncate max-w-[140px]">{b.name}</td>
                    <td className="py-2 capitalize text-muted-foreground text-xs">{b.category}</td>
                    <td className="text-right py-2">{b.dueDay}</td>
                    <td className="text-right py-2 text-muted-foreground">{formatDate(b.nextDueDate)}</td>
                    <td className={`text-right py-2 font-bold ${b.risk === "high" ? "text-destructive" : b.risk === "medium" ? "text-warning" : "text-muted-foreground"}`}>{b.daysUntilDue}d</td>
                    <td className="text-right py-2 font-bold">{formatCurrency(b.amount)}</td>
                    <td className="text-right py-2 text-xs">{b.autopay ? <span className="text-success">auto</span> : <span className="text-warning">manual</span>}</td>
                    <td className="text-right py-2 text-xs">{b.inCycle ? <Badge className="bg-destructive/20 text-destructive border-destructive/40 text-[10px]" variant="outline">in</Badge> : <span className="text-muted-foreground">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* All bills list (editable) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium uppercase tracking-wider">All Bills ({bills.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {bills.map((bill) => (
            <div
              key={bill.id}
              className={`flex items-center justify-between gap-3 rounded border p-3 ${!bill.includeInCycle ? "opacity-60 bg-muted/30" : ""}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <Switch
                  checked={bill.includeInCycle}
                  onCheckedChange={() => handleToggleInclude(bill.id, bill.includeInCycle)}
                  data-testid={`switch-bill-${bill.id}`}
                />
                <div className="min-w-0">
                  <p className="font-bold truncate text-sm">{bill.name}</p>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {bill.category} · day {bill.dueDay} · {bill.frequency}
                  </p>
                  {bill.notes && <p className="text-xs text-muted-foreground italic mt-0.5">{bill.notes}</p>}
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="text-right">
                  <p className="font-bold font-mono text-sm">{formatCurrency(bill.amount)}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">{formatCurrency(bill.amount * 12)}/yr</p>
                </div>
                <button
                  onClick={() => handleToggleAutopay(bill.id, bill.autopay)}
                  className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${bill.autopay ? "bg-success/20 text-success border-success/40" : "bg-warning/10 text-warning border-warning/40"} hover-elevate`}
                  data-testid={`button-autopay-${bill.id}`}
                >
                  {bill.autopay ? "auto" : "manual"}
                </button>
                {/* v9 Fix — single-source payment-state pill.
                    The displayed state derives from (paymentState, clearedDate)
                    so the Bills page and Overview can never disagree:
                      - paymentState='paid' AND clearedDate set → "Cleared"
                      - paymentState='paid' AND no clearedDate → "Pending"
                        (user marked paid but money hasn't actually left).
                    Same rule the Overview cash-position card uses. */}
                <BillStatePill
                  paymentState={bill.paymentState}
                  clearedDate={bill.clearedDate ?? null}
                  onChange={(next) => handleSetPaymentState(bill.id, next)}
                  testidBase={`bill-${bill.id}`}
                />
                <Button variant="ghost" size="icon" onClick={() => openEdit(bill)} data-testid={`button-edit-bill-${bill.id}`}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => handleDelete(bill.id, bill.name)} data-testid={`button-delete-bill-${bill.id}`}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
          {bills.length === 0 && (
            <div className="text-center p-12 border border-dashed rounded-xl">
              <p className="text-muted-foreground">No bills yet. Add one to get started.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Bill" : "Add Bill"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="input-bill-name" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Amount ($)</Label>
                <Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="input-bill-amount" />
              </div>
              <div className="grid gap-2">
                <Label>Due Day (1-31)</Label>
                <Input type="number" min="1" max="31" value={form.dueDay} onChange={(e) => setForm({ ...form, dueDay: e.target.value })} data-testid="input-bill-dueday" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Category</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                data-testid="select-bill-category"
              >
                <option value="essential">Essential</option>
                <option value="discretionary">Discretionary</option>
                <option value="debt">Debt</option>
                <option value="variable">Variable</option>
              </select>
            </div>
            <div className="flex items-center justify-between rounded border p-3">
              <div>
                <Label>Include in Cycle</Label>
                <p className="text-xs text-muted-foreground">Counts toward Required Hold and full-month fixed.</p>
              </div>
              <Switch checked={form.includeInCycle} onCheckedChange={(v) => setForm({ ...form, includeInCycle: v })} />
            </div>
            <div className="flex items-center justify-between rounded border p-3">
              <div>
                <Label>Autopay</Label>
                <p className="text-xs text-muted-foreground">Marker only — Manual bills surface in the audit.</p>
              </div>
              <Switch checked={form.autopay} onCheckedChange={(v) => setForm({ ...form, autopay: v })} />
            </div>
            <div className="grid gap-2">
              <Label>Notes</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} data-testid="input-bill-notes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={createBill.isPending || updateBill.isPending} data-testid="button-save-bill">
              {editingId ? "Save Changes" : "Add Bill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
