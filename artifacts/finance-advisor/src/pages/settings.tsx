import { useState } from "react";
import { useGetAssumptions, getGetAssumptionsQueryKey, useUpdateAssumption } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Save } from "lucide-react";
import { formatDate } from "@/lib/utils";

const ASSUMPTION_META: Record<string, { label: string; description: string; prefix?: string; suffix?: string }> = {
  next_payday_date: { label: "Next Payday Date", description: "Your next scheduled paycheck (7th or 22nd)" },
  base_net_income: { label: "Base Net Income", description: "Monthly take-home after federal/state taxes (biweekly pay × 2)", prefix: "$" },
  variable_spend_cap: { label: "Variable Spend Cap", description: "Monthly budget cap for discretionary/variable spending", prefix: "$" },
  alert_threshold: { label: "Alert Threshold (YELLOW)", description: "Safe to Spend below this triggers YELLOW status", prefix: "$" },
  minimum_cushion: { label: "Minimum Cushion", description: "Always-hold reserve — funds never counted as spendable", prefix: "$" },
  pending_holds_reserve: { label: "Pending Holds Reserve", description: "Extra hold for in-flight charges / uncleared transactions", prefix: "$" },
  month_length_days: { label: "Month Length (days)", description: "Days used for proration (standard: 30.4)", suffix: " days" },
  mrr_target: { label: "MRR Target", description: "Monthly Recurring Revenue quota target (payout tier breakpoint)", prefix: "$" },
  nrr_target: { label: "NRR Target", description: "Net Revenue Retention quota target (payout tier breakpoint)", prefix: "$" },
  commission_tax_rate: { label: "Commission Tax Rate", description: "Effective tax rate applied to gross commission payout (0.435 = 43.5%)" },
  hysa_target: { label: "HYSA Target", description: "High-yield savings account target balance", prefix: "$" },
  variable_spend_until_payday: { label: "Variable Spend Until Payday", description: "Already-spent variable amount in current cycle", prefix: "$" },
};

export default function Settings() {
  const { data: assumptions, isLoading } = useGetAssumptions({ query: { queryKey: getGetAssumptionsQueryKey() } });
  const updateAssumption = useUpdateAssumption();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  if (isLoading) return (
    <div className="space-y-4">
      <Skeleton className="h-12 w-64" />
      <Skeleton className="h-96 w-full" />
    </div>
  );

  const handleChange = (key: string, value: string) => {
    setEditValues((prev) => ({ ...prev, [key]: value }));
    setSaved((prev) => ({ ...prev, [key]: false }));
  };

  const handleSave = (key: string) => {
    const value = editValues[key] ?? assumptions?.find((a) => a.key === key)?.value ?? "";
    updateAssumption.mutate(
      { key, data: { value } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAssumptionsQueryKey() });
          setSaved((prev) => ({ ...prev, [key]: true }));
          toast({ title: `Saved: ${ASSUMPTION_META[key]?.label ?? key}` });
        },
        onError: () => toast({ title: "Save failed", variant: "destructive" }),
      }
    );
  };

  const orderedKeys = Object.keys(ASSUMPTION_META);
  const allAssumptions = assumptions ?? [];
  const allKeys = [
    ...orderedKeys.filter((k) => allAssumptions.some((a) => a.key === k)),
    ...allAssumptions.filter((a) => !orderedKeys.includes(a.key)).map((a) => a.key),
  ];

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">Financial assumptions and parameters that drive all calculations.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Financial Assumptions</CardTitle>
          <CardDescription>These 12 parameters control every computed value in Reserve. Edit carefully.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {allKeys.map((key) => {
            const assumption = allAssumptions.find((a) => a.key === key);
            const meta = ASSUMPTION_META[key];
            const currentValue = editValues[key] ?? assumption?.value ?? "";
            const wasSaved = saved[key];

            return (
              <div key={key} className="grid gap-2">
                <Label htmlFor={`input-${key}`} className="font-semibold">
                  {meta?.label ?? key}
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
                      id={`input-${key}`}
                      value={currentValue}
                      onChange={(e) => handleChange(key, e.target.value)}
                      className={`font-mono ${meta?.prefix ? "pl-6" : ""}`}
                      data-testid={`input-assumption-${key}`}
                    />
                  </div>
                  <Button
                    onClick={() => handleSave(key)}
                    disabled={updateAssumption.isPending}
                    variant={wasSaved ? "secondary" : "default"}
                    size="icon"
                    data-testid={`button-save-assumption-${key}`}
                  >
                    <Save className="h-4 w-4" />
                  </Button>
                </div>
                {assumption?.updatedAt && (
                  <p className="text-xs text-muted-foreground">Last updated: {formatDate(assumption.updatedAt)}</p>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
