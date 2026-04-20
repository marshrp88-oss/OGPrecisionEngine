import { 
  useGetDashboardCycle, 
  getGetDashboardCycleQueryKey,
  useCreateBalance
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatPercent, formatDate } from "@/lib/utils";
import { AlertTriangle, RefreshCw, ChevronDown, FlaskConical } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export default function Dashboard() {
  const { data: cycle, isLoading, error } = useGetDashboardCycle({ query: { queryKey: getGetDashboardCycleQueryKey() }});
  
  if (isLoading) {
    return <div className="space-y-4">
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>;
  }

  if (error || !cycle) {
    return <Alert variant="destructive"><AlertTriangle className="h-4 w-4" /><AlertTitle>Error</AlertTitle><AlertDescription>Could not load dashboard data.</AlertDescription></Alert>;
  }

  const isStale = cycle.isStale || cycle.paydayRisk;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cycle Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm font-mono">
            {cycle.daysUntilPayday !== null ? `${cycle.daysUntilPayday} days until payday` : "Payday unknown"}
          </p>
        </div>
        <UpdateBalanceDialog />
      </div>

      {isStale && (
        <Alert variant="destructive" className="bg-destructive/10 border-destructive/20 text-destructive-foreground">
          <AlertTriangle className="h-5 w-5" />
          <AlertTitle className="text-lg font-bold">Stale Data Warning</AlertTitle>
          <AlertDescription className="font-mono text-sm mt-1">
            Data is {cycle.daysSinceUpdate} days old. Safe to Spend is inaccurate. Please update your checking balance immediately.
          </AlertDescription>
        </Alert>
      )}

      {/* Main KPI */}
      <Card className="border-2 shadow-xl overflow-hidden relative">
        <div className={`absolute top-0 left-0 w-2 h-full ${
          cycle.status === "GREEN" ? "bg-success" : 
          cycle.status === "YELLOW" ? "bg-warning" : "bg-destructive"
        }`} />
        <CardContent className="p-8 md:p-10 pl-10 md:pl-12">
          <div className="flex flex-col md:flex-row justify-between items-center gap-8">
            <div className="text-center md:text-left">
              <p className="text-sm font-medium text-muted-foreground uppercase tracking-widest mb-2">Safe to Spend</p>
              <h2 className="text-5xl md:text-7xl font-bold tracking-tighter">
                {formatCurrency(cycle.safeToSpend)}
              </h2>
            </div>
            
            <div className="flex flex-col items-center justify-center p-6 bg-card border rounded-xl shadow-sm min-w-[200px]">
              <div className={`text-xl font-bold px-4 py-1 rounded-full border mb-4 ${
                cycle.status === "GREEN" ? "bg-success/20 text-success border-success/30" : 
                cycle.status === "YELLOW" ? "bg-warning/20 text-warning border-warning/30" : 
                "bg-destructive/20 text-destructive border-destructive/30"
              }`}>
                {cycle.status}
              </div>
              <p className="text-xs text-muted-foreground font-mono">
                Daily Rate: <span className="text-foreground font-bold">{formatCurrency(cycle.dailyRateRealTime)}</span>/day
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Checking Balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{formatCurrency(cycle.checkingBalance)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Updated {cycle.daysSinceUpdate} days ago
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Required Hold</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-destructive">{formatCurrency(cycle.totalRequiredHold)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Bills & Pending
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Forward Reserve</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{formatCurrency(cycle.forwardReserve)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Target: {formatCurrency(cycle.minimumCushion)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="math" className="border rounded-xl px-4 bg-card">
          <AccordionTrigger className="hover:no-underline font-mono text-sm py-4">
            <span className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4" />
              View Underlying Math
            </span>
          </AccordionTrigger>
          <AccordionContent className="pt-2 pb-6 space-y-3 font-mono text-sm">
            <div className="flex justify-between py-1 border-b border-border/50">
              <span className="text-muted-foreground">Checking Balance</span>
              <span>{formatCurrency(cycle.checkingBalance)}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50 text-destructive">
              <span>- Bills Due Before Payday</span>
              <span>{formatCurrency(cycle.billsDueBeforePayday)}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50 text-destructive">
              <span>- Pending Holds</span>
              <span>{formatCurrency(cycle.pendingHoldsReserve)}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50 text-destructive">
              <span>- Minimum Cushion</span>
              <span>{formatCurrency(cycle.minimumCushion)}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/50 text-destructive">
              <span>- Forward Reserve</span>
              <span>{formatCurrency(cycle.forwardReserve)}</span>
            </div>
            <div className="flex justify-between py-1 pt-3 font-bold border-t-2 border-border">
              <span>= Safe to Spend</span>
              <span>{formatCurrency(cycle.safeToSpend)}</span>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

    </div>
  );
}

function UpdateBalanceDialog() {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const createBalance = useCreateBalance();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount)) return;

    createBalance.mutate({
      data: {
        accountType: "checking",
        amount: parsedAmount,
        asOfDate: new Date().toISOString(),
        source: "manual"
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDashboardCycleQueryKey() });
        setOpen(false);
        setAmount("");
        toast({ title: "Balance updated" });
      },
      onError: () => {
        toast({ title: "Failed to update balance", variant: "destructive" });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="w-full md:w-auto font-bold tracking-wide">
          <RefreshCw className="mr-2 h-4 w-4" />
          UPDATE BALANCE
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Checking Balance</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="amount">Current Balance</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="text-2xl font-mono"
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createBalance.isPending || !amount}>
            Save Balance
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
