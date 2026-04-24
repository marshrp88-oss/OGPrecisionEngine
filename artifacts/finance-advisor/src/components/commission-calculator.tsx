import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RotateCcw } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import {
  mrrPayoutGross,
  nrrPayoutGross,
  commissionTakeHome,
  MRR_TARGET,
  NRR_TARGET,
  COMMISSION_TAX_RATE,
} from "@/lib/finance-adapter";

const DEFAULT_MRR = String(MRR_TARGET);
const DEFAULT_NRR = String(NRR_TARGET);

interface TierBreakdown {
  band: string;
  multiplier: number;
  amount: number;
  payout: number;
}

function mrrTierBreakdown(mrr: number, target: number = MRR_TARGET): TierBreakdown[] {
  const tier1Cap = 349.93;
  const tier2Cap = 489.93;
  const tier3Cap = target - 0.07;
  const t1 = Math.max(0, Math.min(mrr, tier1Cap));
  const t2 = Math.max(0, Math.min(mrr, tier2Cap) - tier1Cap);
  const t3 = Math.max(0, Math.min(mrr, tier3Cap) - tier2Cap);
  const t4 = Math.max(0, mrr - tier3Cap);
  return [
    { band: `$0 – $${tier1Cap.toFixed(2)}`, multiplier: 0.3705, amount: t1, payout: t1 * 0.3705 },
    { band: `$${(tier1Cap + 0.01).toFixed(2)} – $${tier2Cap.toFixed(2)}`, multiplier: 0.9634, amount: t2, payout: t2 * 0.9634 },
    { band: `$${(tier2Cap + 0.01).toFixed(2)} – $${tier3Cap.toFixed(2)}`, multiplier: 5.5212, amount: t3, payout: t3 * 5.5212 },
    { band: `> $${tier3Cap.toFixed(2)}`, multiplier: 0.65, amount: t4, payout: t4 * 0.65 },
  ];
}

function nrrTierBreakdown(nrr: number, target: number = NRR_TARGET): TierBreakdown[] {
  const tier1Cap = 2999.4;
  const tier2Cap = 4199.4;
  const tier3Cap = target - 0.6;
  const t1 = Math.max(0, Math.min(nrr, tier1Cap));
  const t2 = Math.max(0, Math.min(nrr, tier2Cap) - tier1Cap);
  const t3 = Math.max(0, Math.min(nrr, tier3Cap) - tier2Cap);
  const t4 = Math.max(0, nrr - tier3Cap);
  return [
    { band: `$0 – $${tier1Cap.toFixed(2)}`, multiplier: 0.0204, amount: t1, payout: t1 * 0.0204 },
    { band: `$${(tier1Cap + 0.01).toFixed(2)} – $${tier2Cap.toFixed(2)}`, multiplier: 0.0388, amount: t2, payout: t2 * 0.0388 },
    { band: `$${(tier2Cap + 0.01).toFixed(2)} – $${tier3Cap.toFixed(2)}`, multiplier: 0.2801, amount: t3, payout: t3 * 0.2801 },
    { band: `> $${tier3Cap.toFixed(2)}`, multiplier: 0.042, amount: t4, payout: t4 * 0.042 },
  ];
}

/**
 * Live commission calculator (Spec §3F).
 *
 * Pre-fills MRR=$700 and NRR=$6,000 — the workbook target — so the headline
 * numbers ($1,424.02 + $611.95 → $2,035.97 gross → $1,150.32 take-home) are
 * the first thing the user sees. Reset button restores those defaults.
 *
 * All math via the frozen engine functions (mrrPayoutGross / nrrPayoutGross /
 * commissionTakeHome). No local arithmetic — only tier-band attribution which
 * mirrors the engine's piecewise formula.
 */
export function CommissionCalculator() {
  const [mrr, setMrr] = useState(DEFAULT_MRR);
  const [nrr, setNrr] = useState(DEFAULT_NRR);

  const mrrN = parseFloat(mrr) || 0;
  const nrrN = parseFloat(nrr) || 0;

  const mrrPayout = mrrPayoutGross(mrrN);
  const nrrPayout = nrrPayoutGross(nrrN);
  const gross = mrrPayout + nrrPayout;
  const takeHome = commissionTakeHome(mrrN, nrrN);
  const tax = gross - takeHome;

  const mrrTiers = mrrTierBreakdown(mrrN);
  const nrrTiers = nrrTierBreakdown(nrrN);

  const handleReset = () => {
    setMrr(DEFAULT_MRR);
    setNrr(DEFAULT_NRR);
  };

  return (
    <Card data-testid="commission-calculator">
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-sm font-medium uppercase tracking-wider">Live Payout Calculator</CardTitle>
          <CardDescription className="text-xs">
            4-tier MRR + 4-tier NRR · take-home after 43.5% tax · pre-filled to target ($700 / $6,000).
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleReset}
          data-testid="button-reset-calculator"
        >
          <RotateCcw className="mr-1.5 h-3 w-3" />
          Reset
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="grid gap-1">
            <Label htmlFor="calc-mrr" className="text-xs">MRR Achieved ($)</Label>
            <Input
              id="calc-mrr"
              type="number"
              step="0.01"
              value={mrr}
              onChange={(e) => setMrr(e.target.value)}
              className="font-mono"
              data-testid="input-calc-mrr"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="calc-nrr" className="text-xs">NRR Achieved ($)</Label>
            <Input
              id="calc-nrr"
              type="number"
              step="0.01"
              value={nrr}
              onChange={(e) => setNrr(e.target.value)}
              className="font-mono"
              data-testid="input-calc-nrr"
            />
          </div>
        </div>

        {/* Headline numbers */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <ResultTile label="MRR Payout" value={mrrPayout} testId="calc-mrr-payout" />
          <ResultTile label="NRR Payout" value={nrrPayout} testId="calc-nrr-payout" />
          <ResultTile label="Gross Total" value={gross} testId="calc-gross" />
          <ResultTile label="Take-Home (43.5% tax)" value={takeHome} emphasis testId="calc-take-home" />
        </div>

        <p className="text-xs text-muted-foreground font-mono">
          Tax withheld at {(COMMISSION_TAX_RATE * 100).toFixed(1)}% (effective): {formatCurrency(tax)}.
        </p>

        {/* Tier breakdowns */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TierTable title="MRR Tiers" tiers={mrrTiers} totalLabel="MRR payout" total={mrrPayout} testIdPrefix="calc-mrr-tier" />
          <TierTable title="NRR Tiers" tiers={nrrTiers} totalLabel="NRR payout" total={nrrPayout} testIdPrefix="calc-nrr-tier" />
        </div>
      </CardContent>
    </Card>
  );
}

function ResultTile({
  label,
  value,
  emphasis,
  testId,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
  testId: string;
}) {
  return (
    <div
      className={`reserve-animate rounded-lg border p-3 ${emphasis ? "border-primary/40 bg-primary/5" : "border-border"}`}
      data-testid={testId}
    >
      <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-bold font-mono ${emphasis ? "text-primary" : ""}`}>
        {formatCurrency(value)}
      </div>
    </div>
  );
}

function TierTable({
  title,
  tiers,
  totalLabel,
  total,
  testIdPrefix,
}: {
  title: string;
  tiers: TierBreakdown[];
  totalLabel: string;
  total: number;
  testIdPrefix: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{title}</div>
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-muted-foreground border-b border-border/40">
            <th className="text-left py-1 pr-2 font-normal">Band</th>
            <th className="text-right py-1 pr-2 font-normal">×</th>
            <th className="text-right py-1 pr-2 font-normal">In tier</th>
            <th className="text-right py-1 font-normal">Payout</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t, i) => (
            <tr key={i} className={`border-b border-border/30 ${t.amount > 0 ? "" : "opacity-50"}`} data-testid={`${testIdPrefix}-${i + 1}`}>
              <td className="py-1 pr-2">{t.band}</td>
              <td className="py-1 pr-2 text-right">{t.multiplier}</td>
              <td className="py-1 pr-2 text-right">{formatCurrency(t.amount)}</td>
              <td className="py-1 text-right font-semibold">{formatCurrency(t.payout)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={3} className="py-1 pr-2 text-right text-muted-foreground">{totalLabel}</td>
            <td className="py-1 text-right">{formatCurrency(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
