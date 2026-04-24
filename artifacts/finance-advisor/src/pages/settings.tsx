import { useState, useMemo } from "react";
import {
  useGetAssumptions,
  getGetAssumptionsQueryKey,
  useUpdateAssumption,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Save } from "lucide-react";
import { formatDate } from "@/lib/utils";

interface AssumptionMeta {
  label: string;
  description: string;
  prefix?: string;
  suffix?: string;
}

interface SettingsGroup {
  id: string;
  title: string;
  description: string;
  keys: string[];
}

const ASSUMPTION_META: Record<string, AssumptionMeta> = {
  // Cycle group
  next_payday_date: { label: "Next Payday Date", description: "Your next scheduled paycheck (7th or 22nd)" },
  base_net_income: { label: "Base Net Income", description: "Monthly take-home after federal/state taxes (biweekly pay × 2)", prefix: "$" },
  variable_spend_until_payday: { label: "Variable Spend Until Payday", description: "Already-spent variable amount in current cycle", prefix: "$" },
  quicksilver_balance_owed: { label: "QuickSilver Balance Owed", description: "Outstanding credit card balance to pay mid-next month", prefix: "$" },
  month_length_days: { label: "Month Length (days)", description: "Days used for proration (standard: 30.4)", suffix: " days" },

  // Reserves group
  minimum_cushion: { label: "Minimum Cushion", description: "Always-hold reserve — funds never counted as spendable", prefix: "$" },
  pending_holds_reserve: { label: "Pending Holds Reserve", description: "Extra hold for in-flight charges / uncleared transactions", prefix: "$" },
  alert_threshold: { label: "YELLOW Alert Threshold", description: "Safe to Spend below this triggers YELLOW status", prefix: "$" },
  hysa_target: { label: "HYSA Target", description: "High-yield savings account target balance", prefix: "$" },

  // Targets group
  variable_spend_cap: { label: "Variable Spend Cap", description: "Monthly budget cap for discretionary/variable spending", prefix: "$" },
  mrr_target: { label: "MRR Target", description: "Monthly Recurring Revenue quota target (payout tier breakpoint)", prefix: "$" },
  nrr_target: { label: "NRR Target", description: "Net Revenue Retention quota target (payout tier breakpoint)", prefix: "$" },

  // Tax group
  commission_tax_rate: { label: "Commission Tax Rate", description: "Effective tax rate applied to gross commission payout (0.435 = 43.5%)" },
};

const GROUPS: SettingsGroup[] = [
  {
    id: "cycle",
    title: "Cycle",
    description: "Paycheck timing, net income, and current-cycle balances that drive Safe to Spend.",
    keys: ["next_payday_date", "base_net_income", "variable_spend_until_payday", "quicksilver_balance_owed", "month_length_days"],
  },
  {
    id: "reserves",
    title: "Reserves",
    description: "Safety floors that subtract from Safe to Spend. Edit only after re-reading the playbook.",
    keys: ["minimum_cushion", "pending_holds_reserve", "alert_threshold", "hysa_target"],
  },
  {
    id: "targets",
    title: "Targets",
    description: "Quotas and budgets the engine compares actuals against.",
    keys: ["variable_spend_cap", "mrr_target", "nrr_target"],
  },
  {
    id: "tax",
    title: "Tax",
    description: "Withholding rates applied to commission and projection math.",
    keys: ["commission_tax_rate"],
  },
];

const SANDBOX_FLAG_KEY = "sandbox_enabled";

export default function Settings() {
  const { data: assumptions, isLoading } = useGetAssumptions({ query: { queryKey: getGetAssumptionsQueryKey() } });
  const updateAssumption = useUpdateAssumption();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  const allAssumptions = assumptions ?? [];

  // Sandbox toggle (Spec §3I) — stored as a string assumption "true"/"false";
  // engine never reads it, only the UI gates the Scenarios page off it.
  const sandboxAssumption = allAssumptions.find((a) => a.key === SANDBOX_FLAG_KEY);
  const sandboxEnabled = sandboxAssumption?.value !== "false"; // default ON when missing

  // Other (uncategorized) keys — preserve forward-compat with new assumptions
  // we haven't classified yet.
  const knownKeys = useMemo(() => new Set(GROUPS.flatMap((g) => g.keys)), []);
  const otherKeys = allAssumptions
    .map((a) => a.key)
    .filter((k) => !knownKeys.has(k) && k !== SANDBOX_FLAG_KEY);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const handleChange = (key: string, value: string) => {
    setEditValues((prev) => ({ ...prev, [key]: value }));
    setSaved((prev) => ({ ...prev, [key]: false }));
  };

  const handleSave = (key: string) => {
    const value = editValues[key] ?? allAssumptions.find((a) => a.key === key)?.value ?? "";
    updateAssumption.mutate(
      { key, data: { value } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAssumptionsQueryKey() });
          setSaved((prev) => ({ ...prev, [key]: true }));
          toast({ title: `Saved: ${ASSUMPTION_META[key]?.label ?? key}` });
        },
        onError: () => toast({ title: "Save failed", variant: "destructive" }),
      },
    );
  };

  const handleSandboxToggle = (next: boolean) => {
    updateAssumption.mutate(
      { key: SANDBOX_FLAG_KEY, data: { value: next ? "true" : "false" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAssumptionsQueryKey() });
          toast({ title: `Scenarios ${next ? "enabled" : "hidden"}` });
        },
        onError: () => toast({ title: "Save failed", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto" data-testid="settings-root">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Standing financial assumptions that drive every calculation in Reserve. Grouped by what they govern.
        </p>
      </div>

      {GROUPS.map((group) => {
        const presentKeys = group.keys.filter((k) => allAssumptions.some((a) => a.key === k));
        if (presentKeys.length === 0) return null;
        return (
          <Card key={group.id} data-testid={`settings-group-${group.id}`}>
            <CardHeader>
              <CardTitle>{group.title}</CardTitle>
              <CardDescription>{group.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {presentKeys.map((key) => (
                <AssumptionRow
                  key={key}
                  assumptionKey={key}
                  meta={ASSUMPTION_META[key]}
                  current={editValues[key] ?? allAssumptions.find((a) => a.key === key)?.value ?? ""}
                  updatedAt={allAssumptions.find((a) => a.key === key)?.updatedAt}
                  saved={!!saved[key]}
                  pending={updateAssumption.isPending}
                  onChange={handleChange}
                  onSave={handleSave}
                />
              ))}
            </CardContent>
          </Card>
        );
      })}

      {/* Scenarios visibility (Spec §3I) */}
      <Card data-testid="settings-group-sandbox">
        <CardHeader>
          <CardTitle>Scenarios</CardTitle>
          <CardDescription>
            The Scenarios workspace lets you model what-ifs without touching live data. Hide it if you want a simpler nav.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="sandbox-toggle" className="font-semibold">Show Scenarios in nav</Label>
              <p className="text-xs text-muted-foreground">
                When off, Scenarios is removed from the sidebar and the MORE menu. Existing saved scenarios are preserved.
              </p>
            </div>
            <Switch
              id="sandbox-toggle"
              checked={sandboxEnabled}
              onCheckedChange={handleSandboxToggle}
              disabled={updateAssumption.isPending}
              data-testid="switch-sandbox-enabled"
            />
          </div>
        </CardContent>
      </Card>

      {/* Forward-compat: any assumption keys we don't have metadata for */}
      {otherKeys.length > 0 && (
        <Card data-testid="settings-group-other">
          <CardHeader>
            <CardTitle>Other</CardTitle>
            <CardDescription>Keys present in the database without categorized metadata.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {otherKeys.map((key) => (
              <AssumptionRow
                key={key}
                assumptionKey={key}
                meta={undefined}
                current={editValues[key] ?? allAssumptions.find((a) => a.key === key)?.value ?? ""}
                updatedAt={allAssumptions.find((a) => a.key === key)?.updatedAt}
                saved={!!saved[key]}
                pending={updateAssumption.isPending}
                onChange={handleChange}
                onSave={handleSave}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface AssumptionRowProps {
  assumptionKey: string;
  meta: AssumptionMeta | undefined;
  current: string;
  updatedAt: string | Date | null | undefined;
  saved: boolean;
  pending: boolean;
  onChange: (key: string, value: string) => void;
  onSave: (key: string) => void;
}

function AssumptionRow({ assumptionKey, meta, current, updatedAt, saved, pending, onChange, onSave }: AssumptionRowProps) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={`input-${assumptionKey}`} className="font-semibold">
        {meta?.label ?? assumptionKey}
      </Label>
      {meta?.description && (
        <p className="text-xs text-muted-foreground -mt-1">{meta.description}</p>
      )}
      <div className="flex gap-2">
        <div className="relative flex-1">
          {meta?.prefix && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{meta.prefix}</span>
          )}
          <Input
            id={`input-${assumptionKey}`}
            value={current}
            onChange={(e) => onChange(assumptionKey, e.target.value)}
            className={`font-mono ${meta?.prefix ? "pl-6" : ""}`}
            data-testid={`input-assumption-${assumptionKey}`}
          />
        </div>
        <Button
          onClick={() => onSave(assumptionKey)}
          disabled={pending}
          variant={saved ? "secondary" : "default"}
          size="icon"
          aria-label={`Save ${meta?.label ?? assumptionKey}`}
          data-testid={`button-save-assumption-${assumptionKey}`}
        >
          <Save className="h-4 w-4" />
        </Button>
      </div>
      {updatedAt && (
        <p className="text-xs text-muted-foreground">Last updated: {formatDate(updatedAt)}</p>
      )}
    </div>
  );
}
