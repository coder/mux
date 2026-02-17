import assert from "node:assert/strict";
import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { THINKING_LEVELS, isThinkingLevel } from "@/common/types/thinking";
import type { ORPCClient } from "./serverConnection";
import { resolveAgentAiSettings, type ResolvedAiSettings } from "./resolveAgentAiSettings";

const AGENT_MODE_CONFIG_ID = "agentMode";
const MODEL_CONFIG_ID = "model";
const THINKING_LEVEL_CONFIG_ID = "thinkingLevel";

const EXPOSED_AGENT_MODES = [
  { value: "exec", label: "Exec" },
  { value: "ask", label: "Ask" },
  { value: "plan", label: "Plan" },
] as const;

type WorkspaceInfo = NonNullable<Awaited<ReturnType<ORPCClient["workspace"]["getInfo"]>>>;
type UpdateAgentAiSettingsResult = Awaited<
  ReturnType<ORPCClient["workspace"]["updateAgentAISettings"]>
>;
type UpdateModeAiSettingsResult = Awaited<
  ReturnType<ORPCClient["workspace"]["updateModeAISettings"]>
>;

function isModeAgentId(agentId: string): agentId is "plan" | "exec" {
  return agentId === "plan" || agentId === "exec";
}

function ensureUpdateSucceeded(
  result: UpdateAgentAiSettingsResult | UpdateModeAiSettingsResult,
  operation: string
): void {
  if (!result.success) {
    throw new Error(`${operation} failed: ${result.error}`);
  }
}

async function getWorkspaceInfoOrThrow(
  client: ORPCClient,
  workspaceId: string
): Promise<WorkspaceInfo> {
  const workspace = await client.workspace.getInfo({ workspaceId });
  if (!workspace) {
    throw new Error(`Workspace '${workspaceId}' was not found`);
  }

  return workspace;
}

function getCurrentAgentId(workspace: WorkspaceInfo): string {
  return workspace.agentId ?? "exec";
}

async function resolveCurrentAiSettings(
  client: ORPCClient,
  workspace: WorkspaceInfo,
  workspaceId: string,
  agentId: string
): Promise<ResolvedAiSettings> {
  const workspaceAiSettings = workspace.aiSettingsByAgent?.[agentId] ?? workspace.aiSettings;
  if (workspaceAiSettings) {
    return workspaceAiSettings;
  }

  return resolveAgentAiSettings(client, agentId, workspaceId);
}

function buildAgentModeSelectOptions(currentAgentId: string): SessionConfigSelectOption[] {
  const options: SessionConfigSelectOption[] = EXPOSED_AGENT_MODES.map((mode) => ({
    value: mode.value,
    name: mode.label,
  }));

  if (!options.some((option) => option.value === currentAgentId)) {
    options.unshift({ value: currentAgentId, name: currentAgentId });
  }

  return options;
}

function buildModelSelectOptions(currentModel: string): SessionConfigSelectOption[] {
  const options: SessionConfigSelectOption[] = Object.values(KNOWN_MODELS).map((model) => ({
    value: model.id,
    name: model.id,
  }));

  if (!options.some((option) => option.value === currentModel)) {
    options.unshift({ value: currentModel, name: currentModel });
  }

  return options;
}

function buildThinkingLevelSelectOptions(): SessionConfigSelectOption[] {
  return THINKING_LEVELS.map((level) => ({
    value: level,
    name: level,
  }));
}

async function persistAgentAiSettings(
  client: ORPCClient,
  workspaceId: string,
  agentId: string,
  aiSettings: ResolvedAiSettings
): Promise<void> {
  if (isModeAgentId(agentId)) {
    const updateModeResult = await client.workspace.updateModeAISettings({
      workspaceId,
      mode: agentId,
      aiSettings,
    });
    ensureUpdateSucceeded(updateModeResult, "workspace.updateModeAISettings");
    return;
  }

  const updateAgentResult = await client.workspace.updateAgentAISettings({
    workspaceId,
    agentId,
    aiSettings,
  });
  ensureUpdateSucceeded(updateAgentResult, "workspace.updateAgentAISettings");
}

export async function buildConfigOptions(
  client: ORPCClient,
  workspaceId: string
): Promise<SessionConfigOption[]> {
  assert(workspaceId.trim().length > 0, "buildConfigOptions: workspaceId must be non-empty");

  const workspace = await getWorkspaceInfoOrThrow(client, workspaceId);
  const currentAgentId = getCurrentAgentId(workspace);
  const currentAiSettings = await resolveCurrentAiSettings(
    client,
    workspace,
    workspaceId,
    currentAgentId
  );

  const configOptions: SessionConfigOption[] = [
    {
      id: AGENT_MODE_CONFIG_ID,
      name: "Agent Mode",
      type: "select",
      category: "mode",
      currentValue: currentAgentId,
      options: buildAgentModeSelectOptions(currentAgentId),
    },
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      type: "select",
      category: "model",
      currentValue: currentAiSettings.model,
      options: buildModelSelectOptions(currentAiSettings.model),
    },
    {
      id: THINKING_LEVEL_CONFIG_ID,
      name: "Thinking Level",
      type: "select",
      category: "thought_level",
      currentValue: currentAiSettings.thinkingLevel,
      options: buildThinkingLevelSelectOptions(),
    },
  ];

  return configOptions;
}

export async function handleSetConfigOption(
  client: ORPCClient,
  workspaceId: string,
  configId: string,
  value: string
): Promise<SessionConfigOption[]> {
  const trimmedWorkspaceId = workspaceId.trim();
  const trimmedConfigId = configId.trim();
  const trimmedValue = value.trim();

  assert(trimmedWorkspaceId.length > 0, "handleSetConfigOption: workspaceId must be non-empty");
  assert(trimmedConfigId.length > 0, "handleSetConfigOption: configId must be non-empty");
  assert(trimmedValue.length > 0, "handleSetConfigOption: value must be non-empty");

  const workspace = await getWorkspaceInfoOrThrow(client, trimmedWorkspaceId);
  const currentAgentId = getCurrentAgentId(workspace);

  if (trimmedConfigId === AGENT_MODE_CONFIG_ID) {
    const nextAgentId = trimmedValue;
    const resolvedAiSettings = await resolveAgentAiSettings(
      client,
      nextAgentId,
      trimmedWorkspaceId
    );

    await persistAgentAiSettings(client, trimmedWorkspaceId, nextAgentId, resolvedAiSettings);
    return buildConfigOptions(client, trimmedWorkspaceId);
  }

  const currentAiSettings = await resolveCurrentAiSettings(
    client,
    workspace,
    trimmedWorkspaceId,
    currentAgentId
  );

  if (trimmedConfigId === MODEL_CONFIG_ID) {
    await persistAgentAiSettings(client, trimmedWorkspaceId, currentAgentId, {
      model: trimmedValue,
      thinkingLevel: currentAiSettings.thinkingLevel,
    });

    return buildConfigOptions(client, trimmedWorkspaceId);
  }

  if (trimmedConfigId === THINKING_LEVEL_CONFIG_ID) {
    if (!isThinkingLevel(trimmedValue)) {
      throw new Error(
        `handleSetConfigOption: value must be a valid ThinkingLevel, got '${trimmedValue}'`
      );
    }

    await persistAgentAiSettings(client, trimmedWorkspaceId, currentAgentId, {
      model: currentAiSettings.model,
      thinkingLevel: trimmedValue,
    });

    return buildConfigOptions(client, trimmedWorkspaceId);
  }

  throw new Error(`Unsupported config option id '${trimmedConfigId}'`);
}
