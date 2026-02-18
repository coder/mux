import assert from "node:assert/strict";
import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";
import { getThinkingOptionLabel, isThinkingLevel } from "@/common/types/thinking";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { getBuiltInAgentDefinitions } from "@/node/services/agentDefinitions/builtInAgentDefinitions";
import type { ORPCClient } from "./serverConnection";
import { resolveAgentAiSettings, type ResolvedAiSettings } from "./resolveAgentAiSettings";

export const AGENT_MODE_CONFIG_ID = "agentMode";
const MODEL_CONFIG_ID = "model";
const THINKING_LEVEL_CONFIG_ID = "thinkingLevel";

const ORDERED_AGENT_MODE_IDS = ["exec", "ask", "plan"] as const;
type AgentModeId = (typeof ORDERED_AGENT_MODE_IDS)[number];

const DEFAULT_AGENT_MODE_METADATA: Readonly<
  Record<AgentModeId, { label: string; description: string }>
> = {
  exec: {
    label: "Exec",
    description: "Implement changes in the repository",
  },
  ask: {
    label: "Ask",
    description: "Delegate questions to Explore sub-agents and synthesize an answer.",
  },
  plan: {
    label: "Plan",
    description: "Create a plan before coding",
  },
};

interface ExposedAgentMode {
  value: AgentModeId;
  label: string;
  description: string;
}

function isUiSelectableAgentMode(frontmatter: AgentDefinitionFrontmatter): boolean {
  if (frontmatter.disabled === true || frontmatter.ui?.disabled === true) {
    return false;
  }

  if (frontmatter.ui?.hidden != null) {
    return !frontmatter.ui.hidden;
  }

  if (frontmatter.ui?.selectable != null) {
    return frontmatter.ui.selectable;
  }

  return true;
}

function resolveExposedAgentModes(): ExposedAgentMode[] {
  const builtInFrontmatterById = new Map(
    getBuiltInAgentDefinitions().map((agent) => [agent.id, agent.frontmatter])
  );

  return ORDERED_AGENT_MODE_IDS.flatMap((modeId) => {
    const fallback = DEFAULT_AGENT_MODE_METADATA[modeId];
    const frontmatter = builtInFrontmatterById.get(modeId);

    if (frontmatter == null) {
      return [
        {
          value: modeId,
          label: fallback.label,
          description: fallback.description,
        },
      ];
    }

    if (!isUiSelectableAgentMode(frontmatter)) {
      return [];
    }

    return [
      {
        value: modeId,
        label: frontmatter.name,
        description: frontmatter.description ?? fallback.description,
      },
    ];
  });
}

const EXPOSED_AGENT_MODES = resolveExposedAgentModes();

type WorkspaceInfo = NonNullable<Awaited<ReturnType<ORPCClient["workspace"]["getInfo"]>>>;
type UpdateAgentAiSettingsResult = Awaited<
  ReturnType<ORPCClient["workspace"]["updateAgentAISettings"]>
>;

interface BuildConfigOptionsArgs {
  activeAgentId?: string;
}

interface HandleSetConfigOptionArgs {
  activeAgentId?: string;
  onAgentModeChanged?: (agentId: string, aiSettings: ResolvedAiSettings) => Promise<void> | void;
}

function isModeAgentId(agentId: string): agentId is "plan" | "exec" {
  return agentId === "plan" || agentId === "exec";
}

function ensureUpdateSucceeded(result: UpdateAgentAiSettingsResult, operation: string): void {
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
    return {
      model: workspaceAiSettings.model,
      thinkingLevel: enforceThinkingPolicy(
        workspaceAiSettings.model,
        workspaceAiSettings.thinkingLevel
      ),
    };
  }

  const resolvedDefaults = await resolveAgentAiSettings(client, agentId, workspaceId);
  return {
    model: resolvedDefaults.model,
    thinkingLevel: enforceThinkingPolicy(resolvedDefaults.model, resolvedDefaults.thinkingLevel),
  };
}

function buildAgentModeSelectOptions(currentAgentId: string): SessionConfigSelectOption[] {
  const options: SessionConfigSelectOption[] = EXPOSED_AGENT_MODES.map((mode) => ({
    value: mode.value,
    name: mode.label,
    description: mode.description,
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

function buildThinkingLevelSelectOptions(modelString: string): SessionConfigSelectOption[] {
  const allowedThinkingLevels = getThinkingPolicyForModel(modelString);

  return allowedThinkingLevels.map((level) => ({
    value: level,
    name: getThinkingOptionLabel(level, modelString),
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
  workspaceId: string,
  args?: BuildConfigOptionsArgs
): Promise<SessionConfigOption[]> {
  assert(workspaceId.trim().length > 0, "buildConfigOptions: workspaceId must be non-empty");

  const workspace = await getWorkspaceInfoOrThrow(client, workspaceId);
  const overrideAgentId = args?.activeAgentId?.trim();
  const currentAgentId =
    typeof overrideAgentId === "string" && overrideAgentId.length > 0
      ? overrideAgentId
      : getCurrentAgentId(workspace);
  const currentAiSettings = await resolveCurrentAiSettings(
    client,
    workspace,
    workspaceId,
    currentAgentId
  );

  const effectiveThinkingLevel = enforceThinkingPolicy(
    currentAiSettings.model,
    currentAiSettings.thinkingLevel
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
      currentValue: effectiveThinkingLevel,
      options: buildThinkingLevelSelectOptions(currentAiSettings.model),
    },
  ];

  return configOptions;
}

export async function handleSetConfigOption(
  client: ORPCClient,
  workspaceId: string,
  configId: string,
  value: string,
  args?: HandleSetConfigOptionArgs
): Promise<SessionConfigOption[]> {
  const trimmedWorkspaceId = workspaceId.trim();
  const trimmedConfigId = configId.trim();
  const trimmedValue = value.trim();

  assert(trimmedWorkspaceId.length > 0, "handleSetConfigOption: workspaceId must be non-empty");
  assert(trimmedConfigId.length > 0, "handleSetConfigOption: configId must be non-empty");
  assert(trimmedValue.length > 0, "handleSetConfigOption: value must be non-empty");

  const workspace = await getWorkspaceInfoOrThrow(client, trimmedWorkspaceId);
  const overrideAgentId = args?.activeAgentId?.trim();
  const currentAgentId =
    typeof overrideAgentId === "string" && overrideAgentId.length > 0
      ? overrideAgentId
      : getCurrentAgentId(workspace);

  if (trimmedConfigId === AGENT_MODE_CONFIG_ID) {
    const nextAgentId = trimmedValue;

    // Prefer workspace-specific settings already saved for the target agent
    // (e.g., user customized model/thinking for this mode).  Only fall back
    // to resolved defaults when no prior settings exist for the agent.
    const existingSettings = workspace.aiSettingsByAgent?.[nextAgentId];
    const resolvedAiSettings =
      existingSettings?.model != null && existingSettings?.thinkingLevel != null
        ? { model: existingSettings.model, thinkingLevel: existingSettings.thinkingLevel }
        : await resolveAgentAiSettings(client, nextAgentId, trimmedWorkspaceId);

    const normalizedAiSettings: ResolvedAiSettings = {
      model: resolvedAiSettings.model,
      thinkingLevel: enforceThinkingPolicy(
        resolvedAiSettings.model,
        resolvedAiSettings.thinkingLevel
      ),
    };

    await persistAgentAiSettings(client, trimmedWorkspaceId, nextAgentId, normalizedAiSettings);
    if (args?.onAgentModeChanged != null) {
      await args.onAgentModeChanged(nextAgentId, normalizedAiSettings);
    }

    return buildConfigOptions(client, trimmedWorkspaceId, { activeAgentId: nextAgentId });
  }

  const currentAiSettings = await resolveCurrentAiSettings(
    client,
    workspace,
    trimmedWorkspaceId,
    currentAgentId
  );

  if (trimmedConfigId === MODEL_CONFIG_ID) {
    const clampedThinkingLevel = enforceThinkingPolicy(
      trimmedValue,
      currentAiSettings.thinkingLevel
    );

    await persistAgentAiSettings(client, trimmedWorkspaceId, currentAgentId, {
      model: trimmedValue,
      thinkingLevel: clampedThinkingLevel,
    });

    return buildConfigOptions(client, trimmedWorkspaceId, { activeAgentId: currentAgentId });
  }

  if (trimmedConfigId === THINKING_LEVEL_CONFIG_ID) {
    if (!isThinkingLevel(trimmedValue)) {
      throw new Error(
        `handleSetConfigOption: value must be a valid ThinkingLevel, got '${trimmedValue}'`
      );
    }

    const clampedThinkingLevel = enforceThinkingPolicy(currentAiSettings.model, trimmedValue);

    await persistAgentAiSettings(client, trimmedWorkspaceId, currentAgentId, {
      model: currentAiSettings.model,
      thinkingLevel: clampedThinkingLevel,
    });

    return buildConfigOptions(client, trimmedWorkspaceId, { activeAgentId: currentAgentId });
  }

  throw new Error(`Unsupported config option id '${trimmedConfigId}'`);
}
