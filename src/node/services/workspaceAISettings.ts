import type { z } from "zod";
import type { Config } from "@/node/config";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { log } from "@/node/services/log";
import { isValidModelFormat, normalizeGatewayModel } from "@/common/utils/ai/models";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { getErrorMessage } from "@/common/utils/errors";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceAISettingsSchema } from "@/common/orpc/schemas";

type WorkspaceAISettings = z.infer<typeof WorkspaceAISettingsSchema>;

/**
 * Validate + normalize model/thinking settings.
 */
export function normalizeWorkspaceAISettings(
  aiSettings: WorkspaceAISettings
): Result<WorkspaceAISettings, string> {
  const rawModel = aiSettings.model;
  const model = normalizeGatewayModel(rawModel).trim();
  if (!model) {
    return Err("Model is required");
  }
  if (!isValidModelFormat(model)) {
    return Err(`Invalid model format: ${rawModel}`);
  }

  return Ok({
    model,
    thinkingLevel: aiSettings.thinkingLevel,
  });
}

/**
 * Normalize agentId in send message options.
 */
export function normalizeSendMessageAgentId(options: SendMessageOptions): SendMessageOptions {
  // agentId is required by the schema, so this just normalizes the value.
  const rawAgentId = options.agentId;
  const normalizedAgentId =
    typeof rawAgentId === "string" && rawAgentId.trim().length > 0
      ? rawAgentId.trim().toLowerCase()
      : WORKSPACE_DEFAULTS.agentId;

  if (normalizedAgentId === options.agentId) {
    return options;
  }

  return {
    ...options,
    agentId: normalizedAgentId,
  };
}

/**
 * Extract AI settings from send message options, returning null if
 * the options don't contain valid model + thinking level.
 */
export function extractWorkspaceAISettingsFromSendOptions(
  options: SendMessageOptions | undefined
): WorkspaceAISettings | null {
  const rawModel = options?.model;
  if (typeof rawModel !== "string" || rawModel.trim().length === 0) {
    return null;
  }

  const model = normalizeGatewayModel(rawModel).trim();
  if (!isValidModelFormat(model)) {
    return null;
  }

  const requestedThinking = options?.thinkingLevel;
  // Be defensive: if a (very) old client doesn't send thinkingLevel, don't overwrite
  // any existing workspace-scoped value.
  if (requestedThinking === undefined) {
    return null;
  }

  const thinkingLevel = requestedThinking;

  return { model, thinkingLevel };
}

/** Callback to emit updated workspace metadata after persistence. */
export type EmitMetadataFn = (
  workspaceId: string,
  metadata: FrontendWorkspaceMetadata | null
) => void;

/**
 * Persist AI settings for a specific agent within a workspace's config.
 * Pure config mutation — uses the provided Config instance and emitMetadata callback.
 */
export async function persistWorkspaceAISettingsForAgent(
  config: Config,
  emitMetadata: EmitMetadataFn,
  workspaceId: string,
  agentId: string,
  aiSettings: WorkspaceAISettings,
  options?: { emitMetadata?: boolean }
): Promise<Result<boolean, string>> {
  const found = config.findWorkspace(workspaceId);
  if (!found) {
    return Err("Workspace not found");
  }

  const { projectPath, workspacePath } = found;

  const projectsConfig = config.loadConfigOrDefault();
  const projectConfig = projectsConfig.projects.get(projectPath);
  if (!projectConfig) {
    return Err(`Project not found: ${projectPath}`);
  }

  const workspaceEntry = projectConfig.workspaces.find((w) => w.id === workspaceId);
  const workspaceEntryWithFallback =
    workspaceEntry ?? projectConfig.workspaces.find((w) => w.path === workspacePath);
  if (!workspaceEntryWithFallback) {
    return Err("Workspace not found");
  }

  const normalizedAgentId = agentId.trim().toLowerCase();
  if (!normalizedAgentId) {
    return Err("Agent ID is required");
  }

  const prev = workspaceEntryWithFallback.aiSettingsByAgent?.[normalizedAgentId];
  const changed =
    prev?.model !== aiSettings.model || prev?.thinkingLevel !== aiSettings.thinkingLevel;
  if (!changed) {
    return Ok(false);
  }

  workspaceEntryWithFallback.aiSettingsByAgent = {
    ...(workspaceEntryWithFallback.aiSettingsByAgent ?? {}),
    [normalizedAgentId]: aiSettings,
  };

  await config.saveConfig(projectsConfig);

  if (options?.emitMetadata !== false) {
    const allMetadata = await config.getAllWorkspaceMetadata();
    const updatedMetadata = allMetadata.find((m) => m.id === workspaceId) ?? null;
    emitMetadata(workspaceId, updatedMetadata);
  }

  return Ok(true);
}

/**
 * Best-effort persist AI settings from send/resume options.
 * Skips requests explicitly marked to avoid persistence.
 */
export async function maybePersistAISettingsFromOptions(
  config: Config,
  emitMetadata: EmitMetadataFn,
  workspaceId: string,
  options: SendMessageOptions | undefined,
  context: "send" | "resume"
): Promise<void> {
  if (options?.skipAiSettingsPersistence) {
    // One-shot/compaction sends shouldn't overwrite workspace defaults.
    return;
  }

  const extractedSettings = extractWorkspaceAISettingsFromSendOptions(options);
  if (!extractedSettings) return;

  const rawAgentId = options?.agentId;
  const agentId =
    typeof rawAgentId === "string" && rawAgentId.trim().length > 0
      ? rawAgentId.trim().toLowerCase()
      : WORKSPACE_DEFAULTS.agentId;

  const persistResult = await persistWorkspaceAISettingsForAgent(
    config,
    emitMetadata,
    workspaceId,
    agentId,
    extractedSettings,
    {
      emitMetadata: false,
    }
  );
  if (!persistResult.success) {
    log.debug(`Failed to persist workspace AI settings from ${context} options`, {
      workspaceId,
      error: persistResult.error,
    });
  }
}

/**
 * Validate, normalize, and persist AI settings for an agent.
 * Wraps normalizeWorkspaceAISettings + persistWorkspaceAISettingsForAgent.
 */
export async function updateAgentAISettings(
  config: Config,
  emitMetadata: EmitMetadataFn,
  workspaceId: string,
  agentId: string,
  aiSettings: WorkspaceAISettings
): Promise<Result<void, string>> {
  try {
    const normalized = normalizeWorkspaceAISettings(aiSettings);
    if (!normalized.success) {
      return Err(normalized.error);
    }

    const persistResult = await persistWorkspaceAISettingsForAgent(
      config,
      emitMetadata,
      workspaceId,
      agentId,
      normalized.data,
      {
        emitMetadata: true,
      }
    );
    if (!persistResult.success) {
      return Err(persistResult.error);
    }

    return Ok(undefined);
  } catch (error) {
    const message = getErrorMessage(error);
    return Err(`Failed to update workspace AI settings: ${message}`);
  }
}
