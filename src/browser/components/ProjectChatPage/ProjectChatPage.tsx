import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { ProjectChatHeader } from "@/browser/components/ProjectChatHeader/ProjectChatHeader";
import { AIView } from "@/browser/components/AIView/AIView";
import { Button } from "@/browser/components/Button/Button";
import { ConfirmationModal } from "@/browser/components/ConfirmationModal/ConfirmationModal";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import {
  getAgentIdKey,
  getReasoningModeKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
} from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import { getErrorMessage } from "@/common/utils/errors";
import type { ProjectChatInfo } from "@/common/types/project";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";

interface ProjectChatPageProps {
  projectPath: string;
  projectName: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}

type ProjectChatLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; info: ProjectChatInfo };

function seedProjectChatAiSettings(info: ProjectChatInfo): void {
  const workspaceId = info.sessionId;
  const agentId = info.agentId;
  const settings = info.aiSettingsByAgent?.[agentId] ?? info.metadata.aiSettingsByAgent?.[agentId];

  updatePersistedState(getAgentIdKey(workspaceId), agentId);
  if (!settings) {
    return;
  }

  updatePersistedState(getWorkspaceAISettingsByAgentKey(workspaceId), {
    [agentId]: settings,
  });
  setWorkspaceModelWithOrigin(workspaceId, settings.model, "sync");
  updatePersistedState<ThinkingLevel>(getThinkingLevelKey(workspaceId), settings.thinkingLevel);
  updatePersistedState<OpenAIReasoningMode>(
    getReasoningModeKey(workspaceId),
    settings.reasoningMode ?? "standard"
  );
}

/** Persistent, project-owned control-plane chat. Its session never appears as a workspace row. */
export function ProjectChatPage(props: ProjectChatPageProps) {
  const { api } = useAPI();
  const { getProjectConfig, refreshProjects, loading: projectsLoading } = useProjectContext();
  const workspaceStore = useWorkspaceStoreRaw();
  const [reloadKey, setReloadKey] = useState(0);
  const [locallyTrustedProjectPath, setLocallyTrustedProjectPath] = useState<string | null>(null);
  const [dismissedTrustProjectPath, setDismissedTrustProjectPath] = useState<string | null>(null);
  const [trustError, setTrustError] = useState<string | null>(null);
  // Registered sub-projects inherit trust from their parent; keep the gate and optimistic state
  // aligned with the same owner the backend checks before allowing Project Chat execution.
  const projectConfig = getProjectConfig(props.projectPath);
  const trustProjectPath = projectConfig?.parentProjectPath ?? props.projectPath;
  const trusted =
    getProjectConfig(trustProjectPath)?.trusted === true ||
    locallyTrustedProjectPath === trustProjectPath;
  const [loadState, setLoadState] = useState<ProjectChatLoadState>({ status: "loading" });

  useEffect(() => {
    let ignore = false;
    let registeredSessionId: string | null = null;
    setLoadState({ status: "loading" });

    const load = async () => {
      if (!api || projectsLoading || !trusted) {
        return;
      }

      try {
        const result = await api.projects.chat.getOrCreate({ projectPath: props.projectPath });
        if (ignore) {
          return;
        }
        if (!result.success) {
          setLoadState({ status: "error", message: result.error });
          return;
        }

        const info = result.data;
        registeredSessionId = info.sessionId;
        seedProjectChatAiSettings(info);
        workspaceStore.addAuxiliaryChat(info.metadata);
        workspaceStore.setActiveWorkspaceId(info.sessionId);
        setLoadState({ status: "ready", info });
      } catch (error) {
        if (!ignore) {
          setLoadState({ status: "error", message: getErrorMessage(error) });
        }
      }
    };

    void load();
    return () => {
      ignore = true;
      if (registeredSessionId) {
        workspaceStore.removeAuxiliaryChat(registeredSessionId);
      }
    };
  }, [api, projectsLoading, props.projectPath, reloadKey, trusted, workspaceStore]);

  if (projectsLoading) {
    return (
      <div className="bg-surface-primary flex flex-1 flex-col overflow-hidden">
        <ProjectChatHeader
          projectName={props.projectName}
          projectPath={props.projectPath}
          leftSidebarCollapsed={props.leftSidebarCollapsed}
          onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
        />
        <div className="flex flex-1 items-center justify-center" role="status">
          <div className="text-content-secondary text-sm">Opening Project Chat…</div>
        </div>
      </div>
    );
  }

  if (!trusted) {
    const trustPromptOpen = dismissedTrustProjectPath !== trustProjectPath;
    return (
      <div className="bg-surface-primary flex flex-1 flex-col overflow-hidden">
        <ProjectChatHeader
          projectName={props.projectName}
          projectPath={props.projectPath}
          leftSidebarCollapsed={props.leftSidebarCollapsed}
          onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
        />
        <div
          className="flex flex-1 items-center justify-center p-6"
          data-testid="project-chat-trust-gate"
        >
          <div className="border-border-light bg-background-secondary flex max-w-md flex-col items-center gap-3 rounded-lg border p-5 text-center">
            <AlertTriangle className="text-warning h-6 w-6" aria-hidden="true" />
            <div>
              <div className="text-content-primary font-medium">
                Trust this project to use Project Chat
              </div>
              <div className="text-content-secondary mt-1 text-sm">
                Project Chat may delegate work that executes repository scripts and Git hooks.
              </div>
              {trustError && <div className="text-error mt-2 text-sm">{trustError}</div>}
            </div>
            <Button
              variant="outline"
              onClick={() => {
                setTrustError(null);
                setDismissedTrustProjectPath(null);
              }}
            >
              Trust project
            </Button>
          </div>
        </div>
        <ConfirmationModal
          isOpen={trustPromptOpen}
          title="Trust this project?"
          description="Using Project Chat may execute repository scripts. Only trust projects from sources you trust."
          warning="This includes .mux/init, .mux/tool_env, .mux/tool_pre, .mux/tool_post, and git hooks."
          confirmLabel="Trust and continue"
          cancelLabel="Not now"
          confirmVariant="default"
          onConfirm={async () => {
            try {
              if (!api) throw new Error("API not available");
              await api.projects.setTrust({ projectPath: trustProjectPath, trusted: true });
              setLocallyTrustedProjectPath(trustProjectPath);
              setDismissedTrustProjectPath(null);
              setTrustError(null);
              refreshProjects().catch(() => {
                // Trust is already persisted; a later project refresh will reconcile the context.
              });
            } catch {
              setTrustError("Failed to trust project. Please try again.");
              setDismissedTrustProjectPath(trustProjectPath);
            }
          }}
          onCancel={() => setDismissedTrustProjectPath(trustProjectPath)}
        />
      </div>
    );
  }

  if (loadState.status === "loading") {
    return (
      <div className="bg-surface-primary flex flex-1 flex-col overflow-hidden">
        <ProjectChatHeader
          projectName={props.projectName}
          projectPath={props.projectPath}
          leftSidebarCollapsed={props.leftSidebarCollapsed}
          onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
        />
        <div className="flex flex-1 items-center justify-center" role="status">
          <div className="text-content-secondary text-sm">Opening Project Chat…</div>
        </div>
      </div>
    );
  }

  if (loadState.status === "error") {
    return (
      <div className="bg-surface-primary flex flex-1 flex-col overflow-hidden">
        <ProjectChatHeader
          projectName={props.projectName}
          projectPath={props.projectPath}
          leftSidebarCollapsed={props.leftSidebarCollapsed}
          onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
        />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="border-border-light bg-background-secondary flex max-w-md flex-col items-center gap-3 rounded-lg border p-5 text-center">
            <AlertTriangle className="text-warning h-6 w-6" aria-hidden="true" />
            <div>
              <div className="text-content-primary font-medium">Could not open Project Chat</div>
              <div className="text-content-secondary mt-1 text-sm">{loadState.message}</div>
            </div>
            <Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AIView
      workspaceId={loadState.info.sessionId}
      projectPath={props.projectPath}
      projectName={props.projectName}
      workspaceName="Project Chat"
      namedWorkspacePath={props.projectPath}
      runtimeConfig={{ type: "local" }}
      leftSidebarCollapsed={props.leftSidebarCollapsed}
      onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
      surface="project"
    />
  );
}
