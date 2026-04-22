import { useState } from "react";
import {
  useGetCommissions,
  getGetCommissionsQueryKey,
  useGetCommissionSummary,
  getGetCommissionSummaryQueryKey,
  useCreateCommission,
  useDeleteCommission,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/utils";

export default function Commissions() {
  const { data: commissions, isLoading } = useGetCommissions({ query: { queryKey: getGetCommissionsQueryKey() } });
  const { data: summary } = useGetCommissionSummary({ query: { queryKey: getGetCommissionSummaryQueryKey() } });
  const deleteCommission = useDeleteCommission();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleDelete = (id: number) => {
    if (!confirm("Delete this commission record?")) return;
    deleteCommission.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCommissionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetCommissionSummaryQueryKey() });
        toast({ title: "Commission deleted" });
      },
    });
  };

  if (isLoading) return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">Commissions</h1>
        <AddCommissionDialog />
      </div>

      {summary?.droughtFlag && (
        <Alert variant="destructive" className="border-2 border-destructive">
          <AlertTriangle className="h-5 w-5" />
          <AlertTitle className="text-lg font-bold">Commission Drought Active</AlertTitle>
          <AlertDescription>
            {summary.droughtMonths} month(s) below threshold. Baseline savings mode: assume $0 commission.
          </AlertDescription>
        </Alert>
      )}

      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">YTD Take-Home</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(summary.ytdTakeHome)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">3-Month Avg</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(summary.last3MonthsAvg)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">This Month (Confirmed)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(summary.currentMonthConfirmed)}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Commission History</CardTitle>
        </CardHeader>
        <CardContent>
          {!commissions || commissions.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4">No commission records yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 pr-4">Sales Month</th>
                    <th className="text-right py-2 pr-4">MRR</th>
                    <th className="text-right py-2 pr-4">NRR</th>
                    <th className="text-right py-2 pr-4">Gross</th>
                    <th className="text-right py-2 pr-4">Take-Home</th>
                    <th className="text-left py-2 pr-4">Status</th>
                    <th className="text-left py-2 pr-4">Payout Date</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {commissions.map((c) => (
                    <tr key={c.id} className="border-b border-border/50 hover:bg-muted/30" data-testid={`row-commission-${c.id}`}>
                      <td className="py-2 pr-4">{formatDate(c.salesMonth)}</td>
                      <td className="text-right py-2 pr-4">{formatCurrency(c.mrrAchieved)}</td>
                      <td className="text-right py-2 pr-4">{formatCurrency(c.nrrAchieved)}</td>
                      <td className="text-right py-2 pr-4">{formatCurrency(c.grossTotal)}</td>
                      <td className="text-right py-2 pr-4 font-bold">{formatCurrency(c.takeHome)}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={c.status === "confirmed" ? "default" : c.status === "paid" ? "secondary" : "outline"}>
                          {c.status}
                        </Badge>
                      </td>
                      <td className="py-2 pr-4">{c.payoutDate ? formatDate(c.payoutDate) : "—"}</td>
                      <td className="py-2">
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(c.id)} data-testid={`button-delete-commission-${c.id}`}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Payout Calculator Reference (Odoo Tiered, workbook v7.2)</CardTitle>
        </CardHeader>
        <CardContent className="text-xs font-mono space-y-1 text-muted-foreground">
          <div className="font-semibold text-foreground mb-2">MRR Tiers (target $700)</div>
          <div>$0.00 – $349.93: × 0.3705</div>
          <div>$349.94 – $489.93: × 0.9634</div>
          <div>$489.94 – $699.93: × 5.5212</div>
          <div>&gt; $699.93: × 0.65</div>
          <div className="font-semibold text-foreground mt-3 mb-2">NRR Tiers (target $6,000)</div>
          <div>$0.00 – $2,999.40: × 0.0204</div>
          <div>$2,999.41 – $4,199.40: × 0.0388</div>
          <div>$4,199.41 – $5,999.40: × 0.2801</div>
          <div>&gt; $5,999.40: × 0.042</div>
          <div className="mt-3 text-amber-600 dark:text-amber-400 font-semibold">Tax Rate: 43.5%</div>
          <div className="text-xs text-muted-foreground mt-2">
            Verification: $890 MRR → gross $1,547.52, take-home $874.35.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function AddCommissionDialog() {
  const [open, setOpen] = useState(false);
  const [salesMonth, setSalesMonth] = useState(currentYearMonth());
  const [mrrAchieved, setMrrAchieved] = useState("");
  const [nrrAchieved, setNrrAchieved] = useState("0");
  const [status, setStatus] = useState("pending");
  const createCommission = useCreateCommission();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    if (!salesMonth || !mrrAchieved) {
      toast({
        title: "Missing required fields",
        description: !salesMonth ? "Pick a sales month." : "Enter MRR achieved.",
        variant: "destructive",
      });
      return;
    }
    const salesMonthIso = /^\d{4}-\d{2}$/.test(salesMonth) ? `${salesMonth}-01` : salesMonth;
    createCommission.mutate({
      data: {
        salesMonth: salesMonthIso,
        mrrAchieved: parseFloat(mrrAchieved),
        nrrAchieved: parseFloat(nrrAchieved) || 0,
        status,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCommissionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetCommissionSummaryQueryKey() });
        setOpen(false);
        setSalesMonth(""); setMrrAchieved(""); setNrrAchieved("0");
        toast({ title: "Commission added" });
      },
      onError: () => toast({ title: "Failed to add commission", variant: "destructive" }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-add-commission"><Plus className="mr-2 h-4 w-4" />Add Commission</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Commission Record</DialogTitle></DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="sales-month">Sales Month</Label>
            <Input id="sales-month" type="month" value={salesMonth} onChange={(e) => setSalesMonth(e.target.value)} data-testid="input-sales-month" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mrr">MRR Achieved ($)</Label>
            <Input id="mrr" type="number" step="0.01" value={mrrAchieved} onChange={(e) => setMrrAchieved(e.target.value)} placeholder="0.00" data-testid="input-mrr" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="nrr">NRR Achieved ($)</Label>
            <Input id="nrr" type="number" step="0.01" value={nrrAchieved} onChange={(e) => setNrrAchieved(e.target.value)} placeholder="0.00" data-testid="input-nrr" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="status">Status</Label>
            <select id="status" value={status} onChange={(e) => setStatus(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background" data-testid="select-commission-status">
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
              <option value="paid">Paid</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createCommission.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
