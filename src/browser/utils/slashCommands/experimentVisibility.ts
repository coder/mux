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

/**
 * Build the `isExperimentEnabled` predicate consumed by slash-command
 * discovery surfaces (suggestions, ghost hints, command palette). Each
 * surface previously inlined the same `(experimentId) =>
 * resolveSlashCommandExperimentValue(experimentId, snapshot)` lambda; this
 * helper keeps the resolver wiring in one place so callsites only describe
 * the snapshot they observe.
 */
export function createSlashCommandExperimentResolver(
  snapshot: SlashCommandExperimentSnapshot
): (experimentId: ExperimentId) => boolean | undefined {
  return (experimentId) => resolveSlashCommandExperimentValue(experimentId, snapshot);
}
