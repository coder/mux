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
  model: string | null
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

  const { api } = useAPI();
  const [insights, setInsights] = useState<DelegationInsights | null>(null);
  const latestWorkspaceIdRef = useRef(workspaceId);
  latestWorkspaceIdRef.current = workspaceId;

  // Include `model` in the request so rapid model switches use the live UI selection,
  // not potentially stale persisted workspace metadata.
  useEffect(() => {
    if (!api) {
      return;
    }

    let cancelled = false;
    const requestedWorkspaceId = workspaceId;

    // Clear immediately when switching workspaces so stale rows do not flash in the next tab.
    setInsights(null);

    const fetchInsights = async () => {
      try {
        const result = await api.workspace.getDelegationInsights({
          workspaceId: requestedWorkspaceId,
          model,
          use1MContext,
        });
        if (!cancelled && latestWorkspaceIdRef.current === requestedWorkspaceId) {
          setInsights(result);
        }
      } catch {
        // Delegation insights are optional UI data; keep the tab usable on failure.
      }
    };

    void fetchInsights();

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, use1MContext, model]);

  return insights;
}
