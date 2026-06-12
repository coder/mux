import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";

export interface SlashCommandExperimentSnapshot {
  workspaceHeartbeats: boolean;
  dynamicWorkflows?: boolean;
  memoryConsolidation?: boolean;
}

export function resolveSlashCommandExperimentValue(
  experimentId: ExperimentId,
  snapshot: SlashCommandExperimentSnapshot
): boolean | undefined {
  switch (experimentId) {
    case EXPERIMENT_IDS.WORKSPACE_HEARTBEATS:
      return snapshot.workspaceHeartbeats;
    case EXPERIMENT_IDS.DYNAMIC_WORKFLOWS:
      return snapshot.dynamicWorkflows;
    case EXPERIMENT_IDS.MEMORY_CONSOLIDATION:
      return snapshot.memoryConsolidation;
    default:
      return undefined;
  }
}
