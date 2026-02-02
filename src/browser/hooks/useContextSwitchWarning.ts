/**
 * Hook for managing context switch warnings.
 *
 * Shows a warning when the user switches to a model that can't fit the current context.
 * Handles model changes, 1M toggle changes, and provides compact/dismiss actions.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { DisplayedMessage } from "@/common/types/message";
import type { WorkspaceUsageState } from "@/browser/stores/WorkspaceStore";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import {
  checkContextSwitch,
  findPreviousModel,
  type ContextSwitchOptions,
  type ContextSwitchWarning,
} from "@/browser/utils/compaction/contextSwitchCheck";
import { getHigherContextCompactionSuggestion } from "@/browser/utils/compaction/suggestion";
import { getEffectiveContextLimit } from "@/browser/utils/compaction/contextLimit";
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
  // Track token availability so dismissals don't immediately retrigger the warning.
  const prevTokensRef = useRef(0);
  // Track previous model so we can use it as compaction fallback on switch.
  // Initialize to null so first render triggers check (handles page reload after model switch).
  const prevPendingModelRef = useRef<string | null>(null);
  const { config: providersConfig } = useProvidersConfig();
  const policyState = usePolicy();
  const effectivePolicy =
    policyState.status.state === "enforced" ? (policyState.policy ?? null) : null;

  // Options for validating compaction model accessibility
  const checkOptions: ContextSwitchOptions = useMemo(
    () => ({ providersConfig, policy: effectivePolicy }),
    [providersConfig, effectivePolicy]
  );

  const prevCheckOptionsRef = useRef(checkOptions);
  const prevWarningPreviousModelRef = useRef<string | null>(null);
  const prevWorkspaceIdRef = useRef(workspaceId);

  // ChatPane stays mounted across workspace switches, so reset per-workspace state when
  // the workspace changes to avoid carrying the previous model into the next workspace.
  if (prevWorkspaceIdRef.current !== workspaceId) {
    prevWorkspaceIdRef.current = workspaceId;
    prevPendingModelRef.current = null;
    prevTokensRef.current = 0;
    prevUse1MRef.current = use1M;
    prevCheckOptionsRef.current = checkOptions;
    prevWarningPreviousModelRef.current = null;
    if (warning) {
      setWarning(null);
    }
  }

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
        policy: effectivePolicy,
      });

      if (suggestion) {
        const limit = getEffectiveContextLimit(suggestion.modelId, use1M);
        if (limit && limit > w.currentTokens) {
          return { ...w, compactionModel: suggestion.modelId, errorMessage: null };
        }
      }
      return w;
    },
    [providersConfig, effectivePolicy, use1M]
  );

  const handleModelChange = useCallback(
    (newModel: string) => {
      const tokens = getCurrentTokens();
      // Use the model user was just on (not last assistant message's model)
      // so compaction fallback works even if user switches without sending
      const previousModel = prevPendingModelRef.current;
      prevWarningPreviousModelRef.current = previousModel;
      prevPendingModelRef.current = newModel;
      const result =
        tokens > 0
          ? checkContextSwitch(tokens, newModel, previousModel, use1M, checkOptions)
          : null;
      setWarning(enhanceWarning(result));
    },
    [getCurrentTokens, use1M, checkOptions, enhanceWarning]
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
    const prevTokens = prevTokensRef.current;
    prevTokensRef.current = tokens;
    const prevModel = prevPendingModelRef.current;
    const prevCheckOptions = prevCheckOptionsRef.current;
    const checkOptionsChanged = prevCheckOptions !== checkOptions;
    prevCheckOptionsRef.current = checkOptions;

    if (prevModel !== pendingModel) {
      prevPendingModelRef.current = pendingModel;
      // On first render (prevModel is null), fall back to the most recent assistant model
      // so the warning can offer a compaction suggestion after reloads.
      const previousModel = prevModel ?? findPreviousModel(messages);
      prevWarningPreviousModelRef.current = previousModel;
      const result =
        tokens > 0
          ? checkContextSwitch(tokens, pendingModel, previousModel, use1M, checkOptions)
          : null;
      setWarning(enhanceWarning(result));
    } else if (prevTokens === 0 && tokens > 0 && !warning) {
      // Re-check if tokens became available after initial render (usage data loaded).
      // Gate on 0 -> >0 so a dismissal doesn't immediately recreate the warning.
      // Run the check even without a prior assistant model so late usage data still
      // triggers warnings for lower-context switches (fresh chats can lack model metadata).
      const previousModel = findPreviousModel(messages);
      prevWarningPreviousModelRef.current = previousModel;
      setWarning(
        enhanceWarning(checkContextSwitch(tokens, pendingModel, previousModel, use1M, checkOptions))
      );
    } else if (checkOptionsChanged && warning) {
      // Refresh existing warnings when policy/config arrives so compaction suggestions appear.
      // Only update active warnings to avoid resurrecting dismissed banners.
      const previousModel = prevWarningPreviousModelRef.current ?? findPreviousModel(messages);
      prevWarningPreviousModelRef.current = previousModel;
      const result =
        tokens > 0
          ? checkContextSwitch(tokens, pendingModel, previousModel, use1M, checkOptions)
          : null;
      setWarning(enhanceWarning(result));
    }
  }, [pendingModel, tokens, use1M, checkOptions, warning, messages, enhanceWarning]);

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
        const result = checkContextSwitch(
          tokens,
          pendingModel,
          findPreviousModel(messages),
          use1M,
          checkOptions
        );
        setWarning(enhanceWarning(result));
      } else if (use1M) {
        // No tokens but toggled ON - clear any stale warning
        setWarning(null);
      }
    }
  }, [use1M, getCurrentTokens, pendingModel, messages, checkOptions, enhanceWarning]);

  return { warning, handleModelChange, handleCompact, handleDismiss };
}
