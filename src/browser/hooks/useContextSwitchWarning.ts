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
import { getHigherContextCompactionSuggestion } from "@/browser/utils/compaction/suggestion";
import { useProvidersConfig } from "./useProvidersConfig";
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
  // Track previous model so we can use it as compaction fallback on switch.
  // Initialize to null so first render triggers check (handles page reload after model switch).
  const prevPendingModelRef = useRef<string | null>(null);
  const { config: providersConfig } = useProvidersConfig();

  const getCurrentTokens = useCallback(() => {
    const usage = workspaceUsage?.liveUsage ?? workspaceUsage?.lastContextUsage;
    return usage ? usage.input.tokens + usage.cached.tokens + usage.cacheCreate.tokens : 0;
  }, [workspaceUsage]);

  // Enhance warning with smarter model suggestion when basic resolution fails.
  // Searches all known models for one with larger context that user can access.
  const enhanceWarning = useCallback(
    (w: ContextSwitchWarning | null): ContextSwitchWarning | null => {
      if (!w || w.compactionModel) return w;

      const suggestion = getHigherContextCompactionSuggestion({
        currentModel: w.targetModel,
        providersConfig,
      });

      if (suggestion) {
        return { ...w, compactionModel: suggestion.modelId, errorMessage: null };
      }
      return w;
    },
    [providersConfig]
  );

  const handleModelChange = useCallback(
    (newModel: string) => {
      const tokens = getCurrentTokens();
      // Use the model user was just on (not last assistant message's model)
      // so compaction fallback works even if user switches without sending
      const previousModel = prevPendingModelRef.current;
      prevPendingModelRef.current = newModel;
      const result = tokens > 0 ? checkContextSwitch(tokens, newModel, previousModel, use1M) : null;
      setWarning(enhanceWarning(result));
    },
    [getCurrentTokens, use1M, enhanceWarning]
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

  // Sync with indirect model changes (e.g., WorkspaceModeAISync updating model on mode/agent change).
  // Effect is appropriate: pendingModel comes from usePersistedState (localStorage), and external
  // components like WorkspaceModeAISync can update it without going through handleModelChange.
  // Also re-check when workspaceUsage changes (tokens may not be available on first render).
  const tokens = getCurrentTokens();
  useEffect(() => {
    const prevModel = prevPendingModelRef.current;
    if (prevModel !== pendingModel) {
      prevPendingModelRef.current = pendingModel;
      const result = tokens > 0 ? checkContextSwitch(tokens, pendingModel, prevModel, use1M) : null;
      setWarning(enhanceWarning(result));
    } else if (tokens > 0 && !warning) {
      // Re-check if tokens became available after initial render (usage data loaded)
      // Use findPreviousModel since we don't have a "previous" model in this case
      const previousModel = findPreviousModel(messages);
      if (previousModel && previousModel !== pendingModel) {
        setWarning(enhanceWarning(checkContextSwitch(tokens, pendingModel, previousModel, use1M)));
      }
    }
  }, [pendingModel, tokens, use1M, warning, messages, enhanceWarning]);

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
        const result = checkContextSwitch(tokens, pendingModel, findPreviousModel(messages), use1M);
        setWarning(enhanceWarning(result));
      } else if (use1M) {
        // No tokens but toggled ON - clear any stale warning
        setWarning(null);
      }
    }
  }, [use1M, getCurrentTokens, pendingModel, messages, enhanceWarning]);

  return { warning, handleModelChange, handleCompact, handleDismiss };
}
