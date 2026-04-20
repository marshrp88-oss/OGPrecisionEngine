import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";

// Pages
import Dashboard from "@/pages/dashboard";
import Bills from "@/pages/bills";
import Commissions from "@/pages/commissions";
import Sandbox from "@/pages/sandbox";
import Wealth from "@/pages/wealth";
import Debt from "@/pages/debt";
import Retirement from "@/pages/retirement";
import Advisor from "@/pages/advisor";
import Settings from "@/pages/settings";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/bills" component={Bills} />
        <Route path="/commissions" component={Commissions} />
        <Route path="/sandbox" component={Sandbox} />
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
