import { useState } from "react";
import {
  useGetBills,
  getGetBillsQueryKey,
  useUpdateBill,
  useDeleteBill,
  useCreateBill,
} from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Plus, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

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
  const updateBill = useUpdateBill();
  const deleteBill = useDeleteBill();
  const createBill = useCreateBill();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<BillFormState>(EMPTY_FORM);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetBillsQueryKey() });

  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  };
  const openEdit = (b: typeof bills extends (infer T)[] ? T : never) => {
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
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Bill updated" });
        },
      }
    );
  };

  const handleDelete = (id: number, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    deleteBill.mutate(
      { id },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Bill deleted" });
        },
      }
    );
  };

  const handleSave = () => {
    const data = {
      name: form.name.trim(),
      amount: parseFloat(form.amount),
      dueDay: parseInt(form.dueDay),
      frequency: "monthly",
      category: form.category,
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

  // Category breakdown (Include=TRUE only)
  const categories = ["essential", "discretionary", "debt"] as const;
  const breakdown = categories.map((cat) => {
    const items = bills.filter((b) => b.includeInCycle && b.category === cat);
    return {
      category: cat,
      count: items.length,
      total: items.reduce((s, b) => s + b.amount, 0),
    };
  });
  const grandTotal = breakdown.reduce((s, c) => s + c.total, 0);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Bills Engine</h1>
          <p className="text-muted-foreground mt-1 text-sm">Manage recurring expenses</p>
        </div>
        <Button onClick={openAdd} data-testid="button-add-bill">
          <Plus className="h-4 w-4 mr-2" /> Add Bill
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {breakdown.map((b) => (
          <Card key={b.category}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider capitalize">
                {b.category}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(b.total)}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {b.count} bill{b.count === 1 ? "" : "s"}
              </p>
            </CardContent>
          </Card>
        ))}
        <Card className="border-2 border-foreground/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Total Active Monthly
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{formatCurrency(grandTotal)}</div>
            <p className="text-xs text-muted-foreground mt-1">{bills.filter((b) => b.includeInCycle).length} active</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4">
        {bills.map((bill) => (
          <Card key={bill.id} className={!bill.includeInCycle ? "opacity-60" : ""}>
            <CardContent className="p-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-4 min-w-0">
                <Switch
                  checked={bill.includeInCycle}
                  onCheckedChange={() => handleToggleInclude(bill.id, bill.includeInCycle)}
                  data-testid={`switch-bill-${bill.id}`}
                />
                <div className="min-w-0">
                  <p className="font-bold truncate">{bill.name}</p>
                  <p className="text-xs text-muted-foreground uppercase">
                    {bill.category} • {bill.frequency} • {bill.autopay ? "autopay" : "manual"}
                  </p>
                  {bill.notes && <p className="text-xs text-muted-foreground italic mt-1">{bill.notes}</p>}
                </div>
              </div>
              <div className="flex items-center gap-4 flex-shrink-0">
                <div className="text-right">
                  <p className="font-bold font-mono">{formatCurrency(bill.amount)}</p>
                  <p className="text-xs text-muted-foreground">Due day {bill.dueDay}</p>
                </div>
                <div className="w-28 text-right">
                  {bill.countsThisCycle ? (
                    <Badge className="bg-destructive text-destructive-foreground hover:bg-destructive">
                      In cycle hold
                    </Badge>
                  ) : bill.includeInCycle ? (
                    <Badge variant="outline">Not yet due</Badge>
                  ) : (
                    <Badge variant="secondary">Excluded</Badge>
                  )}
                </div>
                <Button variant="ghost" size="icon" onClick={() => openEdit(bill)} data-testid={`button-edit-bill-${bill.id}`}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDelete(bill.id, bill.name)}
                  data-testid={`button-delete-bill-${bill.id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {bills.length === 0 && (
          <div className="text-center p-12 border border-dashed rounded-xl">
            <p className="text-muted-foreground">No bills yet. Add one to get started.</p>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Bill" : "Add Bill"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-testid="input-bill-name"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Amount ($)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  data-testid="input-bill-amount"
                />
              </div>
              <div className="grid gap-2">
                <Label>Due Day (1-31)</Label>
                <Input
                  type="number"
                  min="1"
                  max="31"
                  value={form.dueDay}
                  onChange={(e) => setForm({ ...form, dueDay: e.target.value })}
                  data-testid="input-bill-dueday"
                />
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
              </select>
            </div>
            <div className="flex items-center justify-between rounded border p-3">
              <div>
                <Label>Include in Cycle</Label>
                <p className="text-xs text-muted-foreground">Counts toward Required Hold and full-month fixed.</p>
              </div>
              <Switch
                checked={form.includeInCycle}
                onCheckedChange={(v) => setForm({ ...form, includeInCycle: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded border p-3">
              <div>
                <Label>Autopay</Label>
                <p className="text-xs text-muted-foreground">Marker only. Doesn't change cycle math.</p>
              </div>
              <Switch checked={form.autopay} onCheckedChange={(v) => setForm({ ...form, autopay: v })} />
            </div>
            <div className="grid gap-2">
              <Label>Notes</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                data-testid="input-bill-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={createBill.isPending || updateBill.isPending} data-testid="button-save-bill">
              {editingId ? "Save Changes" : "Add Bill"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
