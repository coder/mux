import { useState, useEffect, useCallback } from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig, RuntimeMode, ParsedRuntime } from "@/common/types/runtime";
import { buildRuntimeConfig } from "@/common/types/runtime";
import type { ThinkingLevel } from "@/common/types/thinking";
import { useDraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import {
  getAgentIdKey,
  getInputKey,
  getInputImagesKey,
  getModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByModeKey,
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
  /** Section ID to assign the new workspace to */
  sectionId?: string | null;
  /** User's currently selected model (for name generation fallback) */
  userModel?: string;
}

function syncCreationPreferences(projectPath: string, workspaceId: string): void {
  const projectScopeId = getProjectScopeId(projectPath);

  // Sync model from project scope to workspace scope
  // This ensures the model used for creation is persisted for future resumes
  const projectModel = readPersistedState<string | null>(getModelKey(projectScopeId), null);
  if (projectModel) {
    updatePersistedState(getModelKey(workspaceId), projectModel);
  }

  const projectAgentId = readPersistedState<string | null>(getAgentIdKey(projectScopeId), null);
  if (projectAgentId) {
    updatePersistedState(getAgentIdKey(workspaceId), projectAgentId);
  }

  const projectThinkingLevel = readPersistedState<ThinkingLevel | null>(
    getThinkingLevelKey(projectScopeId),
    null
  );
  if (projectThinkingLevel !== null) {
    updatePersistedState(getThinkingLevelKey(workspaceId), projectThinkingLevel);
  }

  if (projectModel) {
    const effectiveAgentId =
      typeof projectAgentId === "string" && projectAgentId.trim().length > 0
        ? projectAgentId.trim().toLowerCase()
        : "exec";
    const effectiveThinking: ThinkingLevel = projectThinkingLevel ?? "off";

    updatePersistedState<Partial<Record<string, { model: string; thinkingLevel: ThinkingLevel }>>>(
      getWorkspaceAISettingsByModeKey(workspaceId),
      (prev) => {
        const record = prev && typeof prev === "object" ? prev : {};
        return {
          ...(record as Partial<Record<string, { model: string; thinkingLevel: ThinkingLevel }>>),
          [effectiveAgentId]: { model: projectModel, thinkingLevel: effectiveThinking },
        };
      },
      {}
    );
  }
}

interface UseCreationWorkspaceReturn {
  branches: string[];
  /** Whether listBranches has completed (to distinguish loading vs non-git repo) */
  branchesLoaded: boolean;
  trunkBranch: string;
  setTrunkBranch: (branch: string) => void;
  /** Currently selected runtime (discriminated union: SSH has host, Docker has image) */
  selectedRuntime: ParsedRuntime;
  defaultRuntimeMode: RuntimeMode;
  /** Set the currently selected runtime (discriminated union) */
  setSelectedRuntime: (runtime: ParsedRuntime) => void;
  /** Set the default runtime mode for this project (persists via checkbox) */
  setDefaultRuntimeMode: (mode: RuntimeMode) => void;
  toast: Toast | null;
  setToast: (toast: Toast | null) => void;
  isSending: boolean;
  handleSend: (message: string, imageParts?: ImagePart[]) => Promise<boolean>;
  /** Workspace name/title generation state and actions (for CreationControls) */
  nameState: WorkspaceNameState;
  /** The confirmed identity being used for creation (null until generation resolves) */
  creatingWithIdentity: WorkspaceIdentity | null;
  /** Reload branches (e.g., after git init) */
  reloadBranches: () => Promise<void>;
  /** Runtime availability for each mode (null while loading) */
  runtimeAvailability: RuntimeAvailabilityMap | null;
}

/** Runtime availability status for each mode */
export type RuntimeAvailabilityMap = Record<
  RuntimeMode,
  { available: true } | { available: false; reason: string }
>;

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
  sectionId,
  userModel,
}: UseCreationWorkspaceOptions): UseCreationWorkspaceReturn {
  const { api } = useAPI();
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [recommendedTrunk, setRecommendedTrunk] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [isSending, setIsSending] = useState(false);
  // The confirmed identity being used for workspace creation (set after waitForGeneration resolves)
  const [creatingWithIdentity, setCreatingWithIdentity] = useState<WorkspaceIdentity | null>(null);
  const [runtimeAvailability, setRuntimeAvailability] = useState<RuntimeAvailabilityMap | null>(
    null
  );

  // Centralized draft workspace settings with automatic persistence
  const { settings, setSelectedRuntime, setDefaultRuntimeMode, setTrunkBranch } =
    useDraftWorkspaceSettings(projectPath, branches, recommendedTrunk);

  // Project scope ID for reading send options at send time
  const projectScopeId = getProjectScopeId(projectPath);

  // Workspace name generation with debounce
  // Backend tries cheap models first, then user's model, then any available
  const workspaceNameState = useWorkspaceName({
    message,
    debounceMs: 500,
    userModel,
  });

  // Destructure name state functions for use in callbacks
  const { waitForGeneration } = workspaceNameState;

  // Load branches - used on mount and after git init
  // Returns a cleanup function to track mounted state
  const loadBranches = useCallback(async () => {
    if (!projectPath.length || !api) return;
    setBranchesLoaded(false);
    try {
      const result = await api.projects.listBranches({ projectPath });
      setBranches(result.branches);
      setRecommendedTrunk(result.recommendedTrunk);
    } catch (err) {
      console.error("Failed to load branches:", err);
    } finally {
      setBranchesLoaded(true);
    }
  }, [projectPath, api]);

  // Load branches and runtime availability on mount with mounted guard
  useEffect(() => {
    if (!projectPath.length || !api) return;
    let mounted = true;
    setBranchesLoaded(false);
    setRuntimeAvailability(null);
    const doLoad = async () => {
      try {
        // Use allSettled so failures are independent - branches can load even if availability fails
        const [branchResult, availabilityResult] = await Promise.allSettled([
          api.projects.listBranches({ projectPath }),
          api.projects.runtimeAvailability({ projectPath }),
        ]);
        if (!mounted) return;
        if (branchResult.status === "fulfilled") {
          setBranches(branchResult.value.branches);
          setRecommendedTrunk(branchResult.value.recommendedTrunk);
        } else {
          console.error("Failed to load branches:", branchResult.reason);
        }
        if (availabilityResult.status === "fulfilled") {
          setRuntimeAvailability(availabilityResult.value);
        }
        // If availability fails, runtimeAvailability stays null and UI shows all runtimes enabled
      } finally {
        if (mounted) {
          setBranchesLoaded(true);
        }
      }
    };
    void doLoad();
    return () => {
      mounted = false;
    };
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

        // Build runtime config from selected runtime (preserves all fields like shareCredentials)
        const runtimeConfig: RuntimeConfig | undefined = buildRuntimeConfig(
          settings.selectedRuntime
        );

        // Validate Docker image is not empty
        if (runtimeConfig?.type === "docker" && !runtimeConfig.image?.trim()) {
          setToast({
            id: Date.now().toString(),
            type: "error",
            message: "Docker image is required",
          });
          setIsSending(false);
          return false;
        }

        // Validate SSH host is not empty
        if (runtimeConfig?.type === "ssh" && !runtimeConfig.host?.trim()) {
          setToast({
            id: Date.now().toString(),
            type: "error",
            message: "SSH host is required",
          });
          setIsSending(false);
          return false;
        }

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
          sectionId: sectionId ?? undefined,
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
        try {
          api.workspace
            .updateModeAISettings({
              workspaceId: metadata.id,
              mode: settings.mode,
              aiSettings: {
                model: settings.model,
                thinkingLevel: settings.thinkingLevel,
              },
            })
            .catch(() => {
              // Ignore (offline / older backend). sendMessage will persist as a fallback.
            });
        } catch {
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
        }
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
      settings.selectedRuntime,
      settings.mode,
      settings.model,
      settings.thinkingLevel,
      settings.trunkBranch,
      waitForGeneration,
      sectionId,
    ]
  );

  return {
    branches,
    branchesLoaded,
    trunkBranch: settings.trunkBranch,
    setTrunkBranch,
    selectedRuntime: settings.selectedRuntime,
    defaultRuntimeMode: settings.defaultRuntimeMode,
    setSelectedRuntime,
    setDefaultRuntimeMode,
    toast,
    setToast,
    isSending,
    handleSend,
    // Workspace name/title state (for CreationControls)
    nameState: workspaceNameState,
    // The confirmed identity being used for creation (null until generation resolves)
    creatingWithIdentity,
    // Reload branches (e.g., after git init)
    reloadBranches: loadBranches,
    // Runtime availability for each mode
    runtimeAvailability,
  };
}
