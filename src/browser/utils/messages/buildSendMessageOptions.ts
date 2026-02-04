import type { SendMessageOptions } from "@/common/orpc/types";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import { coerceThinkingLevel } from "@/common/types/thinking";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";

export interface ExperimentValues {
  programmaticToolCalling: boolean | undefined;
  programmaticToolCallingExclusive: boolean | undefined;
  system1: boolean | undefined;
  execSubagentHardRestart: boolean | undefined;
}

export interface SendMessageOptionsInput {
  model: string;
  thinkingLevel: ThinkingLevel;
  agentId: string;
  providerOptions: MuxProviderOptions;
  experiments: ExperimentValues;
  system1Model?: string;
  system1ThinkingLevel?: ThinkingLevel;
  disableWorkspaceAgents?: boolean;
}

/**
 * Normalize a preferred model string for routing.
 *
 * Shared by hook and non-hook send option builders to keep gateway migration
 * and trimming consistent across send paths.
 */
export function normalizeModelPreference(rawModel: unknown, fallbackModel: string): string {
  const trimmed =
    typeof rawModel === "string" && rawModel.trim().length > 0 ? rawModel.trim() : null;
  return migrateGatewayModel(trimmed ?? fallbackModel);
}

export function normalizeSystem1Model(rawModel: unknown): string | undefined {
  if (typeof rawModel !== "string") return undefined;
  const trimmed = rawModel.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeSystem1ThinkingLevel(rawLevel: unknown): ThinkingLevel {
  return coerceThinkingLevel(rawLevel) ?? "off";
}

/**
 * Construct SendMessageOptions from normalized inputs.
 * Keeps the core send option shape in one place to reduce drift.
 */
export function buildSendMessageOptions(input: SendMessageOptionsInput): SendMessageOptions {
  // Preserve the user's preferred thinking level; backend enforces per-model policy.
  const uiThinking = input.thinkingLevel;

  const system1ModelForBackend =
    input.system1Model !== undefined ? migrateGatewayModel(input.system1Model) : undefined;

  const system1ThinkingLevelForBackend =
    input.system1ThinkingLevel !== undefined && input.system1ThinkingLevel !== "off"
      ? input.system1ThinkingLevel
      : undefined;

  return {
    thinkingLevel: uiThinking,
    model: input.model,
    ...(system1ModelForBackend ? { system1Model: system1ModelForBackend } : {}),
    ...(system1ThinkingLevelForBackend
      ? { system1ThinkingLevel: system1ThinkingLevelForBackend }
      : {}),
    agentId: input.agentId,
    // toolPolicy is computed by backend from agent definitions (resolveToolPolicyForAgent)
    providerOptions: input.providerOptions,
    experiments: {
      programmaticToolCalling: input.experiments.programmaticToolCalling,
      programmaticToolCallingExclusive: input.experiments.programmaticToolCallingExclusive,
      system1: input.experiments.system1,
      execSubagentHardRestart: input.experiments.execSubagentHardRestart,
    },
    disableWorkspaceAgents: input.disableWorkspaceAgents ? true : undefined,
  };
}
