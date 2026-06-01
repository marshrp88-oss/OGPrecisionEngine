import { useSyncExternalStore, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  isDemoEnabled,
  setDemoEnabled,
  installDemoFetch,
  uninstallDemoFetch,
} from "@/lib/demo/demo-mode";

const EVENT = "demo-mode-changed";

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/**
 * Reads/toggles the frontend-only demoMode flag. Flipping it installs or
 * removes the window.fetch interceptor and clears the React Query cache so the
 * app re-pulls fresh data from whichever world (demo vs live) is now active.
 *
 * Independent of `sandbox_enabled` (the Scenarios nav toggle) by design.
 */
export function useDemoMode(): { enabled: boolean; setEnabled: (on: boolean) => void } {
  const queryClient = useQueryClient();
  const enabled = useSyncExternalStore(subscribe, isDemoEnabled, () => false);

  const setEnabled = useCallback(
    (on: boolean) => {
      setDemoEnabled(on);
      if (on) installDemoFetch(queryClient);
      else uninstallDemoFetch();
      // Drop every cached query so the UI re-fetches against the new world.
      queryClient.clear();
      window.dispatchEvent(new Event(EVENT));
    },
    [queryClient],
  );

  return { enabled, setEnabled };
}
