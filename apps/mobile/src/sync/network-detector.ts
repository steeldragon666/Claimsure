import { useEffect, useState } from 'react';
import * as Network from 'expo-network';

/**
 * Polling-based online detector.
 *
 * expo-network doesn't expose an event stream — its `getNetworkStateAsync`
 * is a one-shot. Polling at 5s is a reasonable trade-off between
 * battery and responsiveness; the F16 indicator shows the result. When
 * the OS later signals connectivity changes via NetInfo we can swap
 * this to event-driven without touching callers.
 *
 * Returns true if connected AND reachable (isInternetReachable). On
 * iOS the latter is best-effort; "true" means "iOS thinks so", not
 * an active probe.
 */
export function useIsOnline(pollMs = 5000): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function check(): Promise<void> {
      try {
        const state = await Network.getNetworkStateAsync();
        if (cancelled) return;
        const reachable = state.isConnected === true && state.isInternetReachable !== false;
        setOnline(reachable);
      } catch {
        // Treat unknown state as offline — safer for the queue
        if (!cancelled) setOnline(false);
      }
      if (!cancelled) {
        timer = setTimeout(() => {
          void check();
        }, pollMs);
      }
    }

    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollMs]);

  return online;
}
