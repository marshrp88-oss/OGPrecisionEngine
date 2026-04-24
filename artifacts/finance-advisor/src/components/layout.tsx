import { Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Receipt,
  LineChart,
  TestTube,
  Landmark,
  LandPlot,
  PiggyBank,
  MessageSquare,
  Settings,
  ClipboardList,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

const navItems = [
  { href: "/", label: "Cycle Dashboard", icon: LayoutDashboard },
  { href: "/bills", label: "Bills Engine", icon: Receipt },
  { href: "/one-time", label: "One-Time Expenses", icon: ClipboardList },
  { href: "/commissions", label: "Commissions", icon: LineChart },
  { href: "/sandbox", label: "Decision Sandbox", icon: TestTube },
  { href: "/wealth", label: "Wealth", icon: Landmark },
  { href: "/debt", label: "Debt Strategy", icon: LandPlot },
  { href: "/retirement", label: "Retirement", icon: PiggyBank },
  { href: "/advisor", label: "AI Advisor", icon: MessageSquare },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavList({
  location,
  onSelect,
  variant,
}: {
  location: string;
  onSelect?: () => void;
  variant: "desktop" | "mobile";
}) {
  return (
    <ul className={cn("space-y-1", variant === "desktop" ? "px-2" : "px-1")}>
      {navItems.map((item) => {
        const isActive = location === item.href;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onSelect}
              className={cn(
                "flex items-center gap-3 rounded-md font-medium transition-colors",
                variant === "mobile"
                  ? "px-3 py-3 text-base min-h-[44px]"
                  : "px-3 py-2 text-sm",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent hover:text-accent-foreground text-muted-foreground",
              )}
              data-testid={`nav-${item.href.replace(/\//g, "") || "dashboard"}`}
            >
              <item.icon className={cn(variant === "mobile" ? "h-5 w-5 shrink-0" : "h-4 w-4 shrink-0")} />
              <span className="truncate">{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer whenever route changes (covers programmatic + link clicks)
  useEffect(() => {
    setMobileOpen(false);
  }, [location]);

  return (
    <div className="flex h-[100dvh] w-full bg-background overflow-hidden text-foreground">
      {/* Desktop Sidebar — unchanged behavior at md+ */}
      <div className="w-64 border-r border-border bg-card hidden md:flex flex-col h-full shrink-0">
        <div className="p-6 border-b border-border">
          <h1 className="text-xl font-bold tracking-tight">RESERVE</h1>
          <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-mono">
            Precision Financial Engine
          </p>
        </div>
        <nav className="flex-1 overflow-y-auto py-4">
          <NavList location={location} variant="desktop" />
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
        {/* Mobile Header with hamburger */}
        <header
          className="h-14 border-b border-border flex items-center gap-2 px-3 md:hidden bg-card shrink-0"
          style={{ paddingTop: "env(safe-area-inset-top)" }}
        >
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="Open navigation menu"
                className="inline-flex items-center justify-center h-11 w-11 rounded-md hover:bg-accent active:bg-accent text-foreground -ml-1"
                data-testid="button-mobile-nav-toggle"
              >
                <Menu className="h-6 w-6" />
              </button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-[78vw] max-w-xs p-0 flex flex-col bg-card"
            >
              <SheetHeader className="p-4 border-b border-border text-left">
                <SheetTitle className="text-lg font-bold tracking-tight">RESERVE</SheetTitle>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider font-mono">
                  Precision Financial Engine
                </p>
              </SheetHeader>
              <nav className="flex-1 overflow-y-auto py-3">
                <NavList location={location} variant="mobile" onSelect={() => setMobileOpen(false)} />
              </nav>
            </SheetContent>
          </Sheet>

          <h1 className="font-bold tracking-tight text-base">RESERVE</h1>
        </header>

        <main
          className="flex-1 overflow-y-auto bg-background p-4 md:p-8"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
