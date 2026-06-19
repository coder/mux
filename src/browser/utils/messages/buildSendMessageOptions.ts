import type { SendMessageOptions } from "@/common/orpc/types";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { normalizeSelectedModel } from "@/common/utils/ai/models";

export interface ExperimentValues {
  programmaticToolCalling: boolean | undefined;
  programmaticToolCallingExclusive: boolean | undefined;
  advisorTool: boolean | undefined;
  execSubagentHardRestart: boolean | undefined;
  dynamicWorkflows: boolean | undefined;
  memory: boolean | undefined;
}

export interface SendMessageOptionsInput {
  model: string;
  thinkingLevel: ThinkingLevel;
  agentId: string;
  providerOptions: MuxProviderOptions;
  experiments: ExperimentValues;
  disableWorkspaceAgents?: boolean;
}

/** Normalize a preferred model string for routing while preserving explicit gateway choices. */
export function normalizeModelPreference(rawModel: unknown, fallbackModel: string): string {
  const trimmed =
    typeof rawModel === "string" && rawModel.trim().length > 0 ? rawModel.trim() : null;
  return normalizeSelectedModel(trimmed ?? fallbackModel);
}

/**
 * Construct SendMessageOptions from normalized inputs.
 * Single source of truth for the send-option shape — backend enforces per-model policy.
 */
export function buildSendMessageOptions(input: SendMessageOptionsInput): SendMessageOptions {
  return {
    thinkingLevel: input.thinkingLevel,
    model: input.model,
    agentId: input.agentId,
    providerOptions: input.providerOptions,
    experiments: { ...input.experiments },
    allowAgentSetGoal: true,
    disableWorkspaceAgents: input.disableWorkspaceAgents ? true : undefined,
  };
}
