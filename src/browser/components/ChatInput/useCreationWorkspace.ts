import { useState, useEffect, useCallback } from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { RuntimeConfig, RuntimeMode } from "@/common/types/runtime";
import { parseRuntimeString } from "@/browser/utils/chatCommands";
import { useDraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import { useSendMessageOptions } from "@/browser/hooks/useSendMessageOptions";
import { getProjectScopeId } from "@/common/constants/storage";
import { extractErrorMessage } from "./utils";

interface UseCreationWorkspaceOptions {
  projectPath: string;
  onWorkspaceCreated: (metadata: FrontendWorkspaceMetadata) => void;
}

interface UseCreationWorkspaceReturn {
  branches: string[];
  trunkBranch: string;
  setTrunkBranch: (branch: string) => void;
  runtimeMode: RuntimeMode;
  sshHost: string;
  setRuntimeOptions: (mode: RuntimeMode, host: string) => void;
  error: string | null;
  setError: (error: string | null) => void;
  isSending: boolean;
  handleSend: (message: string) => Promise<void>;
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
  const [branches, setBranches] = useState<string[]>([]);
  const [recommendedTrunk, setRecommendedTrunk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  // Centralized draft workspace settings with automatic persistence
  const { settings, setRuntimeOptions, setTrunkBranch, getRuntimeString } =
    useDraftWorkspaceSettings(projectPath, branches, recommendedTrunk);

  // Get send options from shared hook (uses project-scoped storage key)
  const sendMessageOptions = useSendMessageOptions(getProjectScopeId(projectPath));

  // Load branches on mount
  useEffect(() => {
    // This can be created with an empty project path when the user is
    // creating a new workspace.
    if (!projectPath.length) {
      return;
    }
    const loadBranches = async () => {
      try {
        const result = await window.api.projects.listBranches(projectPath);
        setBranches(result.branches);
        setRecommendedTrunk(result.recommendedTrunk);
      } catch (err) {
        console.error("Failed to load branches:", err);
      }
    };
    void loadBranches();
  }, [projectPath]);

  const handleSend = useCallback(
    async (message: string) => {
      if (!message.trim() || isSending) return;

      setIsSending(true);
      setError(null);

      try {
        // Get runtime config from options
        const runtimeString = getRuntimeString();
        const runtimeConfig: RuntimeConfig | undefined = runtimeString
          ? parseRuntimeString(runtimeString, "")
          : undefined;

        // Send message with runtime config and creation-specific params
        const result = await window.api.workspace.sendMessage(null, message, {
          ...sendMessageOptions,
          runtimeConfig,
          projectPath, // Pass projectPath when workspaceId is null
          trunkBranch: settings.trunkBranch, // Pass selected trunk branch from settings
        });

        if (!result.success) {
          setError(extractErrorMessage(result.error));
          setIsSending(false);
          return;
        }

        // Check if this is a workspace creation result (has metadata field)
        if ("metadata" in result && result.metadata) {
          // Settings are already persisted via useDraftWorkspaceSettings
          // Notify parent to switch workspace (clears input via parent unmount)
          onWorkspaceCreated(result.metadata);
        } else {
          // This shouldn't happen for null workspaceId, but handle gracefully
          setError("Unexpected response from server");
          setIsSending(false);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(`Failed to create workspace: ${errorMessage}`);
        setIsSending(false);
      }
    },
    [
      isSending,
      projectPath,
      onWorkspaceCreated,
      getRuntimeString,
      sendMessageOptions,
      settings.trunkBranch,
    ]
  );

  return {
    branches,
    trunkBranch: settings.trunkBranch,
    setTrunkBranch,
    runtimeMode: settings.runtimeMode,
    sshHost: settings.sshHost,
    setRuntimeOptions,
    error,
    setError,
    isSending,
    handleSend,
  };
}
