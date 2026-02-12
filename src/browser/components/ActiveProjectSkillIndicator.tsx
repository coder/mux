import React, { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useAgent } from "@/browser/contexts/AgentContext";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";
import { SkillIndicator } from "./SkillIndicator";

interface ActiveProjectSkillIndicatorProps {
  workspaceId: string;
}

export const ActiveProjectSkillIndicator: React.FC<ActiveProjectSkillIndicatorProps> = (props) => {
  const { api } = useAPI();
  const { disableWorkspaceAgents } = useAgent();
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
