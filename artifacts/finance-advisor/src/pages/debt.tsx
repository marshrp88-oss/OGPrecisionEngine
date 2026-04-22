import { useState } from "react";
import {
  useGetDebt,
  getGetDebtQueryKey,
  useCreateDebt,
  useUpdateDebt,
  useDeleteDebt,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatPercent } from "@/lib/utils";

function computePayoffMonths(balance: number, rate: number, payment: number): number | null {
  if (payment <= 0) return null;
  if (rate <= 0) return Math.ceil(balance / payment);
  const monthlyRate = rate / 12;
  if (payment <= balance * monthlyRate) return null;
  return Math.ceil(
    -Math.log(1 - (balance * monthlyRate) / payment) / Math.log(1 + monthlyRate)
  );
}

export default function Debt() {
  const { data: debts, isLoading } = useGetDebt({ query: { queryKey: getGetDebtQueryKey() } });
  const deleteDebt = useDeleteDebt();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  if (isLoading) return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );

  const activeDebts = (debts ?? []).filter((d) => d.status !== "paid");
  const totalBalance = activeDebts.reduce((sum, d) => sum + d.balance, 0);

  const handleDelete = (id: number) => {
    if (!confirm("Delete this debt record?")) return;
    deleteDebt.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDebtQueryKey() });
        toast({ title: "Debt entry deleted" });
      },
    });
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">Debt Strategy</h1>
        <AddDebtDialog />
      </div>

      {activeDebts.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Debt Balance</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-destructive">{formatCurrency(totalBalance)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Active Debt Entries</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono">{activeDebts.length}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {(debts ?? []).map((d) => {
        const stdMonths = d.minimumPayment
          ? computePayoffMonths(d.balance, d.interestRate, d.minimumPayment)
          : null;
        const aggressivePayment = d.minimumPayment ? d.minimumPayment * 1.5 : null;
        const aggMonths = aggressivePayment
          ? computePayoffMonths(d.balance, d.interestRate, aggressivePayment)
          : null;

        const isStudentLoan = d.loanType === "federal" || d.loanType === "student";
        const investReturn = 0.08;
        const rateNum = d.interestRate;
        const investVsPayVerdict =
          rateNum === 0
            ? "Rate unknown — verify before strategizing"
            : rateNum < investReturn
              ? `Invest-first: ${formatPercent(rateNum)} debt rate < ${formatPercent(investReturn)} expected market return`
              : `Pay-first: ${formatPercent(rateNum)} debt rate > ${formatPercent(investReturn)} expected market return`;

        return (
          <Card key={d.id} data-testid={`card-debt-${d.id}`}>
            <CardHeader>
              <div className="flex justify-between items-start">
                <div>
                  <CardTitle>{d.name}</CardTitle>
                  <div className="flex gap-2 mt-1">
                    <Badge variant="outline">{d.loanType}</Badge>
                    <Badge variant={d.status === "active" ? "default" : d.status === "deferral" ? "secondary" : "outline"}>
                      {d.status}
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <div className="text-2xl font-bold font-mono">{formatCurrency(d.balance)}</div>
                    <div className="text-xs text-muted-foreground">
                      {d.interestRate > 0 ? `${formatPercent(d.interestRate)} APR` : "Rate unconfirmed"}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(d.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {d.notes && (
                <p className="text-sm text-amber-600 dark:text-amber-400 font-medium bg-amber-50 dark:bg-amber-950/30 p-2 rounded">{d.notes}</p>
              )}

              {(stdMonths || aggMonths) && (
                <div className="grid grid-cols-2 gap-4 font-mono text-sm">
                  {stdMonths && d.minimumPayment && (
                    <div className="bg-muted/50 p-3 rounded">
                      <div className="text-xs text-muted-foreground uppercase mb-1">Standard Payoff</div>
                      <div className="font-bold">{Math.floor(stdMonths / 12)}y {stdMonths % 12}m</div>
                      <div className="text-xs text-muted-foreground">{formatCurrency(d.minimumPayment)}/mo</div>
                    </div>
                  )}
                  {aggMonths && aggressivePayment && (
                    <div className="bg-emerald-50 dark:bg-emerald-950/30 p-3 rounded">
                      <div className="text-xs text-muted-foreground uppercase mb-1">Accelerated (+50%)</div>
                      <div className="font-bold text-emerald-700 dark:text-emerald-400">{Math.floor(aggMonths / 12)}y {aggMonths % 12}m</div>
                      <div className="text-xs text-muted-foreground">{formatCurrency(aggressivePayment)}/mo</div>
                    </div>
                  )}
                </div>
              )}

              <div className="text-sm p-3 bg-muted/50 rounded font-mono">
                <div className="text-xs text-muted-foreground uppercase mb-1">Invest vs. Pay Verdict</div>
                <div className={d.interestRate === 0 ? "text-muted-foreground" : d.interestRate < investReturn ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                  {investVsPayVerdict}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {(!debts || debts.length === 0) && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No debt entries. Add your first debt to analyze payoff strategies.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AddDebtDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "", balance: "", interestRate: "", loanType: "federal",
    minimumPayment: "", status: "active", notes: "",
  });
  const createDebt = useCreateDebt();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    if (!form.name || !form.balance) return;
    createDebt.mutate({
      data: {
        name: form.name,
        balance: parseFloat(form.balance),
        interestRate: parseFloat(form.interestRate) || 0,
        loanType: form.loanType as "student_federal" | "student_private" | "auto" | "credit_card" | "personal" | "mortgage" | "other",
        minimumPayment: parseFloat(form.minimumPayment) || null,
        status: form.status as "active" | "paid_off" | "deferred" | "forbearance" | "in_repayment",
        notes: form.notes || null,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDebtQueryKey() });
        setOpen(false);
        toast({ title: "Debt entry added" });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-add-debt"><Plus className="mr-2 h-4 w-4" />Add Debt</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Debt Entry</DialogTitle></DialogHeader>
        <div className="grid gap-3 py-2">
          <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="Federal Student Loans" /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Balance ($)</Label><Input type="number" value={form.balance} onChange={(e) => setForm((p) => ({ ...p, balance: e.target.value }))} placeholder="30000.00" /></div>
            <div><Label>Interest Rate (decimal)</Label><Input type="number" step="0.0001" value={form.interestRate} onChange={(e) => setForm((p) => ({ ...p, interestRate: e.target.value }))} placeholder="0.065" /></div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Loan Type</Label>
              <select value={form.loanType} onChange={(e) => setForm((p) => ({ ...p, loanType: e.target.value }))} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="federal">Federal</option>
                <option value="private">Private</option>
                <option value="auto">Auto</option>
                <option value="credit_card">Credit Card</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <Label>Status</Label>
              <select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="active">Active</option>
                <option value="deferral">Deferral</option>
                <option value="forbearance">Forbearance</option>
                <option value="paid">Paid</option>
              </select>
            </div>
          </div>
          <div><Label>Minimum Payment ($)</Label><Input type="number" value={form.minimumPayment} onChange={(e) => setForm((p) => ({ ...p, minimumPayment: e.target.value }))} placeholder="Optional" /></div>
          <div><Label>Notes</Label><Input value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} placeholder="Optional notes" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createDebt.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
