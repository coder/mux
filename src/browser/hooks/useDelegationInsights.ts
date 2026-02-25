import { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import assert from "@/common/utils/assert";
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
  assert(
    Number.isFinite(autoCompactionThreshold) &&
      autoCompactionThreshold >= 0 &&
      autoCompactionThreshold <= 1,
    "useDelegationInsights: autoCompactionThreshold must be between 0 and 1"
  );

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
        autoCompactionThreshold,
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
  }, [api, workspaceId, use1MContext, model, autoCompactionThreshold]);

  return insights;
}
