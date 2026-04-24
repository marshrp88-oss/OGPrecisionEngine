import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { useScenariosEnabled } from "@/hooks/use-scenarios-enabled";

// Pages
import Dashboard from "@/pages/dashboard";
import Bills from "@/pages/bills";
import Commissions from "@/pages/commissions";
import Scenarios from "@/pages/scenarios";
import Wealth from "@/pages/wealth";
import Debt from "@/pages/debt";
import OneTimeExpenses from "@/pages/one-time";
import Retirement from "@/pages/retirement";
import Advisor from "@/pages/advisor";
import Settings from "@/pages/settings";

const queryClient = new QueryClient();

/**
 * Route guard for the Scenarios workspace.
 *
 * When the user disables Scenarios visibility in Settings (sandbox_enabled =
 * "false"), we hide the nav link AND redirect any direct navigation to /
 * scenarios or /sandbox back to the dashboard. The hook defaults ON during
 * load, so this never flickers a redirect on cold start.
 */
function ScenariosRoute() {
  const enabled = useScenariosEnabled();
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (!enabled) setLocation("/", { replace: true });
  }, [enabled, setLocation]);
  if (!enabled) return null;
  return <Scenarios />;
}

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/bills" component={Bills} />
        <Route path="/one-time" component={OneTimeExpenses} />
        <Route path="/commissions" component={Commissions} />
        <Route path="/scenarios" component={ScenariosRoute} />
        {/* Backward-compat alias for the old /sandbox route */}
        <Route path="/sandbox" component={ScenariosRoute} />
        <Route path="/wealth" component={Wealth} />
        <Route path="/debt" component={Debt} />
        <Route path="/retirement" component={Retirement} />
        <Route path="/advisor" component={Advisor} />
        <Route path="/settings" component={Settings} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
