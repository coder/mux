import { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import assert from "@/common/utils/assert";
import type { DelegationInsights } from "@/common/orpc/schemas/chatStats";

/**
 * Fetch delegation insights for a workspace. The endpoint is inexpensive and
 * only used by the costs sidebar, so we keep this hook intentionally simple.
 */
export function useDelegationInsights(workspaceId: string): DelegationInsights | null {
  assert(workspaceId.trim().length > 0, "useDelegationInsights: workspaceId must be non-empty");

  const { api } = useAPI();
  const [insights, setInsights] = useState<DelegationInsights | null>(null);

  // Keep state aligned with the active workspace immediately.
  const previousWorkspaceIdRef = useRef(workspaceId);
  if (previousWorkspaceIdRef.current !== workspaceId) {
    previousWorkspaceIdRef.current = workspaceId;
    setInsights(null);
  }

  useEffect(() => {
    if (!api) {
      return;
    }

    let cancelled = false;

    const fetchInsights = async () => {
      try {
        const result = await api.workspace.getDelegationInsights({ workspaceId });
        if (!cancelled) {
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
  }, [api, workspaceId]);

  return insights;
}
