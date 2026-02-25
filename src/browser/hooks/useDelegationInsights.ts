import { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import assert from "@/common/utils/assert";
import { DEFAULT_AUTO_COMPACTION_THRESHOLD } from "@/common/constants/ui";
import type { DelegationInsights } from "@/common/orpc/schemas/chatStats";

/**
 * Fetch delegation insights for a workspace. The endpoint is inexpensive and
 * only used by the costs sidebar, so we keep this hook intentionally simple.
 */
export function useDelegationInsights(
  workspaceId: string,
  use1MContext: boolean,
  model: string | null,
  autoCompactionThreshold: number
): DelegationInsights | null {
  assert(workspaceId.trim().length > 0, "useDelegationInsights: workspaceId must be non-empty");
  assert(
    typeof use1MContext === "boolean",
    "useDelegationInsights: use1MContext must be a boolean"
  );
  assert(
    model === null || typeof model === "string",
    "useDelegationInsights: model must be a string or null"
  );
  // Sanitize persisted threshold: clamp to valid range instead of throwing,
  // since this value comes from localStorage and can be corrupted.
  const safeThreshold =
    Number.isFinite(autoCompactionThreshold)
      ? Math.max(0, Math.min(1, autoCompactionThreshold))
      : DEFAULT_AUTO_COMPACTION_THRESHOLD;

  const { api } = useAPI();
  const [insights, setInsights] = useState<DelegationInsights | null>(null);
  // Request counter ensures only the latest fetch wins when deps change rapidly.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!api) {
      return;
    }

    const requestId = ++requestIdRef.current;

    // Clear immediately when switching workspaces so stale rows do not flash in the next tab.
    setInsights(null);

    api.workspace
      .getDelegationInsights({
        workspaceId,
        model,
        use1MContext,
        autoCompactionThreshold: safeThreshold,
      })
      .then((result) => {
        // Only apply if this is still the latest request.
        if (requestIdRef.current === requestId) {
          setInsights(result.hasData ? result : null);
        }
      })
      .catch(() => {
        // Delegation insights are optional UI data; keep the tab usable on failure.
      });
  }, [api, workspaceId, use1MContext, model, safeThreshold]);

  return insights;
}
