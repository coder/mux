import { useEffect, useState } from "react";

/**
 * A small helper for live-updating time displays.
 *
 * When enabled, updates once per second (by default). When disabled, stops the interval.
 */
export function useLiveTimer(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }

    // Snap immediately when enabling so the UI doesn't wait up to intervalMs.
    setNow(Date.now());

    const interval = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => clearInterval(interval);
  }, [enabled, intervalMs]);

  return now;
}
