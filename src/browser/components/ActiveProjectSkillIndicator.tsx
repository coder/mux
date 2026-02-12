import React, { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { getDisableWorkspaceAgentsKey } from "@/common/constants/storage";
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";
import { SkillIndicator } from "./SkillIndicator";

interface ActiveProjectSkillIndicatorProps {
  /** When a real workspace is selected, pass its ID for workspace-scoped discovery. */
  workspaceId?: string;
  /** Project path for drafts (no workspace yet) and workspace-based discovery fallbacks. */
  projectPath: string;
}

export const ActiveProjectSkillIndicator: React.FC<ActiveProjectSkillIndicatorProps> = (props) => {
  if (props.workspaceId) {
    return <WorkspaceSkillIndicator workspaceId={props.workspaceId} />;
  }

  return <DraftProjectSkillIndicator projectPath={props.projectPath} />;
};

interface WorkspaceSkillIndicatorProps {
  workspaceId: string;
}

const WorkspaceSkillIndicator: React.FC<WorkspaceSkillIndicatorProps> = (props) => {
  const { api } = useAPI();
  // Read persisted state directly because the sidebar is not wrapped in AgentProvider.
  const [disableWorkspaceAgents] = usePersistedState<boolean>(
    getDisableWorkspaceAgentsKey(props.workspaceId),
    false,
    { listener: true }
  );
  const { loadedSkills, skillLoadErrors } = useWorkspaceSidebarState(props.workspaceId);
  const [availableSkills, setAvailableSkills] = useState<AgentSkillDescriptor[]>([]);
  const [invalidSkills, setInvalidSkills] = useState<AgentSkillIssue[]>([]);

  // Fetch available skills + diagnostics for the active workspace's project row.
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
          disableWorkspaceAgents: disableWorkspaceAgents || undefined,
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
  }, [api, props.workspaceId, disableWorkspaceAgents]);

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

interface DraftProjectSkillIndicatorProps {
  projectPath: string;
}

const DraftProjectSkillIndicator: React.FC<DraftProjectSkillIndicatorProps> = (props) => {
  const { api } = useAPI();
  const [availableSkills, setAvailableSkills] = useState<AgentSkillDescriptor[]>([]);
  const [invalidSkills, setInvalidSkills] = useState<AgentSkillIssue[]>([]);

  // Drafts have no workspace yet, so discover skills directly from the project path.
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
          projectPath: props.projectPath,
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
  }, [api, props.projectPath]);

  const shouldRender = availableSkills.length > 0 || invalidSkills.length > 0;

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
        loadedSkills={[]}
        availableSkills={availableSkills}
        invalidSkills={invalidSkills}
        skillLoadErrors={[]}
      />
    </div>
  );
};
