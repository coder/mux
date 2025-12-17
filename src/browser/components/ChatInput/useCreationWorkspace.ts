import { useState, useEffect, useCallback } from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig, RuntimeMode } from "@/common/types/runtime";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { UIMode } from "@/common/types/mode";
import { parseRuntimeString } from "@/browser/utils/chatCommands";
import { useDraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import {
  getInputKey,
  getInputImagesKey,
  getModelKey,
  getModeKey,
  getThinkingLevelKey,
  getPendingScopeId,
  getProjectScopeId,
} from "@/common/constants/storage";
import type { Toast } from "@/browser/components/ChatInputToast";
import { useAPI } from "@/browser/contexts/API";
import type { ImagePart } from "@/common/orpc/types";
import {
  useWorkspaceName,
  type WorkspaceNameState,
  type WorkspaceIdentity,
} from "@/browser/hooks/useWorkspaceName";

interface UseCreationWorkspaceOptions {
  projectPath: string;
  onWorkspaceCreated: (metadata: FrontendWorkspaceMetadata) => void;
  /** Current message input for name generation */
  message: string;
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

  const projectThinkingLevel = readPersistedState<ThinkingLevel | null>(
    getThinkingLevelKey(projectScopeId),
    null
  );
  if (projectThinkingLevel !== null) {
    updatePersistedState(getThinkingLevelKey(workspaceId), projectThinkingLevel);
  }
}

interface UseCreationWorkspaceReturn {
  branches: string[];
  /** Whether listBranches has completed (to distinguish loading vs non-git repo) */
  branchesLoaded: boolean;
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
  /** Workspace name/title generation state and actions (for CreationControls) */
  nameState: WorkspaceNameState;
  /** The confirmed identity being used for creation (null until generation resolves) */
  creatingWithIdentity: WorkspaceIdentity | null;
}

/**
 * Hook for managing workspace creation state and logic
 * Handles:
 * - Branch selection
 * - Runtime configuration (local vs SSH)
 * - Workspace name generation
 * - Message sending with workspace creation
 */
export function useCreationWorkspace({
  projectPath,
  onWorkspaceCreated,
  message,
}: UseCreationWorkspaceOptions): UseCreationWorkspaceReturn {
  const { api } = useAPI();
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [recommendedTrunk, setRecommendedTrunk] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [isSending, setIsSending] = useState(false);
  // The confirmed identity being used for workspace creation (set after waitForGeneration resolves)
  const [creatingWithIdentity, setCreatingWithIdentity] = useState<WorkspaceIdentity | null>(null);

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

  // Read the user's preferred model for fallback (same source as ChatInput's preferredModel)
  const fallbackModel = readPersistedState<string | null>(getModelKey(projectScopeId), null);

  // Workspace name generation with debounce
  const workspaceNameState = useWorkspaceName({
    message,
    debounceMs: 500,
    fallbackModel: fallbackModel ?? undefined,
  });

  // Destructure name state functions for use in callbacks
  const { waitForGeneration } = workspaceNameState;

  // Load branches on mount
  useEffect(() => {
    // This can be created with an empty project path when the user is
    // creating a new workspace.
    if (!projectPath.length || !api) {
      return;
    }
    setBranchesLoaded(false);
    const loadBranches = async () => {
      try {
        const result = await api.projects.listBranches({ projectPath });
        setBranches(result.branches);
        setRecommendedTrunk(result.recommendedTrunk);
      } catch (err) {
        console.error("Failed to load branches:", err);
      } finally {
        setBranchesLoaded(true);
      }
    };
    void loadBranches();
  }, [projectPath, api]);

  const handleSend = useCallback(
    async (messageText: string, imageParts?: ImagePart[]): Promise<boolean> => {
      if (!messageText.trim() || isSending || !api) return false;

      setIsSending(true);
      setToast(null);
      setCreatingWithIdentity(null);

      try {
        // Wait for identity generation to complete (blocks if still in progress)
        // Returns null if generation failed or manual name is empty (error already set in hook)
        const identity = await waitForGeneration();
        if (!identity) {
          setIsSending(false);
          return false;
        }

        // Set the confirmed identity for splash UI display
        setCreatingWithIdentity(identity);

        // Get runtime config from options
        const runtimeString = getRuntimeString();
        const runtimeConfig: RuntimeConfig | undefined = runtimeString
          ? parseRuntimeString(runtimeString, "")
          : undefined;

        // Read send options fresh from localStorage at send time to avoid
        // race conditions with React state updates (requestAnimationFrame batching
        // in usePersistedState can delay state updates after model selection)
        const sendMessageOptions = getSendOptionsFromStorage(projectScopeId);

        // Create the workspace with the generated name and title
        const createResult = await api.workspace.create({
          projectPath,
          branchName: identity.name,
          trunkBranch: settings.trunkBranch,
          title: identity.title,
          runtimeConfig,
        });

        if (!createResult.success) {
          setToast({
            id: Date.now().toString(),
            type: "error",
            message: createResult.error,
          });
          setIsSending(false);
          return false;
        }

        const { metadata } = createResult;

        // Best-effort: persist the initial AI settings to the backend immediately so this workspace
        // is portable across devices even before the first stream starts.
        api.workspace
          .updateAISettings({
            workspaceId: metadata.id,
            aiSettings: {
              model: settings.model,
              thinkingLevel: settings.thinkingLevel,
            },
          })
          .catch(() => {
            // Ignore (offline / older backend). sendMessage will persist as a fallback.
          });
        // Sync preferences immediately (before switching)
        syncCreationPreferences(projectPath, metadata.id);
        if (projectPath) {
          const pendingScopeId = getPendingScopeId(projectPath);
          updatePersistedState(getInputKey(pendingScopeId), "");
          updatePersistedState(getInputImagesKey(pendingScopeId), undefined);
        }

        // Switch to the workspace IMMEDIATELY after creation to exit splash faster.
        // The user sees the workspace UI while sendMessage kicks off the stream.
        onWorkspaceCreated(metadata);
        setIsSending(false);

        // Fire sendMessage in the background - stream errors will be shown in the workspace UI
        // via the normal stream-error event handling. We don't await this.
        void api.workspace.sendMessage({
          workspaceId: metadata.id,
          message: messageText,
          options: {
            ...sendMessageOptions,
            imageParts: imageParts && imageParts.length > 0 ? imageParts : undefined,
          },
        });

        return true;
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
      settings.model,
      settings.thinkingLevel,
      settings.trunkBranch,
      waitForGeneration,
    ]
  );

  return {
    branches,
    branchesLoaded,
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
    // Workspace name/title state (for CreationControls)
    nameState: workspaceNameState,
    // The confirmed identity being used for creation (null until generation resolves)
    creatingWithIdentity,
  };
}
