import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAPI } from "@/browser/contexts/API";

function isStorybook(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  // Storybook preview iframe is usually /iframe.html, but test-runner debug URLs
  // (and sometimes the manager itself) use ?path=/story/... .
  if (window.location.pathname.endsWith("iframe.html")) {
    return true;
  }

  const params = new URLSearchParams(window.location.search);
  const path = params.get("path");
  if (path?.startsWith("/story/")) {
    return true;
  }

  // Some configurations pass story identity via ?id=...
  if (params.has("id")) {
    return true;
  }

  return false;
}

export type StatsTabVariant = "control" | "stats";
export type StatsTabOverride = "default" | "on" | "off";

export interface StatsTabState {
  enabled: boolean;
  variant: StatsTabVariant;
  override: StatsTabOverride;
}

interface FeatureFlagsContextValue {
  statsTabState: StatsTabState | null;
  refreshStatsTabState: () => Promise<void>;
  setStatsTabOverride: (override: StatsTabOverride) => Promise<void>;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

export function useFeatureFlags(): FeatureFlagsContextValue {
  const ctx = useContext(FeatureFlagsContext);
  if (!ctx) throw new Error("useFeatureFlags must be used within FeatureFlagsProvider");
  return ctx;
}

export function FeatureFlagsProvider(props: { children: ReactNode }) {
  const { api } = useAPI();
  const [statsTabState, setStatsTabState] = useState<StatsTabState | null>(() => {
    if (isStorybook()) {
      return { enabled: true, variant: "stats", override: "default" };
    }

    return null;
  });

  const refreshStatsTabState = async (): Promise<void> => {
    if (!api) {
      setStatsTabState({ enabled: false, variant: "control", override: "default" });
      return;
    }

    const state = await api.features.getStatsTabState();
    setStatsTabState(state);
  };

  const setStatsTabOverride = async (override: StatsTabOverride): Promise<void> => {
    if (!api) {
      throw new Error("ORPC client not initialized");
    }

    const state = await api.features.setStatsTabOverride({ override });
    setStatsTabState(state);
  };

  useEffect(() => {
    if (isStorybook()) {
      return;
    }

    (async () => {
      try {
        if (!api) {
          setStatsTabState({ enabled: false, variant: "control", override: "default" });
          return;
        }

        const state = await api.features.getStatsTabState();
        setStatsTabState(state);
      } catch {
        // Treat as disabled if we can't fetch.
        setStatsTabState({ enabled: false, variant: "control", override: "default" });
      }
    })();
  }, [api]);

  return (
    <FeatureFlagsContext.Provider
      value={{ statsTabState, refreshStatsTabState, setStatsTabOverride }}
    >
      {props.children}
    </FeatureFlagsContext.Provider>
  );
}
