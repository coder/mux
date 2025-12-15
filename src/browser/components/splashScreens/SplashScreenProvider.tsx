import React, { useState, useCallback, type ReactNode } from "react";
import { SPLASH_REGISTRY, type SplashConfig } from "./index";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getSplashDismissedKey } from "@/common/constants/storage";

export function SplashScreenProvider({ children }: { children: ReactNode }) {
  // Filter registry to undismissed splashes, sorted by priority (highest number first)
  const [queue, setQueue] = useState<SplashConfig[]>(() => {
    return SPLASH_REGISTRY.filter((splash) => {
      // Priority 0 = never show
      if (splash.priority === 0) return false;
      
      // Check if this splash has been dismissed
      const isDismissed = readPersistedState(getSplashDismissedKey(splash.id), false);
      return !isDismissed;
    }).sort((a, b) => b.priority - a.priority); // Higher number = higher priority = shown first
  });

  const currentSplash = queue[0] ?? null;

  const dismiss = useCallback(() => {
    if (!currentSplash) return;

    // Persist dismissal to localStorage
    updatePersistedState(getSplashDismissedKey(currentSplash.id), true);

    // Remove from queue, next one shows automatically
    setQueue((q) => q.slice(1));
  }, [currentSplash]);

  return (
    <>
      {children}
      {currentSplash && <currentSplash.component onDismiss={dismiss} />}
    </>
  );
}
