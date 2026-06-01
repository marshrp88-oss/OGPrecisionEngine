import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Receipt,
  LineChart,
  MessageSquare,
  MoreHorizontal,
  TestTube,
  Landmark,
  LandPlot,
  PiggyBank,
  ClipboardList,
  Scale,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useScenariosEnabled } from "@/hooks/use-scenarios-enabled";

// Spec §3G — exactly four primary tabs + MORE on mobile.
const PRIMARY = [
  { href: "/", label: "Overview", icon: LayoutDashboard, testid: "tab-overview" },
  { href: "/bills", label: "Bills", icon: Receipt, testid: "tab-bills" },
  { href: "/commissions", label: "Comms", icon: LineChart, testid: "tab-commissions" },
  { href: "/advisor", label: "Advisor", icon: MessageSquare, testid: "tab-advisor" },
] as const;

const MORE_ALL = [
  { href: "/one-time", label: "One-Time", icon: ClipboardList },
  { href: "/scenarios", label: "Scenarios", icon: TestTube },
  { href: "/wealth", label: "Wealth", icon: Landmark },
  { href: "/decisions", label: "Compare", icon: Scale },
  { href: "/debt", label: "Debt", icon: LandPlot },
  { href: "/retirement", label: "Retirement", icon: PiggyBank },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function MobileBottomNav() {
  const [location] = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const scenariosEnabled = useScenariosEnabled();

  const more = scenariosEnabled ? MORE_ALL : MORE_ALL.filter((m) => m.href !== "/scenarios");
  const moreActive = more.some((m) => m.href === location);

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border bg-card/95 backdrop-blur reserve-bottom-pad"
      aria-label="Primary navigation"
      data-testid="mobile-bottom-nav"
    >
      <ul className="grid grid-cols-5 px-1 pt-1">
        {PRIMARY.map((item) => {
          const isActive = location === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  "reserve-animate flex flex-col items-center justify-center gap-0.5 rounded-md py-2 text-xs",
                  isActive
                    ? "text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid={item.testid}
              >
                <item.icon className="h-5 w-5" />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
        <li>
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="More navigation"
                data-testid="tab-more"
                className={cn(
                  "reserve-animate flex w-full flex-col items-center justify-center gap-0.5 rounded-md py-2 text-xs",
                  moreActive
                    ? "text-primary font-semibold"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <MoreHorizontal className="h-5 w-5" />
                <span>More</span>
              </button>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-xl pb-8">
              <SheetHeader className="text-left mb-3">
                <SheetTitle>More</SheetTitle>
              </SheetHeader>
              <ul className="grid grid-cols-3 gap-2">
                {more.map((item) => {
                  const isActive = location === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setMoreOpen(false)}
                        className={cn(
                          "reserve-animate flex h-20 flex-col items-center justify-center gap-1 rounded-lg border text-xs",
                          isActive
                            ? "border-primary/60 bg-primary/10 text-primary font-semibold"
                            : "border-border hover:bg-accent text-foreground",
                        )}
                        data-testid={`more-${item.href.replace(/\//g, "") || "dashboard"}`}
                      >
                        <item.icon className="h-5 w-5" />
                        <span>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </SheetContent>
          </Sheet>
        </li>
      </ul>
    </nav>
  );
}
