import { useGetBills, getGetBillsQueryKey, useUpdateBill, useDeleteBill } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Bills() {
  const { data: bills, isLoading, error } = useGetBills({ query: { queryKey: getGetBillsQueryKey() }});
  const updateBill = useUpdateBill();
  const deleteBill = useDeleteBill();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (error || !bills) return <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Error</AlertTitle><AlertDescription>Could not load bills.</AlertDescription></Alert>;

  const handleToggleInclude = (id: number, current: boolean) => {
    updateBill.mutate({ id, data: { includeInCycle: !current } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBillsQueryKey() });
        toast({ title: "Bill updated" });
      }
    });
  };

  const handleDelete = (id: number) => {
    deleteBill.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBillsQueryKey() });
        toast({ title: "Bill deleted" });
      }
    });
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Bills Engine</h1>
          <p className="text-muted-foreground mt-1 text-sm">Manage recurring expenses</p>
        </div>
        <Button><Plus className="h-4 w-4 mr-2" /> Add Bill</Button>
      </div>

      <div className="grid gap-4">
        {bills.map(bill => (
          <Card key={bill.id} className={!bill.includeInCycle ? "opacity-60" : ""}>
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Switch 
                  checked={bill.includeInCycle} 
                  onCheckedChange={() => handleToggleInclude(bill.id, bill.includeInCycle)}
                />
                <div>
                  <p className="font-bold">{bill.name}</p>
                  <p className="text-xs text-muted-foreground uppercase">{bill.category} • {bill.frequency}</p>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <div className="text-right">
                  <p className="font-bold font-mono">{formatCurrency(bill.amount)}</p>
                  <p className="text-xs text-muted-foreground">Due Day {bill.dueDay}</p>
                </div>
                <div className="w-24 text-right">
                  {bill.countsThisCycle ? (
                    <Badge variant="default" className="bg-destructive text-destructive-foreground hover:bg-destructive">Counts this cycle</Badge>
                  ) : (
                    <Badge variant="outline">Skip</Badge>
                  )}
                </div>
                <Button variant="ghost" size="icon" onClick={() => handleDelete(bill.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {bills.length === 0 && (
          <div className="text-center p-12 border border-dashed rounded-xl">
            <p className="text-muted-foreground">No bills found. Add one to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}