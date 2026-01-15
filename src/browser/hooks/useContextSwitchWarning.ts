/**
 * Hook for managing context switch warnings.
 *
 * Shows a warning when the user switches to a model that can't fit the current context.
 * Handles model changes, 1M toggle changes, and provides compact/dismiss actions.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import type { WorkspaceUsageState } from "@/browser/stores/WorkspaceStore";
import {
  checkContextSwitch,
  findPreviousModel,
  type ContextSwitchWarning,
} from "@/browser/utils/compaction/contextSwitchCheck";

// Note: findPreviousModel is still used for 1M toggle changes (effect below)
import { executeCompaction } from "@/browser/utils/chatCommands";

interface UseContextSwitchWarningProps {
  workspaceId: string;
  messages: DisplayedMessage[];
  pendingModel: string;
  use1M: boolean;
  workspaceUsage: WorkspaceUsageState | undefined;
  api: RouterClient<AppRouter> | undefined;
  pendingSendOptions: SendMessageOptions;
}

interface UseContextSwitchWarningResult {
  warning: ContextSwitchWarning | null;
  handleModelChange: (newModel: string) => void;
  handleCompact: () => void;
  handleDismiss: () => void;
}

export function useContextSwitchWarning(
  props: UseContextSwitchWarningProps
): UseContextSwitchWarningResult {
  const { workspaceId, messages, pendingModel, use1M, workspaceUsage, api, pendingSendOptions } =
    props;

  const [warning, setWarning] = useState<ContextSwitchWarning | null>(null);
  const prevUse1MRef = useRef(use1M);
  // Track previous model so we can use it as compaction fallback on switch
  const prevPendingModelRef = useRef(pendingModel);

  const getCurrentTokens = useCallback(() => {
    const usage = workspaceUsage?.liveUsage ?? workspaceUsage?.lastContextUsage;
    return usage ? usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens : 0;
  }, [workspaceUsage]);

  const handleModelChange = useCallback(
    (newModel: string) => {
      const tokens = getCurrentTokens();
      // Use the model user was just on (not last assistant message's model)
      // so compaction fallback works even if user switches without sending
      const previousModel = prevPendingModelRef.current;
      prevPendingModelRef.current = newModel;
      setWarning(tokens > 0 ? checkContextSwitch(tokens, newModel, previousModel, use1M) : null);
    },
    [getCurrentTokens, use1M]
  );

  const handleCompact = useCallback(() => {
    if (!api || !warning?.compactionModel) return;

    void executeCompaction({
      api,
      workspaceId,
      model: warning.compactionModel,
      sendMessageOptions: pendingSendOptions,
    });
    setWarning(null);
  }, [api, workspaceId, pendingSendOptions, warning]);

  const handleDismiss = useCallback(() => {
    setWarning(null);
  }, []);

  // Sync with 1M toggle changes from ProviderOptionsContext.
  // Effect is appropriate here: we're syncing with an external context (not our own state),
  // and the toggle change happens in ModelSettings which can't directly call our handlers.
  useEffect(() => {
    const wasEnabled = prevUse1MRef.current;
    prevUse1MRef.current = use1M;

    // Recompute warning when toggle changes (either direction)
    // OFF → ON: may clear warning if context now fits
    // ON → OFF: may show warning if context no longer fits
    if (wasEnabled !== use1M) {
      const tokens = getCurrentTokens();
      if (tokens > 0) {
        setWarning(checkContextSwitch(tokens, pendingModel, findPreviousModel(messages), use1M));
      } else if (use1M) {
        // No tokens but toggled ON - clear any stale warning
        setWarning(null);
      }
    }
  }, [use1M, getCurrentTokens, pendingModel, messages]);

  return { warning, handleModelChange, handleCompact, handleDismiss };
}
