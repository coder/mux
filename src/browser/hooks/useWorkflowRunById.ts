import { useContext, useEffect, useState } from "react";

import { APIContext } from "@/browser/contexts/API";
import { isActiveWorkflowRunStatus, type WorkflowRunRecord } from "@/common/types/workflow";

const WORKFLOW_RUN_REFRESH_INTERVAL_MS = 2_000;

export interface UseWorkflowRunByIdResult {
  run: WorkflowRunRecord | null;
  loading: boolean;
  error: string | null;
}

export function useWorkflowRunById(input: {
  workspaceId?: string;
  runId?: string;
  enabled?: boolean;
  pollWhileActive?: boolean;
}): UseWorkflowRunByIdResult {
  const apiState = useContext(APIContext);
  const [run, setRun] = useState<WorkflowRunRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = input.enabled !== false;
  const api = apiState?.api;
  const workspaceId = input.workspaceId;
  const runId = input.runId;

  useEffect(() => {
    if (!enabled || api == null || workspaceId == null || runId == null) {
      setLoading(false);
      setError(null);
      return;
    }

    let ignore = false;
    let interval: number | null = null;
    setLoading(true);

    const refresh = async () => {
      try {
        const nextRun = await api.workflows.getRun({ workspaceId, runId });
        if (ignore) {
          return;
        }
        setRun(nextRun);
        setError(null);
        setLoading(false);
        if (
          input.pollWhileActive === true &&
          nextRun != null &&
          !isActiveWorkflowRunStatus(nextRun.status) &&
          interval != null
        ) {
          window.clearInterval(interval);
          interval = null;
        }
      } catch (fetchError) {
        if (ignore) {
          return;
        }
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load workflow run");
        setLoading(false);
      }
    };

    void refresh();
    if (input.pollWhileActive === true) {
      interval = window.setInterval(() => {
        void refresh();
      }, WORKFLOW_RUN_REFRESH_INTERVAL_MS);
    }

    return () => {
      ignore = true;
      if (interval != null) {
        window.clearInterval(interval);
      }
    };
  }, [api, enabled, input.pollWhileActive, runId, workspaceId]);

  if (run != null && run.id !== runId) {
    return { run: null, loading, error };
  }

  return { run, loading, error };
}
