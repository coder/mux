import { useEffect, useRef, useState, type MutableRefObject } from "react";

import { WORKSPACE_STREAMING_STATUS_TRANSITION_MS } from "@/constants/streaming";

export type WorkspaceStreamingStatusPhase = "starting" | "streaming";
export type WorkspaceStreamingStatusPhaseSource = "streaming" | "pre-stream" | "provisioning";

interface WorkspaceStreamingStatusPhaseOptions {
  canInterrupt: boolean;
  isStarting: boolean;
  isCreating?: boolean;
}

export function getWorkspaceStreamingStatusPhase(
  options: WorkspaceStreamingStatusPhaseOptions
): WorkspaceStreamingStatusPhase | null {
  return options.canInterrupt
    ? "streaming"
    : options.isStarting || options.isCreating === true
      ? "starting"
      : null;
}

function clearTimer(timerIdRef: MutableRefObject<number | null>): void {
  if (timerIdRef.current === null) {
    return;
  }

  window.clearTimeout(timerIdRef.current);
  timerIdRef.current = null;
}

/**
 * Keep the sidebar's streaming label mounted across brief state handoffs so the row
 * does not blink out when startup and active-stream flags settle on adjacent renders.
 */
export function useWorkspaceStreamingStatusPhase(
  phase: WorkspaceStreamingStatusPhase | null,
  phaseSource: WorkspaceStreamingStatusPhaseSource | null = null
): {
  displayPhase: WorkspaceStreamingStatusPhase | null;
  displayPhaseSource: WorkspaceStreamingStatusPhaseSource | null;
} {
  const [heldPhaseSnapshot, setHeldPhaseSnapshot] = useState<WorkspaceStreamingStatusPhase | null>(
    phase
  );
  const [heldPhaseSourceSnapshot, setHeldPhaseSourceSnapshot] =
    useState<WorkspaceStreamingStatusPhaseSource | null>(phaseSource);
  const heldPhaseSnapshotRef = useRef(heldPhaseSnapshot);
  const heldPhaseSourceSnapshotRef = useRef(heldPhaseSourceSnapshot);
  const hideTimerIdRef = useRef<number | null>(null);

  const displayPhase = phase ?? heldPhaseSnapshot;
  const displayPhaseSource = phase !== null ? phaseSource : heldPhaseSourceSnapshot;

  useEffect(() => {
    heldPhaseSnapshotRef.current = heldPhaseSnapshot;
  }, [heldPhaseSnapshot]);

  useEffect(() => {
    heldPhaseSourceSnapshotRef.current = heldPhaseSourceSnapshot;
  }, [heldPhaseSourceSnapshot]);

  useEffect(() => {
    return () => {
      clearTimer(hideTimerIdRef);
    };
  }, []);

  useEffect(() => {
    clearTimer(hideTimerIdRef);

    if (phase === null) {
      if (heldPhaseSnapshotRef.current === null) {
        return;
      }

      hideTimerIdRef.current = window.setTimeout(() => {
        hideTimerIdRef.current = null;
        heldPhaseSnapshotRef.current = null;
        heldPhaseSourceSnapshotRef.current = null;
        setHeldPhaseSnapshot(null);
        setHeldPhaseSourceSnapshot(null);
      }, WORKSPACE_STREAMING_STATUS_TRANSITION_MS);
      return;
    }

    if (heldPhaseSnapshotRef.current !== phase) {
      heldPhaseSnapshotRef.current = phase;
      setHeldPhaseSnapshot(phase);
    }
    if (heldPhaseSourceSnapshotRef.current !== phaseSource) {
      heldPhaseSourceSnapshotRef.current = phaseSource;
      setHeldPhaseSourceSnapshot(phaseSource);
    }
  }, [phase, phaseSource]);

  return {
    displayPhase,
    displayPhaseSource,
  };
}
