import { useState } from "react";
import {
  useGetOneTimeExpenses,
  getGetOneTimeExpensesQueryKey,
  useCreateOneTimeExpense,
  useUpdateOneTimeExpense,
  useDeleteOneTimeExpense,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, CheckCircle2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/utils";

interface FormState {
  description: string;
  amount: string;
  dueDate: string;
  paid: boolean;
  notes: string;
}

const EMPTY: FormState = { description: "", amount: "", dueDate: "", paid: false, notes: "" };

export default function OneTimeExpenses() {
  const { data: items, isLoading } = useGetOneTimeExpenses({ query: { queryKey: getGetOneTimeExpensesQueryKey() } });
  const createMut = useCreateOneTimeExpense();
  const updateMut = useUpdateOneTimeExpense();
  const deleteMut = useDeleteOneTimeExpense();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetOneTimeExpensesQueryKey() });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const all = items ?? [];
  const unpaid = all.filter((i) => !i.paid);
  const paid = all.filter((i) => i.paid);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const unpaidWithDate = unpaid.filter((i) => i.dueDate);
  const unpaidUndated = unpaid.filter((i) => !i.dueDate);
  const totalUnpaidDated = unpaidWithDate.reduce((s, i) => s + i.amount, 0);
  const totalUnpaidUndated = unpaidUndated.reduce((s, i) => s + i.amount, 0);
  const overdue = unpaid.filter((i) => i.dueDate && new Date(i.dueDate) < today);

  const openAdd = () => { setEditingId(null); setForm(EMPTY); setOpen(true); };
  const openEdit = (i: typeof all[number]) => {
    setEditingId(i.id);
    setForm({
      description: i.description,
      amount: String(i.amount),
      dueDate: i.dueDate ? new Date(i.dueDate).toISOString().split("T")[0] : "",
      paid: i.paid,
      notes: i.notes ?? "",
    });
    setOpen(true);
  };

  const handleTogglePaid = (id: number, current: boolean) => {
    updateMut.mutate({ id, data: { paid: !current } }, { onSuccess: () => { refresh(); toast({ title: current ? "Marked unpaid" : "Marked paid" }); } });
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    deleteMut.mutate({ id }, { onSuccess: () => { refresh(); toast({ title: "Deleted" }); } });
  };

  const handleSave = () => {
    const amount = parseFloat(form.amount);
    if (!form.description.trim() || isNaN(amount)) {
      toast({ title: "Description and amount required", variant: "destructive" });
      return;
    }
    const data = {
      description: form.description.trim(),
      amount,
      dueDate: form.dueDate ? new Date(form.dueDate) : null,
      paid: form.paid,
      notes: form.notes.trim() || null,
    };
    const onSuccess = () => {
      refresh();
      setOpen(false);
      toast({ title: editingId ? "Updated" : "Added" });
    };
    if (editingId) {
      updateMut.mutate({ id: editingId, data }, { onSuccess });
    } else {
      createMut.mutate({ data }, { onSuccess });
    }
  };

  const renderRow = (i: typeof all[number]) => {
    const isOverdue = !i.paid && i.dueDate && new Date(i.dueDate) < today;
    return (
      <Card key={i.id} className={`${i.paid ? "opacity-60" : ""}`}>
        <CardContent className="p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Switch checked={i.paid} onCheckedChange={() => handleTogglePaid(i.id, i.paid)} data-testid={`switch-onetime-${i.id}`} />
            <div className="min-w-0">
              <p className="font-bold truncate">{i.description}</p>
              <p className="text-xs text-muted-foreground">
                {i.dueDate ? `Due ${formatDate(i.dueDate as unknown as string)}` : "No due date set"}
              </p>
              {i.notes && <p className="text-xs text-muted-foreground italic mt-1">{i.notes}</p>}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <p className="font-bold font-mono text-right">{formatCurrency(i.amount)}</p>
            <div className="w-24 text-right">
              {i.paid ? (
                <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3" />Paid</Badge>
              ) : isOverdue ? (
                <Badge className="bg-destructive text-destructive-foreground hover:bg-destructive">Overdue</Badge>
              ) : i.dueDate ? (
                <Badge variant="outline">Upcoming</Badge>
              ) : (
                <Badge variant="outline">Undated</Badge>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={() => openEdit(i)} data-testid={`button-edit-onetime-${i.id}`}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => handleDelete(i.id, i.description)} data-testid={`button-delete-onetime-${i.id}`}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">One-Time Expenses</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Non-recurring costs (registrations, memberships, planned purchases). Dated items reduce Safe to Spend if due before next payday.
          </p>
        </div>
        <Button onClick={openAdd} data-testid="button-add-onetime"><Plus className="h-4 w-4 mr-2" />Add Expense</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground tracking-wider">Open Items</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono">{unpaid.length}</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground tracking-wider">Unpaid (Dated)</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono">{formatCurrency(totalUnpaidDated)}</div><p className="text-xs text-muted-foreground mt-1">{unpaidWithDate.length} item(s)</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground tracking-wider">Unpaid (Undated)</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono">{formatCurrency(totalUnpaidUndated)}</div><p className="text-xs text-muted-foreground mt-1">{unpaidUndated.length} item(s) — advisory only</p></CardContent></Card>
        <Card className={overdue.length > 0 ? "border-destructive/50" : ""}><CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground tracking-wider">Overdue</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${overdue.length > 0 ? "text-destructive" : ""}`}>{overdue.length}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Open</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          {unpaid.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open one-time expenses.</p>
          ) : unpaid.map(renderRow)}
        </CardContent>
      </Card>

      {paid.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-muted-foreground">Paid History</CardTitle></CardHeader>
          <CardContent className="grid gap-3">{paid.map(renderRow)}</CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingId ? "Edit Expense" : "Add One-Time Expense"}</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2"><Label>Description</Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Car registration renewal" data-testid="input-onetime-description" /></div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2"><Label>Amount ($)</Label><Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} data-testid="input-onetime-amount" /></div>
              <div className="grid gap-2"><Label>Due Date (optional)</Label><Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} data-testid="input-onetime-duedate" /></div>
            </div>
            <div className="flex items-center justify-between rounded border p-3">
              <div><Label>Marked Paid</Label><p className="text-xs text-muted-foreground">Excluded from cycle hold and totals.</p></div>
              <Switch checked={form.paid} onCheckedChange={(v) => setForm({ ...form, paid: v })} />
            </div>
            <div className="grid gap-2"><Label>Notes</Label><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
            <p className="text-xs text-muted-foreground">
              Dated unpaid items count toward Required Hold if due on or before the next payday. Undated items show on the Dashboard as advisory only.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={createMut.isPending || updateMut.isPending} data-testid="button-save-onetime">{editingId ? "Save Changes" : "Add"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
