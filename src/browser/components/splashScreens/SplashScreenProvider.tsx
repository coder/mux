import React, { useState, useCallback, useEffect, type ReactNode } from "react";
import { SPLASH_REGISTRY, DISABLE_SPLASH_SCREENS, type SplashConfig } from "./index";
import { useAPI } from "@/browser/contexts/API";

export function SplashScreenProvider({ children }: { children: ReactNode }) {
  const { api } = useAPI();
  const [queue, setQueue] = useState<SplashConfig[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Load viewed splash screens from config on mount
  useEffect(() => {
    // Skip if disabled or API not ready
    if (DISABLE_SPLASH_SCREENS || !api) {
      setLoaded(true);
      return;
    }

    void (async () => {
      try {
        const viewedIds = await api.splashScreens.getViewedSplashScreens();

        // Filter registry to undismissed splashes, sorted by priority (highest number first)
        const activeQueue = SPLASH_REGISTRY.filter((splash) => {
          // Priority 0 = never show
          if (splash.priority === 0) return false;

          // Check if this splash has been viewed
          return !viewedIds.includes(splash.id);
        }).sort((a, b) => b.priority - a.priority); // Higher number = higher priority = shown first

        setQueue(activeQueue);
      } catch (error) {
        console.error("Failed to load viewed splash screens:", error);
        // On error, don't show any splash screens
        setQueue([]);
      } finally {
        setLoaded(true);
      }
    })();
  }, [api]);

  const currentSplash = queue[0] ?? null;

  const dismiss = useCallback(async () => {
    if (!currentSplash || !api) return;

    // Mark as viewed in config
    try {
      await api.splashScreens.markSplashScreenViewed({ splashId: currentSplash.id });
    } catch (error) {
      console.error("Failed to mark splash screen as viewed:", error);
    }

    // Remove from queue, next one shows automatically
    setQueue((q) => q.slice(1));
  }, [currentSplash, api]);

  // Don't render splash until we've loaded the viewed state
  if (!loaded) {
    return <>{children}</>;
  }

  return (
    <>
      {children}
      {currentSplash && <currentSplash.component onDismiss={() => void dismiss()} />}
    </>
  );
}
