import { useState, useEffect } from "react";
import { useAPI } from "@/browser/contexts/API";
import type { ModeDefinition } from "@/common/types/mode";

interface UseModesResult {
  modes: ModeDefinition[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Hook to fetch available modes for a workspace.
 * Returns built-in modes as fallback while loading or on error.
 */
export function useModes(workspaceId: string | undefined): UseModesResult {
  const { api } = useAPI();
  const [modes, setModes] = useState<ModeDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    // Guard against missing API, workspaceId, or modes endpoint (e.g., in Storybook)
    if (!api || !workspaceId || !api.modes?.list) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    api.modes
      .list({ workspaceId })
      .then((result) => {
        if (!cancelled) {
          setModes(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load modes");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  return { modes, loading, error, refresh };
}

/**
 * Get a mode definition by name from the loaded modes.
 */
export function useMode(
  workspaceId: string | undefined,
  modeName: string
): ModeDefinition | undefined {
  const { modes } = useModes(workspaceId);
  return modes.find((m) => m.name === modeName);
}
