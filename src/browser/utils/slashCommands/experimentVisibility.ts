import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";

export interface SlashCommandExperimentSnapshot {
  goals: boolean;
  workspaceHeartbeats: boolean;
}

export function resolveSlashCommandExperimentValue(
  experimentId: ExperimentId,
  snapshot: SlashCommandExperimentSnapshot
): boolean | undefined {
  switch (experimentId) {
    case EXPERIMENT_IDS.GOALS:
      return snapshot.goals;
    case EXPERIMENT_IDS.WORKSPACE_HEARTBEATS:
      return snapshot.workspaceHeartbeats;
    default:
      return undefined;
  }
}
