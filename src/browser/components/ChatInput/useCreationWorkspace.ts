import { useState, useEffect, useCallback } from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig, RuntimeMode } from "@/common/types/runtime";
import type { UIMode } from "@/common/types/mode";
import type { ThinkingLevel } from "@/common/types/thinking";
import { parseRuntimeString } from "@/browser/utils/chatCommands";
import { useDraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import {
  getInputKey,
  getModelKey,
  getModeKey,
  getPendingScopeId,
  getProjectScopeId,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import type { Toast } from "@/browser/components/ChatInputToast";
import { createErrorToast } from "@/browser/components/ChatInputToasts";
import { useAPI } from "@/browser/contexts/API";
import type { ImagePart } from "@/common/orpc/types";

interface UseCreationWorkspaceOptions {
  projectPath: string;
  onWorkspaceCreated: (metadata: FrontendWorkspaceMetadata) => void;
}

function syncCreationPreferences(projectPath: string, workspaceId: string): void {
  const projectScopeId = getProjectScopeId(projectPath);

  // Sync model from project scope to workspace scope
  // This ensures the model used for creation is persisted for future resumes
  const projectModel = readPersistedState<string | null>(getModelKey(projectScopeId), null);
  if (projectModel) {
    updatePersistedState(getModelKey(workspaceId), projectModel);
  }

  const projectMode = readPersistedState<UIMode | null>(getModeKey(projectScopeId), null);
  if (projectMode) {
    updatePersistedState(getModeKey(workspaceId), projectMode);
  }

  const projectThinking = readPersistedState<ThinkingLevel | null>(
    getThinkingLevelKey(projectScopeId),
    null
  );
  if (projectThinking) {
    updatePersistedState(getThinkingLevelKey(workspaceId), projectThinking);
  }
}

interface UseCreationWorkspaceReturn {
  branches: string[];
  trunkBranch: string;
  setTrunkBranch: (branch: string) => void;
  runtimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode;
  sshHost: string;
  /** Set the currently selected runtime mode (does not persist) */
  setRuntimeMode: (mode: RuntimeMode) => void;
  /** Set the default runtime mode for this project (persists via checkbox) */
  setDefaultRuntimeMode: (mode: RuntimeMode) => void;
  /** Set the SSH host (persisted separately from runtime mode) */
  setSshHost: (host: string) => void;
  toast: Toast | null;
  setToast: (toast: Toast | null) => void;
  isSending: boolean;
  handleSend: (message: string, imageParts?: ImagePart[]) => Promise<boolean>;
}

/**
 * Hook for managing workspace creation state and logic
 * Handles:
 * - Branch selection
 * - Runtime configuration (local vs SSH)
 * - Message sending with workspace creation
 */
export function useCreationWorkspace({
  projectPath,
  onWorkspaceCreated,
}: UseCreationWorkspaceOptions): UseCreationWorkspaceReturn {
  const { api } = useAPI();
  const [branches, setBranches] = useState<string[]>([]);
  const [recommendedTrunk, setRecommendedTrunk] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [isSending, setIsSending] = useState(false);

  // Centralized draft workspace settings with automatic persistence
  const {
    settings,
    setRuntimeMode,
    setDefaultRuntimeMode,
    setSshHost,
    setTrunkBranch,
    getRuntimeString,
  } = useDraftWorkspaceSettings(projectPath, branches, recommendedTrunk);

  // Project scope ID for reading send options at send time
  const projectScopeId = getProjectScopeId(projectPath);

  // Load branches on mount
  useEffect(() => {
    // This can be created with an empty project path when the user is
    // creating a new workspace.
    if (!projectPath.length || !api) {
      return;
    }
    const loadBranches = async () => {
      try {
        const result = await api.projects.listBranches({ projectPath });
        setBranches(result.branches);
        setRecommendedTrunk(result.recommendedTrunk);
      } catch (err) {
        console.error("Failed to load branches:", err);
      }
    };
    void loadBranches();
  }, [projectPath, api]);

  const handleSend = useCallback(
    async (message: string, imageParts?: ImagePart[]): Promise<boolean> => {
      if (!message.trim() || isSending || !api) return false;

      setIsSending(true);
      setToast(null);

      try {
        // Get runtime config from options
        const runtimeString = getRuntimeString();
        const runtimeConfig: RuntimeConfig | undefined = runtimeString
          ? parseRuntimeString(runtimeString, "")
          : undefined;

        // Read send options fresh from localStorage at send time to avoid
        // race conditions with React state updates (requestAnimationFrame batching
        // in usePersistedState can delay state updates after model selection)
        const sendMessageOptions = getSendOptionsFromStorage(projectScopeId);

        // Send message with runtime config and creation-specific params
        const result = await api.workspace.sendMessage({
          workspaceId: null,
          message,
          options: {
            ...sendMessageOptions,
            runtimeConfig,
            projectPath, // Pass projectPath when workspaceId is null
            trunkBranch: settings.trunkBranch, // Pass selected trunk branch from settings
            imageParts: imageParts && imageParts.length > 0 ? imageParts : undefined,
          },
        });

        if (!result.success) {
          setToast(createErrorToast(result.error));
          setIsSending(false);
          return false;
        }

        // Check if this is a workspace creation result (has metadata in data)
        const { metadata } = result.data;
        if (metadata) {
          syncCreationPreferences(projectPath, metadata.id);
          if (projectPath) {
            const pendingInputKey = getInputKey(getPendingScopeId(projectPath));
            updatePersistedState(pendingInputKey, "");
          }
          // Settings are already persisted via useDraftWorkspaceSettings
          // Notify parent to switch workspace (clears input via parent unmount)
          onWorkspaceCreated(metadata);
          setIsSending(false);
          return true;
        } else {
          // This shouldn't happen for null workspaceId, but handle gracefully
          setToast({
            id: Date.now().toString(),
            type: "error",
            message: "Unexpected response from server",
          });
          setIsSending(false);
          return false;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: `Failed to create workspace: ${errorMessage}`,
        });
        setIsSending(false);
        return false;
      }
    },
    [
      api,
      isSending,
      projectPath,
      projectScopeId,
      onWorkspaceCreated,
      getRuntimeString,
      settings.trunkBranch,
    ]
  );

  return {
    branches,
    trunkBranch: settings.trunkBranch,
    setTrunkBranch,
    runtimeMode: settings.runtimeMode,
    defaultRuntimeMode: settings.defaultRuntimeMode,
    sshHost: settings.sshHost,
    setRuntimeMode,
    setDefaultRuntimeMode,
    setSshHost,
    toast,
    setToast,
    isSending,
    handleSend,
  };
}
