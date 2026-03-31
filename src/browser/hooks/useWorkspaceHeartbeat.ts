import { useCallback, useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from "@/constants/heartbeat";

type WorkspaceHeartbeatSettings = NonNullable<FrontendWorkspaceMetadata["heartbeat"]>;

interface UseWorkspaceHeartbeatParams {
  workspaceId: string | null;
}

export interface UseWorkspaceHeartbeatResult {
  heartbeat: WorkspaceHeartbeatSettings | null;
  setHeartbeat: (heartbeat: WorkspaceHeartbeatSettings | null) => void;
}

export function useWorkspaceHeartbeat(
  params: UseWorkspaceHeartbeatParams
): UseWorkspaceHeartbeatResult {
  const { workspaceId } = params;
  const { api } = useAPI();
  const [heartbeat, setHeartbeatState] = useState<WorkspaceHeartbeatSettings | null>(null);

  // Guards for out-of-order async responses (e.g., rapid toggles or workspace switches).
  const currentWorkspaceIdRef = useRef<string | null>(workspaceId);
  currentWorkspaceIdRef.current = workspaceId;
  const latestSaveRequestIdRef = useRef(0);

  useEffect(() => {
    if (!workspaceId || !api) {
      setHeartbeatState(null);
      return;
    }

    let cancelled = false;
    void api.workspace.heartbeat
      .get({ workspaceId })
      .then((result) => {
        if (!cancelled) {
          setHeartbeatState(result);
        }
      })
      .catch(() => {
        // Ignore load errors; leaving state unchanged avoids clobbering newer values when
        // switching workspaces quickly.
      });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId]);

  const setHeartbeat = useCallback(
    (newHeartbeat: WorkspaceHeartbeatSettings | null) => {
      if (!workspaceId || !api) {
        return;
      }

      const requestId = ++latestSaveRequestIdRef.current;
      const previousHeartbeat = heartbeat;
      const workspaceIdAtCall = workspaceId;
      const normalizedHeartbeat = newHeartbeat ?? {
        enabled: false,
        intervalMs: previousHeartbeat?.intervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS,
      };

      setHeartbeatState(normalizedHeartbeat);

      void api.workspace.heartbeat
        .set({
          workspaceId: workspaceIdAtCall,
          ...normalizedHeartbeat,
        })
        .then((result) => {
          if (!result.success) {
            throw new Error(result.error ?? "Failed to set workspace heartbeat settings");
          }
        })
        .catch(() => {
          if (latestSaveRequestIdRef.current !== requestId) return;
          if (currentWorkspaceIdRef.current !== workspaceIdAtCall) return;
          setHeartbeatState(previousHeartbeat);
        });
    },
    [api, heartbeat, workspaceId]
  );

  return { heartbeat, setHeartbeat };
}
