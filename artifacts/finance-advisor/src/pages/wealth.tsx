import { useState } from "react";
import {
  useGetWealthSnapshots,
  getGetWealthSnapshotsQueryKey,
  useCreateWealthSnapshot,
  useDeleteWealthSnapshot,
  useGetCreditScores,
  getGetCreditScoresQueryKey,
  useCreateCreditScore,
  useGetBalances,
  getGetBalancesQueryKey,
  useCreateBalance,
  useGetMonthlySavings,
  getGetMonthlySavingsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, TrendingUp, TrendingDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const HYSA_TARGET = 15000;

const PROJECTION_AGES = [35, 40, 45, 55, 65];
const CURRENT_AGE = 30; // Marshall — adjust if changes
const REAL_RETURN = 0.07;

export default function Wealth() {
  const { data: snapshots, isLoading } = useGetWealthSnapshots({ query: { queryKey: getGetWealthSnapshotsQueryKey() } });
  const { data: creditScores } = useGetCreditScores({ query: { queryKey: getGetCreditScoresQueryKey() } });
  const { data: balances } = useGetBalances({ query: { queryKey: getGetBalancesQueryKey() } });
  const { data: savings } = useGetMonthlySavings({ query: { queryKey: getGetMonthlySavingsQueryKey() } });
  const deleteSnapshot = useDeleteWealthSnapshot();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  if (isLoading) return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );

  const latestSnapshot = snapshots?.[0];
  const hysaGap = latestSnapshot ? HYSA_TARGET - latestSnapshot.hysa : null;

  const chartData = (snapshots ?? [])
    .slice()
    .reverse()
    .map((s) => ({
      date: new Date(s.snapshotDate).toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      netWorth: s.netWorth,
    }));

  const handleDeleteSnapshot = (id: number) => {
    if (!confirm("Delete this snapshot?")) return;
    deleteSnapshot.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetWealthSnapshotsQueryKey() });
        toast({ title: "Snapshot deleted" });
      },
    });
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">Wealth Management</h1>
        <div className="flex gap-2">
          <AddCreditScoreDialog />
          <AddSnapshotDialog />
        </div>
      </div>

      {latestSnapshot && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Net Worth</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(latestSnapshot.netWorth)}</div>
              {latestSnapshot.changeVsPrior != null && (
                <div className={`flex items-center gap-1 text-xs mt-1 ${latestSnapshot.changeVsPrior >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                  {latestSnapshot.changeVsPrior >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {formatCurrency(Math.abs(latestSnapshot.changeVsPrior))} vs prior
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">HYSA</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(latestSnapshot.hysa)}</div>
              {hysaGap != null && hysaGap > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Gap: {formatCurrency(hysaGap)} to $15K target</p>
              )}
              {hysaGap != null && hysaGap <= 0 && (
                <p className="text-xs text-emerald-600 mt-1">HYSA target met</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Assets</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{formatCurrency(latestSnapshot.totalAssets)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Total Liabilities</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono text-destructive">{formatCurrency(latestSnapshot.totalLiabilities)}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {balances && latestSnapshot && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wider">Asset Allocation (current balances)</CardTitle></CardHeader>
          <CardContent>
            <AllocationBreakdown balances={balances} />
          </CardContent>
        </Card>
      )}

      {savings && latestSnapshot && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wider">Savings Rate</CardTitle></CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono">
                {savings.totalMonthIncome > 0 ? `${((savings.estimatedMonthlySavings / savings.totalMonthIncome) * 100).toFixed(1)}%` : "—"}
              </div>
              <p className="text-xs text-muted-foreground mt-2 font-mono">
                {formatCurrency(savings.estimatedMonthlySavings)} of {formatCurrency(savings.totalMonthIncome)} monthly income
              </p>
              <p className="text-[10px] text-muted-foreground italic mt-1">
                Includes 401(k) accrual? No — this is post-tax cash flow surplus only.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wider">Net Worth Projections (real, 7%/yr)</CardTitle></CardHeader>
            <CardContent>
              <FvProjections netWorth={latestSnapshot.netWorth} monthlySavings={Math.max(0, savings.estimatedMonthlySavings)} />
            </CardContent>
          </Card>
        </div>
      )}

      {chartData.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Net Worth Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData}>
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="netWorth" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {creditScores && creditScores.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Credit Scores</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {creditScores.slice(0, 3).map((cs) => (
                <div key={cs.id} className="flex flex-wrap gap-4 items-center" data-testid={`row-credit-score-${cs.id}`}>
                  <span className="text-xs text-muted-foreground font-mono w-24">{formatDate(cs.asOfDate)}</span>
                  <div className="flex gap-4">
                    {cs.experian && (
                      <div className="text-center">
                        <div className="text-lg font-bold font-mono">{cs.experian}</div>
                        <div className="text-xs text-muted-foreground">Experian</div>
                      </div>
                    )}
                    {cs.equifax && (
                      <div className="text-center">
                        <div className="text-lg font-bold font-mono">{cs.equifax}</div>
                        <div className="text-xs text-muted-foreground">Equifax</div>
                      </div>
                    )}
                    {cs.transunion && (
                      <div className="text-center">
                        <div className="text-lg font-bold font-mono">{cs.transunion}</div>
                        <div className="text-xs text-muted-foreground">TransUnion</div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Snapshot History</CardTitle>
        </CardHeader>
        <CardContent>
          {!snapshots || snapshots.length === 0 ? (
            <p className="text-muted-foreground text-sm">No snapshots yet. Add your first net worth snapshot.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm font-mono">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs uppercase tracking-wider">
                    <th className="text-left py-2 pr-4">Date</th>
                    <th className="text-right py-2 pr-4">HYSA</th>
                    <th className="text-right py-2 pr-4">Brokerage</th>
                    <th className="text-right py-2 pr-4">401(k)</th>
                    <th className="text-right py-2 pr-4">Liabilities</th>
                    <th className="text-right py-2 pr-4">Net Worth</th>
                    <th className="text-right py-2 pr-4">Change</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => (
                    <tr key={s.id} className="border-b border-border/50 hover:bg-muted/30" data-testid={`row-snapshot-${s.id}`}>
                      <td className="py-2 pr-4">{formatDate(s.snapshotDate)}</td>
                      <td className="text-right py-2 pr-4">{formatCurrency(s.hysa)}</td>
                      <td className="text-right py-2 pr-4">{formatCurrency(s.brokerage)}</td>
                      <td className="text-right py-2 pr-4">{formatCurrency(s.retirement401k)}</td>
                      <td className="text-right py-2 pr-4 text-destructive">{formatCurrency(s.totalLiabilities)}</td>
                      <td className="text-right py-2 pr-4 font-bold">{formatCurrency(s.netWorth)}</td>
                      <td className={`text-right py-2 pr-4 ${s.changeVsPrior != null && s.changeVsPrior >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                        {s.changeVsPrior != null ? formatCurrency(s.changeVsPrior) : "—"}
                      </td>
                      <td className="py-2">
                        <Button variant="ghost" size="icon" onClick={() => handleDeleteSnapshot(s.id)} data-testid={`button-delete-snapshot-${s.id}`}>
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
    </div>
  );
}

function AllocationBreakdown({ balances }: { balances: { id: number; accountType: string; amount: number; notes?: string | null }[] }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createBalance = useCreateBalance();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Latest balance per accountType (balances arrive desc by asOfDate from API)
  const latestByType = new Map<string, typeof balances[number]>();
  for (const b of balances) if (!latestByType.has(b.accountType)) latestByType.set(b.accountType, b);

  const order = ["checking", "hysa", "brokerage", "401k", "roth_ira", "vehicle"];
  const labels: Record<string, string> = {
    checking: "Checking",
    hysa: "HYSA",
    brokerage: "Brokerage (taxable)",
    "401k": "401(k)",
    roth_ira: "Roth IRA",
    vehicle: "Vehicle (Camry)",
  };

  const rows = order
    .map((t) => latestByType.get(t))
    .filter((b): b is typeof balances[number] => Boolean(b));
  const total = rows.reduce((s, b) => s + b.amount, 0);

  const startEdit = (b: typeof balances[number]) => { setEditing(b.accountType); setDraft(String(b.amount)); };
  const saveEdit = (accountType: string) => {
    const v = parseFloat(draft);
    if (isNaN(v)) { toast({ title: "Invalid amount", variant: "destructive" }); return; }
    createBalance.mutate({
      data: { accountType: accountType as "checking" | "hysa" | "brokerage" | "401k" | "other", amount: v, asOfDate: new Date().toISOString(), source: "manual" },
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBalancesQueryKey() });
        setEditing(null);
        toast({ title: `Updated ${labels[accountType] ?? accountType}` });
      },
    });
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No balances recorded.</p>}
      {rows.map((b) => {
        const pct = total > 0 ? (b.amount / total) * 100 : 0;
        const isEditing = editing === b.accountType;
        return (
          <div key={b.accountType} data-testid={`row-allocation-${b.accountType}`}>
            <div className="flex items-center justify-between text-sm font-mono py-1">
              <span className="flex items-center gap-2">
                {labels[b.accountType] ?? b.accountType}
                {b.notes && <span className="text-[10px] text-muted-foreground italic">({b.notes})</span>}
              </span>
              <span className="flex items-center gap-2">
                {isEditing ? (
                  <>
                    <Input className="w-32 h-8 font-mono" value={draft} onChange={(e) => setDraft(e.target.value)} type="number" step="0.01" />
                    <Button size="sm" onClick={() => saveEdit(b.accountType)} data-testid={`button-save-allocation-${b.accountType}`}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <span>{formatCurrency(b.amount)}</span>
                    <span className="text-xs text-muted-foreground w-12 text-right">{pct.toFixed(1)}%</span>
                    <Button size="sm" variant="ghost" onClick={() => startEdit(b)} data-testid={`button-edit-allocation-${b.accountType}`}>Edit</Button>
                  </>
                )}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
      <div className="flex justify-between font-bold pt-2 border-t border-border/30 text-sm font-mono">
        <span>Total Assets (current balances)</span>
        <span>{formatCurrency(total)}</span>
      </div>
    </div>
  );
}

function FvProjections({ netWorth, monthlySavings }: { netWorth: number; monthlySavings: number }) {
  const annual = monthlySavings * 12;
  return (
    <div className="space-y-1.5 font-mono text-sm">
      {PROJECTION_AGES.map((age) => {
        const years = age - CURRENT_AGE;
        if (years <= 0) return null;
        const fvNet = netWorth * Math.pow(1 + REAL_RETURN, years);
        const fvSavings = annual > 0 ? annual * ((Math.pow(1 + REAL_RETURN, years) - 1) / REAL_RETURN) : 0;
        const total = fvNet + fvSavings;
        return (
          <div key={age} className="flex justify-between py-1 border-b border-border/30" data-testid={`row-fv-${age}`}>
            <span className="text-muted-foreground">Age {age} ({years}y)</span>
            <span className="font-bold">{formatCurrency(total)}</span>
          </div>
        );
      })}
      <p className="text-[10px] text-muted-foreground italic pt-2">
        Assumes current net worth ({formatCurrency(netWorth)}) compounding at 7% real, plus {formatCurrency(annual)}/yr contributions. Excludes match changes and Roth funding.
      </p>
    </div>
  );
}

function AddSnapshotDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    snapshotDate: new Date().toISOString().split("T")[0],
    hysa: "", brokerage: "", retirement401k: "", otherAssets: "0",
    carLoan: "0", studentLoans: "0", otherLiabilities: "0",
  });
  const createSnapshot = useCreateWealthSnapshot();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    createSnapshot.mutate({
      data: {
        snapshotDate: form.snapshotDate,
        hysa: parseFloat(form.hysa) || 0,
        brokerage: parseFloat(form.brokerage) || 0,
        retirement401k: parseFloat(form.retirement401k) || 0,
        otherAssets: parseFloat(form.otherAssets) || 0,
        carLoan: parseFloat(form.carLoan) || 0,
        studentLoans: parseFloat(form.studentLoans) || 0,
        otherLiabilities: parseFloat(form.otherLiabilities) || 0,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetWealthSnapshotsQueryKey() });
        setOpen(false);
        toast({ title: "Snapshot saved" });
      },
      onError: () => toast({ title: "Failed to save snapshot", variant: "destructive" }),
    });
  };

  const f = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-add-snapshot"><Plus className="mr-2 h-4 w-4" />Add Snapshot</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New Wealth Snapshot</DialogTitle></DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1"><Label>Date</Label><Input type="date" value={form.snapshotDate} onChange={f("snapshotDate")} /></div>
          <div className="font-semibold text-sm mt-2">Assets</div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label className="text-xs">HYSA</Label><Input type="number" value={form.hysa} onChange={f("hysa")} placeholder="0.00" /></div>
            <div><Label className="text-xs">Brokerage</Label><Input type="number" value={form.brokerage} onChange={f("brokerage")} placeholder="0.00" /></div>
            <div><Label className="text-xs">401(k)</Label><Input type="number" value={form.retirement401k} onChange={f("retirement401k")} placeholder="0.00" /></div>
            <div><Label className="text-xs">Other Assets</Label><Input type="number" value={form.otherAssets} onChange={f("otherAssets")} placeholder="0.00" /></div>
          </div>
          <div className="font-semibold text-sm mt-2">Liabilities</div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label className="text-xs">Car Loan</Label><Input type="number" value={form.carLoan} onChange={f("carLoan")} placeholder="0.00" /></div>
            <div><Label className="text-xs">Student Loans</Label><Input type="number" value={form.studentLoans} onChange={f("studentLoans")} placeholder="0.00" /></div>
            <div><Label className="text-xs">Other</Label><Input type="number" value={form.otherLiabilities} onChange={f("otherLiabilities")} placeholder="0.00" /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={createSnapshot.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddCreditScoreDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ asOfDate: new Date().toISOString().split("T")[0], experian: "", equifax: "", transunion: "" });
  const createScore = useCreateCreditScore();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSave = () => {
    createScore.mutate({
      data: {
        asOfDate: form.asOfDate,
        experian: parseInt(form.experian) || null,
        equifax: parseInt(form.equifax) || null,
        transunion: parseInt(form.transunion) || null,
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCreditScoresQueryKey() });
        setOpen(false);
        toast({ title: "Credit scores saved" });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-add-credit-score"><Plus className="mr-2 h-4 w-4" />Credit Scores</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Update Credit Scores</DialogTitle></DialogHeader>
        <div className="grid gap-3 py-2">
          <div><Label>Date</Label><Input type="date" value={form.asOfDate} onChange={(e) => setForm((p) => ({ ...p, asOfDate: e.target.value }))} /></div>
          <div><Label>Experian</Label><Input type="number" value={form.experian} onChange={(e) => setForm((p) => ({ ...p, experian: e.target.value }))} placeholder="756" /></div>
          <div><Label>Equifax</Label><Input type="number" value={form.equifax} onChange={(e) => setForm((p) => ({ ...p, equifax: e.target.value }))} placeholder="754" /></div>
          <div><Label>TransUnion</Label><Input type="number" value={form.transunion} onChange={(e) => setForm((p) => ({ ...p, transunion: e.target.value }))} placeholder="736" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
