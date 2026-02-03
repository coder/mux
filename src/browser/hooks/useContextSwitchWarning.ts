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
  // Track previous model so we can use it as compaction fallback on switch.
  // Initialize to null so first render triggers check (handles page reload after model switch).
  const prevPendingModelRef = useRef<string | null>(null);
  // Track user-initiated model switches so workspace entry/sync doesn't show warnings.
  const pendingUserSwitchRef = useRef<{ model: string; previousModel: string | null } | null>(null);
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

  // ChatPane is keyed by workspaceId today; keep a defensive reset to avoid stale warnings
  // if mount behavior changes or localStorage sync reuses this hook instance.
  if (prevWorkspaceIdRef.current !== workspaceId) {
    prevWorkspaceIdRef.current = workspaceId;
    prevPendingModelRef.current = null;
    pendingUserSwitchRef.current = null;
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

  const handleModelChange = useCallback((newModel: string) => {
    // Use the model user was just on (not last assistant message's model)
    // so compaction fallback works even if user switches without sending.
    const previousModel = prevPendingModelRef.current;
    // User request: only show warnings for explicit model switches, not workspace entry/sync.
    pendingUserSwitchRef.current = { model: newModel, previousModel };
    prevWarningPreviousModelRef.current = previousModel;
    prevPendingModelRef.current = newModel;
  }, []);

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
  // Effect is appropriate: pendingModel comes from usePersistedState (localStorage).
  // Only user-initiated switches should surface warnings; sync just updates refs.
  const tokens = getCurrentTokens();
  useEffect(() => {
    const prevModel = prevPendingModelRef.current;
    const prevCheckOptions = prevCheckOptionsRef.current;
    const checkOptionsChanged = prevCheckOptions !== checkOptions;
    prevCheckOptionsRef.current = checkOptions;

    const pendingUserSwitch = pendingUserSwitchRef.current;
    const shouldHandleUserSwitch = pendingUserSwitch?.model === pendingModel;

    if (shouldHandleUserSwitch) {
      const previousModel = pendingUserSwitch?.previousModel ?? findPreviousModel(messages);
      prevWarningPreviousModelRef.current = previousModel;

      if (previousModel && previousModel === pendingModel) {
        pendingUserSwitchRef.current = null;
        return;
      }

      if (tokens === 0) {
        if (warning) {
          // Clear stale warnings when a user switch happens before usage loads.
          setWarning(null);
        }
        return;
      }

      const result = checkContextSwitch(tokens, pendingModel, previousModel, use1M, checkOptions);
      setWarning(enhanceWarning(result));
      pendingUserSwitchRef.current = null;
      return;
    }

    if (prevModel !== pendingModel) {
      prevPendingModelRef.current = pendingModel;
      if (warning) {
        setWarning(null);
      }
    } else if (checkOptionsChanged && warning) {
      // Refresh existing warnings when policy/config arrives so compaction suggestions appear.
      // Only update active warnings to avoid resurrecting dismissed banners.
      // Preserve same-model warnings (like 1M toggle) when refreshing for policy/config updates.
      const previousModel = prevWarningPreviousModelRef.current ?? findPreviousModel(messages);
      prevWarningPreviousModelRef.current = previousModel;
      const result =
        tokens > 0
          ? checkContextSwitch(tokens, pendingModel, previousModel, use1M, checkOptions, {
              allowSameModel: true,
            })
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
      const previousLimit = getEffectiveContextLimit(pendingModel, wasEnabled);
      const nextLimit = getEffectiveContextLimit(pendingModel, use1M);

      // Only surface same-model warnings if the effective limit actually changed.
      if (previousLimit === nextLimit) {
        if (use1M && tokens === 0) {
          // No tokens but toggled ON - clear any stale warning
          setWarning(null);
        }
        return;
      }

      if (tokens > 0) {
        const previousModel = findPreviousModel(messages);
        const result = checkContextSwitch(
          tokens,
          pendingModel,
          previousModel,
          use1M,
          checkOptions,
          { allowSameModel: true }
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
