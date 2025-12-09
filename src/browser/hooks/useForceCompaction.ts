/**
 * Force compaction hook - manages automatic compaction when context limit is approached
 *
 * Triggers compaction when:
 * - shouldForceCompact is true (usage exceeds threshold + buffer)
 * - canInterrupt is true (there's an active stream to interrupt)
 * - isCompacting is false (not already compacting)
 * - Haven't already triggered force compaction this cycle
 *
 * The key invariant: force compaction triggers ONCE per threshold breach.
 * The guard only resets when shouldForceCompact becomes false (successful compaction reduced context).
 */

import { useEffect, useRef } from "react";

export interface ForceCompactionParams {
  shouldForceCompact: boolean;
  canInterrupt: boolean;
  isCompacting: boolean;
  onTrigger: () => void;
}

/**
 * Hook to manage force compaction triggering
 *
 * @returns Whether force compaction has been triggered (for testing/debugging)
 */
export function useForceCompaction(params: ForceCompactionParams): boolean {
  const { shouldForceCompact, canInterrupt, isCompacting, onTrigger } = params;

  // Track if we've already triggered force compaction (reset when usage drops)
  const forceCompactionTriggeredRef = useRef<boolean>(false);

  // Force compaction when live usage shows we're about to hit context limit
  useEffect(() => {
    if (
      !shouldForceCompact ||
      !canInterrupt ||
      isCompacting ||
      forceCompactionTriggeredRef.current
    ) {
      return;
    }

    forceCompactionTriggeredRef.current = true;
    onTrigger();
  }, [shouldForceCompact, canInterrupt, isCompacting, onTrigger]);

  // Reset force compaction trigger when usage drops below threshold (successful compaction)
  useEffect(() => {
    if (!shouldForceCompact) {
      forceCompactionTriggeredRef.current = false;
    }
  }, [shouldForceCompact]);

  return forceCompactionTriggeredRef.current;
}
