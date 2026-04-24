import { useGetAssumptions, getGetAssumptionsQueryKey } from "@workspace/api-client-react";

/**
 * Returns whether the Scenarios workspace is visible in the nav.
 *
 * Stored as the `sandbox_enabled` assumption (string "true" / "false").
 * Defaults to ON whenever the assumption is missing or assumptions are still
 * loading — we never want to flicker the link out from under the user.
 *
 * Spec §3I — Settings is the source of truth for nav visibility.
 */
export function useScenariosEnabled(): boolean {
  const { data: assumptions } = useGetAssumptions({
    query: { queryKey: getGetAssumptionsQueryKey() },
  });
  const flag = assumptions?.find((a) => a.key === "sandbox_enabled");
  return flag?.value !== "false";
}
