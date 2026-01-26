import { useState, useEffect, useCallback } from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type {
  RuntimeConfig,
  RuntimeMode,
  ParsedRuntime,
  RuntimeAvailabilityStatus,
} from "@/common/types/runtime";
import { buildRuntimeConfig, RUNTIME_MODE } from "@/common/types/runtime";
import type { ThinkingLevel } from "@/common/types/thinking";
import { useDraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getSendOptionsFromStorage } from "@/browser/utils/messages/sendOptions";
import {
  getAgentIdKey,
  getInputKey,
  getInputAttachmentsKey,
  getModelKey,
  getNotifyOnResponseAutoEnableKey,
  getNotifyOnResponseKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  getPendingScopeId,
  getPendingWorkspaceSendErrorKey,
  getProjectScopeId,
} from "@/common/constants/storage";
import type { SendMessageError } from "@/common/types/errors";
import type { Toast } from "@/browser/components/ChatInputToast";
import { useAPI } from "@/browser/contexts/API";
import type { FilePart, SendMessageOptions } from "@/common/orpc/types";
import {
  useWorkspaceName,
  type WorkspaceNameState,
  type WorkspaceIdentity,
} from "@/browser/hooks/useWorkspaceName";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { getModelCapabilities } from "@/common/utils/ai/modelCapabilities";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import { resolveDevcontainerSelection } from "@/browser/utils/devcontainerSelection";

export type CreationSendResult = { success: true } | { success: false; error?: SendMessageError };

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
      getWorkspaceAISettingsByAgentKey(workspaceId),
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

  // Auto-enable notifications if the project-level preference is set
  const autoEnableNotifications = readPersistedState<boolean>(
    getNotifyOnResponseAutoEnableKey(projectPath),
    false
  );
  if (autoEnableNotifications) {
    updatePersistedState(getNotifyOnResponseKey(workspaceId), true);
  }
}

const PDF_MEDIA_TYPE = "application/pdf";

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

function estimateBase64DataUrlBytes(dataUrl: string): number | null {
  if (!dataUrl.startsWith("data:")) return null;

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) return null;

  const header = dataUrl.slice("data:".length, commaIndex);
  if (!header.includes(";base64")) return null;

  const base64 = dataUrl.slice(commaIndex + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
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
  handleSend: (
    message: string,
    fileParts?: FilePart[],
    optionsOverride?: Partial<SendMessageOptions>
  ) => Promise<CreationSendResult>;
  /** Workspace name/title generation state and actions (for CreationControls) */
  nameState: WorkspaceNameState;
  /** The confirmed identity being used for creation (null until generation resolves) */
  creatingWithIdentity: WorkspaceIdentity | null;
  /** Reload branches (e.g., after git init) */
  reloadBranches: () => Promise<void>;
  /** Runtime availability state for each mode (loading/failed/loaded) */
  runtimeAvailabilityState: RuntimeAvailabilityState;
}

/** Runtime availability status for each mode */
export type RuntimeAvailabilityMap = Record<RuntimeMode, RuntimeAvailabilityStatus>;

export type RuntimeAvailabilityState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "loaded"; data: RuntimeAvailabilityMap };

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
  const [runtimeAvailabilityState, setRuntimeAvailabilityState] =
    useState<RuntimeAvailabilityState>({ status: "loading" });

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
    setRuntimeAvailabilityState({ status: "loading" });
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
          setRuntimeAvailabilityState({ status: "loaded", data: availabilityResult.value });
        } else {
          setRuntimeAvailabilityState({ status: "failed" });
        }
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
    async (
      messageText: string,
      fileParts?: FilePart[],
      optionsOverride?: Partial<SendMessageOptions>
    ): Promise<CreationSendResult> => {
      if (!messageText.trim() || isSending || !api) {
        return { success: false };
      }

      // Build runtime config early (used later for workspace creation)
      let runtimeSelection = settings.selectedRuntime;

      if (runtimeSelection.mode === RUNTIME_MODE.DEVCONTAINER) {
        const devcontainerSelection = resolveDevcontainerSelection({
          selectedRuntime: runtimeSelection,
          availabilityState: runtimeAvailabilityState,
        });

        if (!devcontainerSelection.isCreatable) {
          setToast({
            id: Date.now().toString(),
            type: "error",
            message: "Select a devcontainer configuration before creating the workspace.",
          });
          return { success: false };
        }

        // Update selection with resolved config if different (persist the resolved value)
        if (devcontainerSelection.configPath !== runtimeSelection.configPath) {
          runtimeSelection = {
            ...runtimeSelection,
            configPath: devcontainerSelection.configPath,
          };
          setSelectedRuntime(runtimeSelection);
        }
      }

      const runtimeConfig: RuntimeConfig | undefined = buildRuntimeConfig(runtimeSelection);

      setIsSending(true);
      setToast(null);
      setCreatingWithIdentity(null);

      try {
        // Wait for identity generation to complete (blocks if still in progress)
        // Returns null if generation failed or manual name is empty (error already set in hook)
        const identity = await waitForGeneration();
        if (!identity) {
          setIsSending(false);
          return { success: false };
        }

        // Set the confirmed identity for splash UI display
        setCreatingWithIdentity(identity);

        // Read send options fresh from localStorage at send time to avoid
        // race conditions with React state updates (requestAnimationFrame batching
        // in usePersistedState can delay state updates after model selection)
        const sendMessageOptions = getSendOptionsFromStorage(projectScopeId);
        const effectiveModel = optionsOverride?.model ?? sendMessageOptions.model;
        const baseModel = normalizeGatewayModel(effectiveModel);

        // Preflight: if the first message includes PDFs, ensure the selected model can accept them.
        // This prevents creating an empty workspace when the initial send is rejected.
        const pdfFileParts = (fileParts ?? []).filter(
          (part) => getBaseMediaType(part.mediaType) === PDF_MEDIA_TYPE
        );
        if (pdfFileParts.length > 0) {
          const caps = getModelCapabilities(baseModel);
          if (caps && !caps.supportsPdfInput) {
            const pdfCapableKnownModels = Object.values(KNOWN_MODELS)
              .map((m) => m.id)
              .filter((model) => getModelCapabilities(model)?.supportsPdfInput);
            const pdfCapableExamples = pdfCapableKnownModels.slice(0, 3);
            const examplesSuffix =
              pdfCapableKnownModels.length > pdfCapableExamples.length ? ", and others." : ".";

            setToast({
              id: Date.now().toString(),
              type: "error",
              title: "PDF not supported",
              message:
                `Model ${baseModel} does not support PDF input.` +
                (pdfCapableExamples.length > 0
                  ? ` Try e.g.: ${pdfCapableExamples.join(", ")}${examplesSuffix}`
                  : " Choose a model with PDF support."),
            });
            setIsSending(false);
            return { success: false };
          }

          if (caps?.maxPdfSizeMb !== undefined) {
            const maxBytes = caps.maxPdfSizeMb * 1024 * 1024;
            for (const part of pdfFileParts) {
              const bytes = estimateBase64DataUrlBytes(part.url);
              if (bytes !== null && bytes > maxBytes) {
                const actualMb = (bytes / (1024 * 1024)).toFixed(1);
                setToast({
                  id: Date.now().toString(),
                  type: "error",
                  title: "PDF too large",
                  message: `${part.filename ?? "PDF"} is ${actualMb}MB, but ${baseModel} allows up to ${caps.maxPdfSizeMb}MB per PDF.`,
                });
                setIsSending(false);
                return { success: false };
              }
            }
          }
        }

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
          return { success: false };
        }

        const { metadata } = createResult;

        // Best-effort: persist the initial AI settings to the backend immediately so this workspace
        // is portable across devices even before the first stream starts.
        api.workspace
          .updateAgentAISettings({
            workspaceId: metadata.id,
            agentId: settings.agentId,
            aiSettings: {
              model: settings.model,
              thinkingLevel: settings.thinkingLevel,
            },
          })
          .catch(() => {
            // Ignore - sendMessage will persist AI settings as a fallback.
          });

        const pendingScopeId = projectPath ? getPendingScopeId(projectPath) : null;

        // Sync preferences before switching (keeps workspace settings consistent).
        syncCreationPreferences(projectPath, metadata.id);

        // Switch to the workspace IMMEDIATELY after creation to exit splash faster.
        // The user sees the workspace UI while sendMessage kicks off the stream.
        onWorkspaceCreated(metadata);
        setIsSending(false);

        // Wait for the initial send result so the creation flow can preserve drafts on failure.
        const additionalSystemInstructions = [
          sendMessageOptions.additionalSystemInstructions,
          optionsOverride?.additionalSystemInstructions,
        ]
          .filter((part) => typeof part === "string" && part.trim().length > 0)
          .join("\n\n");

        const sendResult = await api.workspace.sendMessage({
          workspaceId: metadata.id,
          message: messageText,
          options: {
            ...sendMessageOptions,
            ...optionsOverride,
            additionalSystemInstructions: additionalSystemInstructions.length
              ? additionalSystemInstructions
              : undefined,
            fileParts: fileParts && fileParts.length > 0 ? fileParts : undefined,
          },
        });

        if (!sendResult.success) {
          if (sendResult.error) {
            // Persist the failure so the workspace view can surface a toast after navigation.
            updatePersistedState(getPendingWorkspaceSendErrorKey(metadata.id), sendResult.error);
          }
          // Preserve draft input/attachments so the user can retry later.
          return { success: false, error: sendResult.error };
        }

        if (pendingScopeId) {
          updatePersistedState(getInputKey(pendingScopeId), "");
          updatePersistedState(getInputAttachmentsKey(pendingScopeId), undefined);
        }

        return { success: true };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setToast({
          id: Date.now().toString(),
          type: "error",
          message: `Failed to create workspace: ${errorMessage}`,
        });
        setIsSending(false);
        return { success: false };
      }
    },
    [
      api,
      isSending,
      projectPath,
      projectScopeId,
      onWorkspaceCreated,
      settings.selectedRuntime,
      runtimeAvailabilityState,
      setSelectedRuntime,
      settings.agentId,
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
    // Runtime availability state for each mode
    runtimeAvailabilityState,
  };
}
