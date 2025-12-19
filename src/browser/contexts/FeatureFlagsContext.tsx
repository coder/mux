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

export interface StatsTabState {
  enabled: boolean;
}

interface FeatureFlagsContextValue {
  statsTabState: StatsTabState | null;
  refreshStatsTabState: () => Promise<void>;
  setStatsTabEnabled: (enabled: boolean) => Promise<void>;
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
      return { enabled: true };
    }

    return null;
  });

  const refreshStatsTabState = async (): Promise<void> => {
    if (!api) {
      setStatsTabState({ enabled: false });
      return;
    }

    const state = await api.features.getStatsTabState();
    setStatsTabState({ enabled: state.enabled });
  };

  const setStatsTabEnabled = async (enabled: boolean): Promise<void> => {
    if (!api) {
      throw new Error("ORPC client not initialized");
    }

    const state = await api.features.setStatsTabOverride({ override: enabled ? "on" : "off" });
    setStatsTabState({ enabled: state.enabled });
  };

  useEffect(() => {
    if (isStorybook()) {
      return;
    }

    (async () => {
      try {
        if (!api) {
          setStatsTabState({ enabled: false });
          return;
        }

        const state = await api.features.getStatsTabState();
        setStatsTabState({ enabled: state.enabled });
      } catch {
        // Treat as disabled if we can't fetch.
        setStatsTabState({ enabled: false });
      }
    })();
  }, [api]);

  return (
    <FeatureFlagsContext.Provider
      value={{ statsTabState, refreshStatsTabState, setStatsTabEnabled }}
    >
      {props.children}
    </FeatureFlagsContext.Provider>
  );
}
