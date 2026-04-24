import { useState } from "react";
import {
  useGetCommissionSummary,
  getGetCommissionSummaryQueryKey,
  useGetDashboardCycle,
  getGetDashboardCycleQueryKey,
  useGetScenarios,
  getGetScenariosQueryKey,
  useCreateScenario,
  useUpdateScenario,
  useDeleteScenario,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  pmt,
  droughtSurvivalRunway,
  incomeReplacementFloor,
  incomeGrowthScenario,
} from "@/lib/finance-adapter";
import { Save, Trash2, FolderOpen, Star, StarOff } from "lucide-react";

type ScenarioType = "vehicle" | "drought_survival" | "income_floor" | "income_change";

const SCENARIO_TYPES: readonly ScenarioType[] = [
  "vehicle",
  "drought_survival",
  "income_floor",
  "income_change",
] as const;

const isScenarioType = (v: unknown): v is ScenarioType =>
  typeof v === "string" && (SCENARIO_TYPES as readonly string[]).includes(v);

const isStringRecord = (v: unknown): v is Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (val) => typeof val === "string",
  );
};

interface VehicleInputs {
  sticker: string;
  downPayment: string;
  rate: string;
  months: string;
  insurance: string;
}

interface DroughtInputs {
  checking: string;
  hysa: string;
  monthlyBurn: string;
}

interface IncomeFloorInputs {
  targetSavings: string;
  fixedMonthly: string;
  variableCap: string;
  taxRate: string;
}

interface IncomeChangeInputs {
  currentSalary: string;
  newSalary: string;
  taxRate: string;
}

type ScenarioInputs = VehicleInputs | DroughtInputs | IncomeFloorInputs | IncomeChangeInputs;

interface SavedScenario {
  id: number;
  name: string;
  type: string;
  inputsJson: Record<string, unknown>;
  outputsJson: Record<string, unknown>;
  saved: boolean;
  createdAt: string | Date;
}

export default function Scenarios() {
  const { data: cycle } = useGetDashboardCycle({ query: { queryKey: getGetDashboardCycleQueryKey() } });
  useGetCommissionSummary({ query: { queryKey: getGetCommissionSummaryQueryKey() } });
  const { data: scenarios, isLoading: scenariosLoading } = useGetScenarios({
    query: { queryKey: getGetScenariosQueryKey() },
  });

  const { toast } = useToast();

  const [activeTab, setActiveTab] = useState<ScenarioType>("vehicle");

  // Per-tab inputs (lifted so save/load can read/write them)
  const [vehicle, setVehicle] = useState<VehicleInputs>({
    sticker: "30000",
    downPayment: "3700",
    rate: "5.74",
    months: "60",
    insurance: "182",
  });
  const [drought, setDrought] = useState<DroughtInputs>({
    checking: String(Math.round(cycle?.checkingBalance ?? 2500)),
    hysa: "12600",
    monthlyBurn: "2104",
  });
  const [incomeFloor, setIncomeFloor] = useState<IncomeFloorInputs>({
    targetSavings: "500",
    fixedMonthly: "2104",
    variableCap: "600",
    taxRate: "22",
  });
  const [incomeChange, setIncomeChange] = useState<IncomeChangeInputs>({
    currentSalary: "54000",
    newSalary: "65000",
    taxRate: "22",
  });

  const toSaveable = (i: ScenarioInputs): Record<string, unknown> =>
    i as unknown as Record<string, unknown>;

  const handleLoad = (s: SavedScenario) => {
    if (!isScenarioType(s.type)) {
      toast({
        title: "Cannot load scenario",
        description: `Unsupported scenario type: ${String(s.type)}`,
        variant: "destructive",
      });
      return;
    }
    if (!isStringRecord(s.inputsJson)) {
      toast({
        title: "Cannot load scenario",
        description: "Saved inputs are malformed.",
        variant: "destructive",
      });
      return;
    }
    setActiveTab(s.type);
    const inputs = s.inputsJson;
    if (s.type === "vehicle") setVehicle(inputs as unknown as VehicleInputs);
    else if (s.type === "drought_survival") setDrought(inputs as unknown as DroughtInputs);
    else if (s.type === "income_floor") setIncomeFloor(inputs as unknown as IncomeFloorInputs);
    else if (s.type === "income_change") setIncomeChange(inputs as unknown as IncomeChangeInputs);
  };

  const allScenarios = (scenarios as SavedScenario[] | undefined) ?? [];
  const savedOnly = allScenarios.filter((s) => s.saved);

  return (
    <div className="space-y-6 max-w-5xl mx-auto" data-testid="scenarios-root">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Scenarios</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Model financial decisions before committing. Save what you want to revisit — everything else stays ephemeral.
        </p>
      </div>

      <SavedScenariosCard
        scenarios={savedOnly}
        loading={scenariosLoading}
        onLoad={handleLoad}
      />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ScenarioType)}>
        <TabsList className="w-full flex-wrap h-auto">
          <TabsTrigger value="vehicle" className="flex-1 min-w-[140px]">Vehicle</TabsTrigger>
          <TabsTrigger value="drought_survival" className="flex-1 min-w-[140px]">Drought Survival</TabsTrigger>
          <TabsTrigger value="income_floor" className="flex-1 min-w-[140px]">Income Floor</TabsTrigger>
          <TabsTrigger value="income_change" className="flex-1 min-w-[140px]">Income Change</TabsTrigger>
        </TabsList>

        <TabsContent value="vehicle">
          <VehicleScenario
            inputs={vehicle}
            setInputs={setVehicle}
            inputsForSave={toSaveable(vehicle)}
          />
        </TabsContent>

        <TabsContent value="drought_survival">
          <DroughtSurvivalScenario
            inputs={drought}
            setInputs={setDrought}
            inputsForSave={toSaveable(drought)}
          />
        </TabsContent>

        <TabsContent value="income_floor">
          <IncomeFloorScenario
            inputs={incomeFloor}
            setInputs={setIncomeFloor}
            inputsForSave={toSaveable(incomeFloor)}
          />
        </TabsContent>

        <TabsContent value="income_change">
          <IncomeChangeScenario
            inputs={incomeChange}
            setInputs={setIncomeChange}
            inputsForSave={toSaveable(incomeChange)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SavedScenariosCard({
  scenarios,
  loading,
  onLoad,
}: {
  scenarios: SavedScenario[];
  loading: boolean;
  onLoad: (s: SavedScenario) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateScenario = useUpdateScenario();
  const deleteScenario = useDeleteScenario();

  const handleUnsave = (s: SavedScenario) => {
    updateScenario.mutate(
      { id: s.id, data: { saved: false } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetScenariosQueryKey() });
          toast({ title: `Removed "${s.name}" from saved` });
        },
      },
    );
  };

  const handleDelete = (s: SavedScenario) => {
    if (!confirm(`Delete scenario "${s.name}"?`)) return;
    deleteScenario.mutate(
      { id: s.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetScenariosQueryKey() });
          toast({ title: `Deleted "${s.name}"` });
        },
      },
    );
  };

  const typeLabel = (t: string) =>
    ({
      vehicle: "Vehicle",
      drought_survival: "Drought Survival",
      income_floor: "Income Floor",
      income_change: "Income Change",
      large_purchase: "Large Purchase",
      custom: "Custom",
    } as Record<string, string>)[t] ?? t;

  return (
    <Card data-testid="saved-scenarios-card">
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wider">Saved Scenarios</CardTitle>
        <CardDescription className="text-xs">
          Pinned models that survive across sessions. Load to repopulate inputs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : scenarios.length === 0 ? (
          <p className="text-sm text-muted-foreground font-mono">
            None yet. Run a scenario below, then click "Save" to keep it.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {scenarios.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 py-3"
                data-testid={`saved-scenario-${s.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold truncate">{s.name}</span>
                    <Badge variant="outline" className="text-xs">{typeLabel(s.type)}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Saved {formatDate(s.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onLoad(s)}
                    data-testid={`button-load-scenario-${s.id}`}
                  >
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    Load
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleUnsave(s)}
                    aria-label="Unpin scenario"
                    data-testid={`button-unsave-scenario-${s.id}`}
                  >
                    <StarOff className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleDelete(s)}
                    aria-label="Delete scenario"
                    data-testid={`button-delete-scenario-${s.id}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function SaveScenarioButton({
  type,
  defaultName,
  inputs,
}: {
  type: ScenarioType;
  defaultName: string;
  inputs: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createScenario = useCreateScenario();

  const handleSave = () => {
    const finalName = name.trim() || defaultName;
    createScenario.mutate(
      {
        data: {
          name: finalName,
          type,
          inputsJson: inputs,
          saved: true,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetScenariosQueryKey() });
          toast({ title: `Saved "${finalName}"` });
          setOpen(false);
          setName(defaultName);
        },
        onError: (err) => {
          toast({
            title: "Save failed",
            description: (err as Error).message,
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid={`button-save-scenario-${type}`}>
          <Star className="mr-1.5 h-3.5 w-3.5" />
          Save scenario
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save scenario</DialogTitle>
          <DialogDescription>
            Persist these inputs so you can reload them later. Scenarios are local to your account.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="scenario-name">Name</Label>
          <Input
            id="scenario-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={defaultName}
            data-testid="input-scenario-name"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={createScenario.isPending}
            data-testid="button-confirm-save-scenario"
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VehicleScenario({
  inputs,
  setInputs,
  inputsForSave,
}: {
  inputs: VehicleInputs;
  setInputs: (v: VehicleInputs) => void;
  inputsForSave: Record<string, unknown>;
}) {
  const targetPayment = 315;
  const stickerN = parseFloat(inputs.sticker) || 0;
  const downN = parseFloat(inputs.downPayment) || 0;
  const rateN = parseFloat(inputs.rate) / 100 || 0;
  const monthsN = parseInt(inputs.months) || 60;
  const insuranceN = parseFloat(inputs.insurance) || 0;

  const principal = Math.max(0, stickerN - downN);
  const payment = principal > 0 && monthsN > 0 ? pmt(rateN, monthsN, principal) : 0;
  const totalCost = payment * monthsN + downN;
  const totalInterest = totalCost - stickerN;
  const newMonthlyBurn = payment + insuranceN;
  const affordable = payment <= targetPayment;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Vehicle Purchase Analysis</CardTitle>
          <CardDescription>Evaluate a car purchase against your $315/mo payment target.</CardDescription>
        </div>
        <SaveScenarioButton type="vehicle" defaultName={`Vehicle: ${formatCurrency(stickerN)} sticker`} inputs={inputsForSave} />
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          <div><Label>Sticker Price ($)</Label><Input type="number" value={inputs.sticker} onChange={(e) => setInputs({ ...inputs, sticker: e.target.value })} className="font-mono" data-testid="input-vehicle-sticker" /></div>
          <div><Label>Down Payment ($)</Label><Input type="number" value={inputs.downPayment} onChange={(e) => setInputs({ ...inputs, downPayment: e.target.value })} className="font-mono" data-testid="input-vehicle-down" /></div>
          <div><Label>Interest Rate (%)</Label><Input type="number" step="0.01" value={inputs.rate} onChange={(e) => setInputs({ ...inputs, rate: e.target.value })} className="font-mono" data-testid="input-vehicle-rate" /></div>
          <div><Label>Term (months)</Label><Input type="number" value={inputs.months} onChange={(e) => setInputs({ ...inputs, months: e.target.value })} className="font-mono" data-testid="input-vehicle-months" /></div>
          <div><Label>Insurance/mo ($)</Label><Input type="number" value={inputs.insurance} onChange={(e) => setInputs({ ...inputs, insurance: e.target.value })} className="font-mono" data-testid="input-vehicle-insurance" /></div>
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

function DroughtSurvivalScenario({
  inputs,
  setInputs,
  inputsForSave,
}: {
  inputs: DroughtInputs;
  setInputs: (v: DroughtInputs) => void;
  inputsForSave: Record<string, unknown>;
}) {
  const checkingN = parseFloat(inputs.checking) || 0;
  const hysaN = parseFloat(inputs.hysa) || 0;
  const burnN = parseFloat(inputs.monthlyBurn) || 0;

  const result = droughtSurvivalRunway(checkingN, hysaN, burnN, 0, 0);
  const totalLiquid = result.totalLiquid;
  const runwayMonths = result.indefinite ? 0 : result.runway_months ?? 0;
  const months = Math.floor(runwayMonths);
  const days = Math.round((runwayMonths - months) * 30);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Commission Drought Survival</CardTitle>
          <CardDescription>How long can you survive on base pay alone with current liquid assets?</CardDescription>
        </div>
        <SaveScenarioButton type="drought_survival" defaultName={`Drought: ${formatCurrency(burnN)}/mo burn`} inputs={inputsForSave} />
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div><Label>Checking ($)</Label><Input type="number" value={inputs.checking} onChange={(e) => setInputs({ ...inputs, checking: e.target.value })} className="font-mono" data-testid="input-drought-checking" /></div>
          <div><Label>HYSA ($)</Label><Input type="number" value={inputs.hysa} onChange={(e) => setInputs({ ...inputs, hysa: e.target.value })} className="font-mono" data-testid="input-drought-hysa" /></div>
          <div><Label>Monthly Burn ($)</Label><Input type="number" value={inputs.monthlyBurn} onChange={(e) => setInputs({ ...inputs, monthlyBurn: e.target.value })} className="font-mono" data-testid="input-drought-burn" /></div>
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

function IncomeFloorScenario({
  inputs,
  setInputs,
  inputsForSave,
}: {
  inputs: IncomeFloorInputs;
  setInputs: (v: IncomeFloorInputs) => void;
  inputsForSave: Record<string, unknown>;
}) {
  const targetN = parseFloat(inputs.targetSavings) || 0;
  const fixedN = parseFloat(inputs.fixedMonthly) || 0;
  const varN = parseFloat(inputs.variableCap) || 0;
  const taxN = parseFloat(inputs.taxRate) / 100 || 0;

  const requiredNet = targetN + fixedN + varN;
  const [requiredGross] = taxN < 1 ? incomeReplacementFloor(targetN, fixedN, varN, taxN) : [0, 0];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Income Replacement Floor</CardTitle>
          <CardDescription>What gross salary covers your financial floor at a target savings rate?</CardDescription>
        </div>
        <SaveScenarioButton type="income_floor" defaultName={`Floor: ${formatCurrency(targetN)}/mo savings`} inputs={inputsForSave} />
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div><Label>Target Monthly Savings ($)</Label><Input type="number" value={inputs.targetSavings} onChange={(e) => setInputs({ ...inputs, targetSavings: e.target.value })} className="font-mono" data-testid="input-floor-target" /></div>
          <div><Label>Fixed Monthly Bills ($)</Label><Input type="number" value={inputs.fixedMonthly} onChange={(e) => setInputs({ ...inputs, fixedMonthly: e.target.value })} className="font-mono" data-testid="input-floor-fixed" /></div>
          <div><Label>Variable Cap ($)</Label><Input type="number" value={inputs.variableCap} onChange={(e) => setInputs({ ...inputs, variableCap: e.target.value })} className="font-mono" data-testid="input-floor-var" /></div>
          <div><Label>Effective Tax Rate (%)</Label><Input type="number" step="0.1" value={inputs.taxRate} onChange={(e) => setInputs({ ...inputs, taxRate: e.target.value })} className="font-mono" data-testid="input-floor-tax" /></div>
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

function IncomeChangeScenario({
  inputs,
  setInputs,
  inputsForSave,
}: {
  inputs: IncomeChangeInputs;
  setInputs: (v: IncomeChangeInputs) => void;
  inputsForSave: Record<string, unknown>;
}) {
  const currentN = parseFloat(inputs.currentSalary) || 0;
  const newN = parseFloat(inputs.newSalary) || 0;
  const taxN = parseFloat(inputs.taxRate) / 100 || 0;

  const currentMonthlyNet = (currentN / 12) * (1 - taxN);
  const result = incomeGrowthScenario(currentN, newN, taxN, 0, currentMonthlyNet, 0);
  const monthlyIncrease = result.monthly_net_increase;
  const newMonthlyNet = result.new_monthly_net;
  const annualIncrease = monthlyIncrease * 12;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Income Change Analysis</CardTitle>
          <CardDescription>Model the net impact of a raise or job change.</CardDescription>
        </div>
        <SaveScenarioButton type="income_change" defaultName={`Income: ${formatCurrency(currentN)} → ${formatCurrency(newN)}`} inputs={inputsForSave} />
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div><Label>Current Gross Salary ($)</Label><Input type="number" value={inputs.currentSalary} onChange={(e) => setInputs({ ...inputs, currentSalary: e.target.value })} className="font-mono" data-testid="input-income-current" /></div>
          <div><Label>New Gross Salary ($)</Label><Input type="number" value={inputs.newSalary} onChange={(e) => setInputs({ ...inputs, newSalary: e.target.value })} className="font-mono" data-testid="input-income-new" /></div>
          <div><Label>Effective Tax Rate (%)</Label><Input type="number" step="0.1" value={inputs.taxRate} onChange={(e) => setInputs({ ...inputs, taxRate: e.target.value })} className="font-mono" data-testid="input-income-tax" /></div>
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
