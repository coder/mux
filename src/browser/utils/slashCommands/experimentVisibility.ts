import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";

export interface SlashCommandExperimentSnapshot {
  workspaceHeartbeats: boolean;
}

export function resolveSlashCommandExperimentValue(
  experimentId: ExperimentId,
  snapshot: SlashCommandExperimentSnapshot
): boolean | undefined {
  switch (experimentId) {
    case EXPERIMENT_IDS.WORKSPACE_HEARTBEATS:
      return snapshot.workspaceHeartbeats;
    default:
      return undefined;
  }
}
