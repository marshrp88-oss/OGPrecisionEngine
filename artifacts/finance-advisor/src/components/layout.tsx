import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Receipt, 
  LineChart, 
  TestTube, 
  Landmark, 
  LandPlot,
  PiggyBank,
  MessageSquare,
  Settings
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Cycle Dashboard", icon: LayoutDashboard },
  { href: "/bills", label: "Bills Engine", icon: Receipt },
  { href: "/commissions", label: "Commissions", icon: LineChart },
  { href: "/sandbox", label: "Decision Sandbox", icon: TestTube },
  { href: "/wealth", label: "Wealth", icon: Landmark },
  { href: "/debt", label: "Debt Strategy", icon: LandPlot },
  { href: "/retirement", label: "Retirement", icon: PiggyBank },
  { href: "/advisor", label: "AI Advisor", icon: MessageSquare },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="flex h-screen w-full bg-background overflow-hidden text-foreground">
      {/* Sidebar */}
      <div className="w-64 border-r border-border bg-card hidden md:flex flex-col h-full">
        <div className="p-6 border-b border-border">
          <h1 className="text-xl font-bold tracking-tight">RESERVE</h1>
          <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider font-mono">Precision Financial Engine</p>
        </div>
        <nav className="flex-1 overflow-y-auto py-4">
          <ul className="space-y-1 px-2">
            {navItems.map((item) => {
              const isActive = location === item.href;
              return (
                <li key={item.href}>
                  <Link href={item.href} className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    isActive ? "bg-primary text-primary-foreground" : "hover:bg-accent hover:text-accent-foreground text-muted-foreground"
                  )}>
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Mobile Header */}
        <header className="h-14 border-b border-border flex items-center px-4 md:hidden bg-card shrink-0">
          <h1 className="font-bold tracking-tight">RESERVE</h1>
        </header>

        <main className="flex-1 overflow-y-auto bg-background p-4 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
