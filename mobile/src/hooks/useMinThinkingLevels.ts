import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useORPC } from "../orpc/react";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { resolveMinimumThinkingLevel } from "@/common/utils/thinking/policy";
import type { ThinkingLevel } from "@/common/types/thinking";

/**
 * Reads the per-model minimum thinking floor from backend app config so mobile reflects
 * the same effective floor the backend enforces. Without this, a default-floored model
 * (e.g. gpt-5.5 → medium) would let mobile users pick Off/Low that the backend silently
 * clamps up to the floor, making the UI lie.
 *
 * Read-only and best-effort: if config is unavailable, the map is empty and
 * resolveMinimumThinkingLevel falls back to the built-in default floor.
 */
export function useMinThinkingLevels(): {
  getMinimum: (modelString: string) => ThinkingLevel;
} {
  const client = useORPC();
  const query = useQuery({
    queryKey: ["config", "minThinkingLevelByModel"],
    queryFn: async () => (await client.config.getConfig()).minThinkingLevelByModel ?? {},
    staleTime: 60_000,
  });

  const map = query.data ?? {};
  const getMinimum = useCallback(
    (modelString: string): ThinkingLevel =>
      resolveMinimumThinkingLevel(modelString, map[normalizeToCanonical(modelString)]),
    [map]
  );

  return { getMinimum };
}
