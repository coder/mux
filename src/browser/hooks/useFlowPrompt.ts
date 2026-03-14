import { useCallback, useState } from "react";
import type { RuntimeConfig } from "@/common/types/runtime";
import { useAPI } from "@/browser/contexts/API";
import { useConfirmDialog } from "@/browser/contexts/ConfirmDialogContext";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { useFlowPromptState } from "@/browser/stores/FlowPromptStore";
import {
  getFlowPromptRelativePath,
  type FlowPromptAutoSendMode,
} from "@/common/constants/flowPrompting";

export function useFlowPrompt(
  workspaceId: string,
  workspaceName: string,
  runtimeConfig?: RuntimeConfig
) {
  const { api } = useAPI();
  const { confirm } = useConfirmDialog();
  const openInEditor = useOpenInEditor();
  const state = useFlowPromptState(workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [isUpdatingAutoSendMode, setIsUpdatingAutoSendMode] = useState(false);
  const [isSendingNow, setIsSendingNow] = useState(false);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const openFlowPrompt = useCallback(async () => {
    if (!state?.path) {
      setError("Flow prompt path is not available yet.");
      return;
    }

    const result = await openInEditor(workspaceId, state.path, runtimeConfig, { isFile: true });
    if (!result.success) {
      setError(result.error ?? "Failed to open flow prompt");
      return;
    }

    setError(null);
  }, [openInEditor, runtimeConfig, state?.path, workspaceId]);

  const enableFlowPrompt = useCallback(async () => {
    if (!api) {
      setError("API not available");
      return;
    }

    const result = await api.workspace.flowPrompt.create({ workspaceId });
    if (!result.success) {
      setError(result.error);
      return;
    }

    setError(null);
    const openResult = await openInEditor(workspaceId, result.data.path, runtimeConfig, {
      isFile: true,
    });
    if (!openResult.success) {
      setError(openResult.error ?? "Failed to open flow prompt");
    }
  }, [api, openInEditor, runtimeConfig, workspaceId]);

  const disableFlowPrompt = useCallback(async () => {
    if (!api) {
      setError("API not available");
      return;
    }

    let latestState = state;
    try {
      latestState = await api.workspace.flowPrompt.getState({ workspaceId });
    } catch {
      setError("Failed to refresh flow prompt state.");
      return;
    }

    const relativePath = getFlowPromptRelativePath(workspaceName);
    if (latestState?.hasNonEmptyContent) {
      const confirmed = await confirm({
        title: "Disable Flow Prompting?",
        description: `Delete ${relativePath} and return to inline chat?`,
        warning: "The flow prompt file contains content and will be deleted.",
        confirmLabel: "Delete file",
      });
      if (!confirmed) {
        return;
      }
    }

    const result = await api.workspace.flowPrompt.delete({ workspaceId });
    if (!result.success) {
      setError(result.error);
      return;
    }

    setError(null);
  }, [api, confirm, state, workspaceId, workspaceName]);

  const updateAutoSendMode = useCallback(
    async (mode: FlowPromptAutoSendMode) => {
      if (!api) {
        setError("API not available");
        return;
      }
      if (isUpdatingAutoSendMode) {
        return;
      }

      setIsUpdatingAutoSendMode(true);
      try {
        const result = await api.workspace.flowPrompt.updateAutoSendMode({ workspaceId, mode });
        if (!result.success) {
          setError(result.error);
          return;
        }
        setError(null);
      } finally {
        setIsUpdatingAutoSendMode(false);
      }
    },
    [api, isUpdatingAutoSendMode, workspaceId]
  );

  const sendNow = useCallback(async () => {
    if (!api) {
      setError("API not available");
      return;
    }
    if (isSendingNow) {
      return;
    }

    setIsSendingNow(true);
    try {
      const result = await api.workspace.flowPrompt.sendNow({ workspaceId });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setError(null);
    } finally {
      setIsSendingNow(false);
    }
  }, [api, isSendingNow, workspaceId]);

  return {
    state,
    error,
    isUpdatingAutoSendMode,
    isSendingNow,
    clearError,
    openFlowPrompt,
    enableFlowPrompt,
    disableFlowPrompt,
    updateAutoSendMode,
    sendNow,
  };
}
