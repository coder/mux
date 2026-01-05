import { createContext, useContext, useState, useEffect } from "react";
import { useAPI } from "./API";

interface TelemetryEnabledContextValue {
  /**
   * Whether link sharing should be enabled.
   * True unless user explicitly set MUX_DISABLE_TELEMETRY=1.
   * Null while loading.
   */
  linkSharingEnabled: boolean | null;
}

const TelemetryEnabledContext = createContext<TelemetryEnabledContextValue | null>(null);

interface TelemetryEnabledProviderProps {
  children: React.ReactNode;
}

/**
 * Provider that queries the backend once to determine if telemetry is enabled.
 * This is used to conditionally hide features that require network access to mux services.
 */
export function TelemetryEnabledProvider({ children }: TelemetryEnabledProviderProps) {
  const { api } = useAPI();
  const [linkSharingEnabled, setLinkSharingEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!api) return;

    let cancelled = false;
    void api.telemetry
      .status()
      .then((result) => {
        if (!cancelled) {
          // Link sharing is enabled unless user explicitly disabled telemetry
          setLinkSharingEnabled(!result.explicit);
        }
      })
      .catch((err) => {
        console.error("[TelemetryEnabledContext] Failed to check telemetry status:", err);
        // Default to enabled on error so share button still shows
        if (!cancelled) {
          setLinkSharingEnabled(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <TelemetryEnabledContext.Provider value={{ linkSharingEnabled }}>
      {children}
    </TelemetryEnabledContext.Provider>
  );
}

/**
 * Hook to check if link sharing is enabled.
 * Returns null while loading, then true/false once known.
 * Link sharing is disabled only when user explicitly sets MUX_DISABLE_TELEMETRY=1.
 */
export function useLinkSharingEnabled(): boolean | null {
  const context = useContext(TelemetryEnabledContext);
  if (!context) {
    throw new Error("useLinkSharingEnabled must be used within a TelemetryEnabledProvider");
  }
  return context.linkSharingEnabled;
}
