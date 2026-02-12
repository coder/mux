import React, { useEffect, useState, useSyncExternalStore } from "react";
import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceStoreRaw, type WorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { getDisableWorkspaceAgentsKey } from "@/common/constants/storage";
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";
import { SkillIndicator } from "./SkillIndicator";

interface ActiveProjectSkillIndicatorProps {
  /** When a real workspace is selected, pass its ID for workspace-scoped discovery. */
  workspaceId?: string;
  /** Project path for drafts (no workspace yet) and workspace-based discovery fallbacks. */
  projectPath: string;
}

const EMPTY_SIDEBAR_STATE: WorkspaceSidebarState = {
  canInterrupt: false,
  isStarting: false,
  awaitingUserQuestion: false,
  currentModel: null,
  recencyTimestamp: null,
  loadedSkills: [],
  skillLoadErrors: [],
  agentStatus: undefined,
};

function useOptionalWorkspaceSidebarState(workspaceId?: string): WorkspaceSidebarState {
  const store = useWorkspaceStoreRaw();
  return useSyncExternalStore(
    (listener) => (workspaceId ? store.subscribeKey(workspaceId, listener) : () => undefined),
    () => (workspaceId ? store.getWorkspaceSidebarState(workspaceId) : EMPTY_SIDEBAR_STATE)
  );
}

export const ActiveProjectSkillIndicator: React.FC<ActiveProjectSkillIndicatorProps> = (props) => {
  const { api } = useAPI();
  // Read persisted state directly because the sidebar is not wrapped in AgentProvider.
  const [disableWorkspaceAgents] = usePersistedState<boolean>(
    getDisableWorkspaceAgentsKey(props.workspaceId ?? props.projectPath),
    false,
    { listener: true }
  );
  const { loadedSkills, skillLoadErrors } = useOptionalWorkspaceSidebarState(props.workspaceId);
  const [availableSkills, setAvailableSkills] = useState<AgentSkillDescriptor[]>([]);
  const [invalidSkills, setInvalidSkills] = useState<AgentSkillIssue[]>([]);

  // Fetch available skills + diagnostics for the active workspace's project row.
  // Keep prior results during transitions to avoid flashing the indicator.
  useEffect(() => {
    if (!api) {
      setAvailableSkills([]);
      setInvalidSkills([]);
      return;
    }

    let isMounted = true;

    const loadSkills = async () => {
      try {
        const diagnostics = await api.agentSkills.listDiagnostics({
          workspaceId: props.workspaceId,
          projectPath: props.workspaceId ? undefined : props.projectPath,
          disableWorkspaceAgents: props.workspaceId
            ? disableWorkspaceAgents || undefined
            : undefined,
        });
        if (!isMounted) return;
        setAvailableSkills(Array.isArray(diagnostics.skills) ? diagnostics.skills : []);
        setInvalidSkills(Array.isArray(diagnostics.invalidSkills) ? diagnostics.invalidSkills : []);
      } catch (error) {
        console.error("Failed to load available skills:", error);
        if (isMounted) {
          setAvailableSkills([]);
          setInvalidSkills([]);
        }
      }
    };

    void loadSkills();

    return () => {
      isMounted = false;
    };
  }, [api, props.workspaceId, props.projectPath, disableWorkspaceAgents]);

  const shouldRender =
    availableSkills.length > 0 || invalidSkills.length > 0 || skillLoadErrors.length > 0;

  if (!shouldRender) {
    return null;
  }

  return (
    <div
      className="mr-1 flex shrink-0"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <SkillIndicator
        loadedSkills={loadedSkills}
        availableSkills={availableSkills}
        invalidSkills={invalidSkills}
        skillLoadErrors={skillLoadErrors}
      />
    </div>
  );
};
