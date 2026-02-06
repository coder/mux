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

/** Normalize a preferred model string for routing (gateway migration + trimming). */
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
 * Single source of truth for the send-option shape — backend enforces per-model policy.
 */
export function buildSendMessageOptions(input: SendMessageOptionsInput): SendMessageOptions {
  const system1Model = input.system1Model ? migrateGatewayModel(input.system1Model) : undefined;
  const system1ThinkingLevel =
    input.system1ThinkingLevel && input.system1ThinkingLevel !== "off"
      ? input.system1ThinkingLevel
      : undefined;

  return {
    thinkingLevel: input.thinkingLevel,
    model: input.model,
    ...(system1Model && { system1Model }),
    ...(system1ThinkingLevel && { system1ThinkingLevel }),
    agentId: input.agentId,
    providerOptions: input.providerOptions,
    experiments: { ...input.experiments },
    disableWorkspaceAgents: input.disableWorkspaceAgents ? true : undefined,
  };
}
