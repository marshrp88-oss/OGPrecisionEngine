import { useState } from "react";
import {
  useGetCommissionSummary,
  getGetCommissionSummaryQueryKey,
  useGetDashboardCycle,
  getGetDashboardCycleQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, formatPercent } from "@/lib/utils";
import {
  pmt,
  droughtSurvivalRunway,
  incomeReplacementFloor,
  incomeGrowthScenario,
} from "@/lib/finance-adapter";

export default function Sandbox() {
  const { data: cycle } = useGetDashboardCycle({ query: { queryKey: getGetDashboardCycleQueryKey() } });
  const { data: summary } = useGetCommissionSummary({ query: { queryKey: getGetCommissionSummaryQueryKey() } });

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Decision Sandbox</h1>
        <p className="text-muted-foreground mt-1 text-sm">Model financial decisions before committing. No data is saved.</p>
      </div>

      <Tabs defaultValue="vehicle">
        <TabsList className="w-full">
          <TabsTrigger value="vehicle" className="flex-1">Vehicle Purchase</TabsTrigger>
          <TabsTrigger value="drought" className="flex-1">Drought Survival</TabsTrigger>
          <TabsTrigger value="income_floor" className="flex-1">Income Floor</TabsTrigger>
          <TabsTrigger value="income_change" className="flex-1">Income Change</TabsTrigger>
        </TabsList>

        <TabsContent value="vehicle">
          <VehicleScenario targetPayment={315} />
        </TabsContent>

        <TabsContent value="drought">
          <DroughtSurvivalScenario
            checkingBalance={cycle?.checkingBalance ?? 0}
          />
        </TabsContent>

        <TabsContent value="income_floor">
          <IncomeFloorScenario />
        </TabsContent>

        <TabsContent value="income_change">
          <IncomeChangeScenario currentBase={54000} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function VehicleScenario({ targetPayment }: { targetPayment: number }) {
  const [sticker, setSticker] = useState("30000");
  const [downPayment, setDownPayment] = useState("3700");
  const [rate, setRate] = useState("5.74");
  const [months, setMonths] = useState("60");
  const [insurance, setInsurance] = useState("182");

  const stickerN = parseFloat(sticker) || 0;
  const downN = parseFloat(downPayment) || 0;
  const rateN = parseFloat(rate) / 100 || 0;
  const monthsN = parseInt(months) || 60;
  const insuranceN = parseFloat(insurance) || 0;

  const principal = Math.max(0, stickerN - downN);
  const payment = principal > 0 && monthsN > 0 ? pmt(rateN, monthsN, principal) : 0;
  const totalCost = payment * monthsN + downN;
  const totalInterest = totalCost - stickerN;
  const newMonthlyBurn = payment + insuranceN;
  const affordable = payment <= targetPayment;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vehicle Purchase Analysis</CardTitle>
        <CardDescription>Evaluate a car purchase against your $315/mo payment target.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          <div><Label>Sticker Price ($)</Label><Input type="number" value={sticker} onChange={(e) => setSticker(e.target.value)} className="font-mono" /></div>
          <div><Label>Down Payment ($)</Label><Input type="number" value={downPayment} onChange={(e) => setDownPayment(e.target.value)} className="font-mono" /></div>
          <div><Label>Interest Rate (%)</Label><Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} className="font-mono" /></div>
          <div><Label>Term (months)</Label><Input type="number" value={months} onChange={(e) => setMonths(e.target.value)} className="font-mono" /></div>
          <div><Label>Insurance/mo ($)</Label><Input type="number" value={insurance} onChange={(e) => setInsurance(e.target.value)} className="font-mono" /></div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div className={`p-4 rounded-xl text-center border-2 ${affordable ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30" : "border-destructive bg-destructive/10"}`}>
            <div className="text-xs text-muted-foreground uppercase mb-1">Monthly Payment</div>
            <div className={`text-2xl font-bold font-mono ${affordable ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}`}>
              {formatCurrency(payment)}
            </div>
            <div className="text-xs mt-1">{affordable ? `Under $${targetPayment} target` : `OVER $${targetPayment} target by ${formatCurrency(payment - targetPayment)}`}</div>
          </div>
          <div className="p-4 rounded-xl text-center bg-muted/50">
            <div className="text-xs text-muted-foreground uppercase mb-1">Monthly Burn (w/ Insurance)</div>
            <div className="text-2xl font-bold font-mono">{formatCurrency(newMonthlyBurn)}</div>
          </div>
          <div className="p-4 rounded-xl text-center bg-muted/50">
            <div className="text-xs text-muted-foreground uppercase mb-1">Total Interest Paid</div>
            <div className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">{formatCurrency(totalInterest)}</div>
          </div>
          <div className="p-4 rounded-xl text-center bg-muted/50">
            <div className="text-xs text-muted-foreground uppercase mb-1">Total Cost of Vehicle</div>
            <div className="text-2xl font-bold font-mono">{formatCurrency(totalCost)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DroughtSurvivalScenario({ checkingBalance }: { checkingBalance: number }) {
  const [checking, setChecking] = useState(String(Math.round(checkingBalance)));
  const [hysa, setHysa] = useState("12600");
  const [monthlyBurn, setMonthlyBurn] = useState("2104");

  const checkingN = parseFloat(checking) || 0;
  const hysaN = parseFloat(hysa) || 0;
  const burnN = parseFloat(monthlyBurn) || 0;

  // Engine: drought survival assumes monthly burn = fixed bills + variable cap
  // and zero base-net-monthly income. We treat the user-entered burn as the
  // total burn (already inclusive of variable spend), and pass baseNet=0.
  const result = droughtSurvivalRunway(checkingN, hysaN, burnN, 0, 0);
  const totalLiquid = result.totalLiquid;
  const runwayMonths = result.indefinite ? 0 : result.runway_months ?? 0;
  const months = Math.floor(runwayMonths);
  const days = Math.round((runwayMonths - months) * 30);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Commission Drought Survival</CardTitle>
        <CardDescription>How long can you survive on base pay alone with current liquid assets?</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div><Label>Checking ($)</Label><Input type="number" value={checking} onChange={(e) => setChecking(e.target.value)} className="font-mono" /></div>
          <div><Label>HYSA ($)</Label><Input type="number" value={hysa} onChange={(e) => setHysa(e.target.value)} className="font-mono" /></div>
          <div><Label>Monthly Burn ($)</Label><Input type="number" value={monthlyBurn} onChange={(e) => setMonthlyBurn(e.target.value)} className="font-mono" /></div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl bg-muted/50 text-center">
            <div className="text-xs text-muted-foreground uppercase mb-1">Total Liquid</div>
            <div className="text-2xl font-bold font-mono">{formatCurrency(totalLiquid)}</div>
          </div>
          <div className="p-4 rounded-xl text-center border-2 border-primary/30 bg-primary/5">
            <div className="text-xs text-muted-foreground uppercase mb-1">Runway</div>
            <div className="text-2xl font-bold font-mono">{months}m {days}d</div>
            <div className="text-xs mt-1">{runwayMonths.toFixed(1)} months total</div>
          </div>
          <div className="p-4 rounded-xl bg-muted/50 text-center">
            <div className="text-xs text-muted-foreground uppercase mb-1">Monthly Burn</div>
            <div className="text-2xl font-bold font-mono">{formatCurrency(burnN)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function IncomeFloorScenario() {
  const [targetSavings, setTargetSavings] = useState("500");
  const [fixedMonthly, setFixedMonthly] = useState("2104");
  const [variableCap, setVariableCap] = useState("600");
  const [taxRate, setTaxRate] = useState("22");

  const targetN = parseFloat(targetSavings) || 0;
  const fixedN = parseFloat(fixedMonthly) || 0;
  const varN = parseFloat(variableCap) || 0;
  const taxN = parseFloat(taxRate) / 100 || 0;

  const requiredNet = targetN + fixedN + varN;
  const [requiredGross] = taxN < 1 ? incomeReplacementFloor(targetN, fixedN, varN, taxN) : [0, 0];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Income Replacement Floor</CardTitle>
        <CardDescription>What gross salary covers your financial floor at a target savings rate?</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div><Label>Target Monthly Savings ($)</Label><Input type="number" value={targetSavings} onChange={(e) => setTargetSavings(e.target.value)} className="font-mono" /></div>
          <div><Label>Fixed Monthly Bills ($)</Label><Input type="number" value={fixedMonthly} onChange={(e) => setFixedMonthly(e.target.value)} className="font-mono" /></div>
          <div><Label>Variable Cap ($)</Label><Input type="number" value={variableCap} onChange={(e) => setVariableCap(e.target.value)} className="font-mono" /></div>
          <div><Label>Effective Tax Rate (%)</Label><Input type="number" step="0.1" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} className="font-mono" /></div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="p-6 rounded-xl text-center bg-muted/50">
            <div className="text-xs text-muted-foreground uppercase mb-2">Required Monthly Net Income</div>
            <div className="text-3xl font-bold font-mono">{formatCurrency(requiredNet)}</div>
          </div>
          <div className="p-6 rounded-xl text-center border-2 border-primary/30 bg-primary/5">
            <div className="text-xs text-muted-foreground uppercase mb-2">Required Annual Gross Salary</div>
            <div className="text-3xl font-bold font-mono">{formatCurrency(requiredGross)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function IncomeChangeScenario({ currentBase }: { currentBase: number }) {
  const [currentSalary, setCurrentSalary] = useState(String(currentBase));
  const [newSalary, setNewSalary] = useState("65000");
  const [taxRate, setTaxRate] = useState("22");

  const currentN = parseFloat(currentSalary) || 0;
  const newN = parseFloat(newSalary) || 0;
  const taxN = parseFloat(taxRate) / 100 || 0;

  // Engine takes federal+state tax rates separately; we pass the combined
  // effective rate as `fed` and 0 as `state` (sum is the same).
  const currentMonthlyNet = (currentN / 12) * (1 - taxN);
  const result = incomeGrowthScenario(currentN, newN, taxN, 0, currentMonthlyNet, 0);
  const monthlyIncrease = result.monthly_net_increase;
  const newMonthlyNet = result.new_monthly_net;
  const annualIncrease = monthlyIncrease * 12;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Income Change Analysis</CardTitle>
        <CardDescription>Model the net impact of a raise or job change.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div><Label>Current Gross Salary ($)</Label><Input type="number" value={currentSalary} onChange={(e) => setCurrentSalary(e.target.value)} className="font-mono" /></div>
          <div><Label>New Gross Salary ($)</Label><Input type="number" value={newSalary} onChange={(e) => setNewSalary(e.target.value)} className="font-mono" /></div>
          <div><Label>Effective Tax Rate (%)</Label><Input type="number" step="0.1" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} className="font-mono" /></div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl bg-muted/50 text-center">
            <div className="text-xs text-muted-foreground uppercase mb-1">Current Monthly Net</div>
            <div className="text-xl font-bold font-mono">{formatCurrency(currentMonthlyNet)}</div>
          </div>
          <div className="p-4 rounded-xl bg-muted/50 text-center">
            <div className="text-xs text-muted-foreground uppercase mb-1">New Monthly Net</div>
            <div className="text-xl font-bold font-mono">{formatCurrency(newMonthlyNet)}</div>
          </div>
          <div className={`p-4 rounded-xl text-center border-2 ${monthlyIncrease >= 0 ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30" : "border-destructive bg-destructive/10"}`}>
            <div className="text-xs text-muted-foreground uppercase mb-1">Monthly Increase</div>
            <div className={`text-xl font-bold font-mono ${monthlyIncrease >= 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}`}>
              {monthlyIncrease >= 0 ? "+" : ""}{formatCurrency(monthlyIncrease)}
            </div>
          </div>
          <div className="p-4 rounded-xl bg-muted/50 text-center">
            <div className="text-xs text-muted-foreground uppercase mb-1">Annual Net Increase</div>
            <div className="text-xl font-bold font-mono">{formatCurrency(annualIncrease)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
