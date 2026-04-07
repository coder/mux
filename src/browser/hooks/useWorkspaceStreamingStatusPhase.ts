import { useEffect, useRef, useState, type MutableRefObject } from "react";

import { WORKSPACE_STREAMING_STATUS_TRANSITION_MS } from "@/constants/streaming";

export type WorkspaceStreamingStatusPhase = "starting" | "streaming";

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
export function useWorkspaceStreamingStatusPhase(phase: WorkspaceStreamingStatusPhase | null): {
  displayPhase: WorkspaceStreamingStatusPhase | null;
  shouldCollapsePhaseSlot: boolean;
} {
  const [heldPhaseSnapshot, setHeldPhaseSnapshot] = useState<WorkspaceStreamingStatusPhase | null>(
    phase
  );
  const heldPhaseSnapshotRef = useRef(heldPhaseSnapshot);
  const [isCollapsingPhaseSlot, setIsCollapsingPhaseSlot] = useState(false);
  const previousDisplayPhaseRef = useRef<WorkspaceStreamingStatusPhase | null>(phase);
  const hideTimerIdRef = useRef<number | null>(null);
  const collapseTimerIdRef = useRef<number | null>(null);

  const displayPhase = phase ?? heldPhaseSnapshot;
  const shouldCollapsePhaseSlot =
    phase !== null &&
    (isCollapsingPhaseSlot ||
      (previousDisplayPhaseRef.current === "starting" && displayPhase === "streaming"));

  useEffect(() => {
    heldPhaseSnapshotRef.current = heldPhaseSnapshot;
  }, [heldPhaseSnapshot]);

  useEffect(() => {
    previousDisplayPhaseRef.current = displayPhase;
  }, [displayPhase]);

  useEffect(() => {
    return () => {
      clearTimer(hideTimerIdRef);
      clearTimer(collapseTimerIdRef);
    };
  }, []);

  useEffect(() => {
    clearTimer(hideTimerIdRef);

    if (phase === null) {
      clearTimer(collapseTimerIdRef);
      setIsCollapsingPhaseSlot(false);

      if (heldPhaseSnapshotRef.current === null) {
        return;
      }

      hideTimerIdRef.current = window.setTimeout(() => {
        hideTimerIdRef.current = null;
        heldPhaseSnapshotRef.current = null;
        setHeldPhaseSnapshot(null);
      }, WORKSPACE_STREAMING_STATUS_TRANSITION_MS);
      return;
    }

    if (heldPhaseSnapshotRef.current !== phase) {
      heldPhaseSnapshotRef.current = phase;
      setHeldPhaseSnapshot(phase);
    }

    clearTimer(collapseTimerIdRef);
    const shouldCollapse = previousDisplayPhaseRef.current === "starting" && phase === "streaming";
    setIsCollapsingPhaseSlot(shouldCollapse);
    if (!shouldCollapse) {
      return;
    }

    collapseTimerIdRef.current = window.setTimeout(() => {
      collapseTimerIdRef.current = null;
      setIsCollapsingPhaseSlot(false);
    }, WORKSPACE_STREAMING_STATUS_TRANSITION_MS);
  }, [phase]);

  return {
    displayPhase,
    shouldCollapsePhaseSlot,
  };
}
