import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import {
  useGetPlaidStatus,
  getGetPlaidStatusQueryKey,
  useCreatePlaidLinkToken,
  useExchangePlaidPublicToken,
  useGetPlaidItems,
  getGetPlaidItemsQueryKey,
  useDeletePlaidItem,
  useRefreshPlaidBalances,
  getGetBalancesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Banknote, Trash2, RefreshCw, Link as LinkIcon } from "lucide-react";
import { formatDate } from "@/lib/utils";

export function BankConnections() {
  const { data: status, isLoading: statusLoading } = useGetPlaidStatus({
    query: { queryKey: getGetPlaidStatusQueryKey() },
  });
  const { data: items, isLoading: itemsLoading } = useGetPlaidItems({
    query: { queryKey: getGetPlaidItemsQueryKey(), enabled: status?.configured === true },
  });
  const createLinkToken = useCreatePlaidLinkToken();
  const exchangeToken = useExchangePlaidPublicToken();
  const deleteItem = useDeletePlaidItem();
  const refresh = useRefreshPlaidBalances();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [linkToken, setLinkToken] = useState<string | null>(null);

  const onSuccess = useCallback(
    (publicToken: string) => {
      exchangeToken.mutate(
        { data: { publicToken } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetPlaidItemsQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetBalancesQueryKey() });
            toast({ title: "Bank connected", description: "Balances are syncing now." });
            setLinkToken(null);
          },
          onError: (err: unknown) => {
            const msg = err instanceof Error ? err.message : "Failed to link bank";
            toast({ title: "Link failed", description: msg, variant: "destructive" });
          },
        },
      );
    },
    [exchangeToken, queryClient, toast],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => setLinkToken(null),
  });

  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  const handleConnect = () => {
    createLinkToken.mutate(
      undefined,
      {
        onSuccess: (resp) => setLinkToken(resp.linkToken),
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : "Could not start Plaid";
          toast({ title: "Plaid error", description: msg, variant: "destructive" });
        },
      },
    );
  };

  const handleRefresh = () => {
    refresh.mutate(
      undefined,
      {
        onSuccess: (resp) => {
          queryClient.invalidateQueries({ queryKey: getGetPlaidItemsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetBalancesQueryKey() });
          toast({
            title: "Balances refreshed",
            description: `${resp.ok} item(s) updated${resp.failed > 0 ? `, ${resp.failed} failed` : ""}`,
          });
        },
        onError: () =>
          toast({ title: "Refresh failed", variant: "destructive" }),
      },
    );
  };

  const handleDisconnect = (id: number, name: string | null) => {
    if (!confirm(`Disconnect ${name ?? "this institution"}? Stored balances are kept.`)) return;
    deleteItem.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPlaidItemsQueryKey() });
          toast({ title: "Disconnected" });
        },
      },
    );
  };

  if (statusLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  return (
    <Card data-testid="settings-group-bank">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Banknote className="h-5 w-5" />
          Connected Banks
        </CardTitle>
        <CardDescription>
          Link your bank via Plaid so checking and HYSA balances refresh automatically. Balances
          sync once nightly and on demand — your stale-data warning will stop firing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status?.configured && (
          <div className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
            <p className="font-semibold text-amber-900 dark:text-amber-200">Plaid is not configured</p>
            <p className="text-amber-800 dark:text-amber-300 mt-1">
              Add <code className="font-mono">PLAID_CLIENT_ID</code> and{" "}
              <code className="font-mono">PLAID_SECRET</code> secrets (free Plaid sandbox keys work)
              and restart the API server to enable bank linking.
            </p>
          </div>
        )}

        {status?.configured && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={handleConnect}
              disabled={createLinkToken.isPending || exchangeToken.isPending}
              data-testid="button-plaid-connect"
            >
              <LinkIcon className="mr-2 h-4 w-4" />
              {items && items.length > 0 ? "Connect another bank" : "Connect bank"}
            </Button>
            {items && items.length > 0 && (
              <Button
                variant="outline"
                onClick={handleRefresh}
                disabled={refresh.isPending}
                data-testid="button-plaid-refresh"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`} />
                Refresh now
              </Button>
            )}
            <Badge variant="outline" className="ml-auto font-mono text-[10px]">
              env: {status.env}
            </Badge>
          </div>
        )}

        {itemsLoading && status?.configured && <Skeleton className="h-20 w-full" />}

        {items && items.length > 0 && (
          <div className="space-y-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="rounded-md border p-3 space-y-2"
                data-testid={`row-plaid-item-${item.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm">
                      {item.institutionName ?? "Linked institution"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.lastSyncedAt
                        ? `Last synced ${formatDate(item.lastSyncedAt)}`
                        : "Not yet synced"}
                    </p>
                    {item.lastSyncError && (
                      <p className="text-xs text-destructive mt-1">{item.lastSyncError}</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDisconnect(item.id, item.institutionName ?? null)}
                    aria-label="Disconnect"
                    data-testid={`button-disconnect-plaid-${item.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {item.accounts.length > 0 && (
                  <ul className="text-xs text-muted-foreground space-y-0.5 pl-2 border-l">
                    {item.accounts.map((a) => (
                      <li key={a.accountId} className="font-mono">
                        {a.name}
                        {a.mask ? ` ••${a.mask}` : ""}
                        {a.mappedAccountType ? (
                          <Badge variant="secondary" className="ml-2 text-[10px]">
                            {a.mappedAccountType}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            unmapped
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        {status?.configured && items && items.length === 0 && !itemsLoading && (
          <p className="text-sm text-muted-foreground">No banks linked yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
