import assert from "node:assert/strict";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { ORPCClient } from "./serverConnection";

export interface ResolvedAiSettings {
  model: string;
  thinkingLevel: ThinkingLevel;
}

const DEFAULT_PLAN_AGENT_ID = "plan";
const DEFAULT_EXEC_AGENT_ID = "exec";
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "off";

function getFallbackBaseAgentId(agentId: string): string {
  return agentId === DEFAULT_PLAN_AGENT_ID ? DEFAULT_PLAN_AGENT_ID : DEFAULT_EXEC_AGENT_ID;
}

function resolveInheritedConfigDefaults(
  agentId: string,
  agentDefsById: ReadonlyMap<string, { base?: string }>,
  agentAiDefaults: Record<string, { modelString?: string; thinkingLevel?: ThinkingLevel }>
): { modelString?: string; thinkingLevel?: ThinkingLevel } | undefined {
  const visited = new Set<string>([agentId]);
  let cursor = agentId;

  while (true) {
    const baseAgentId = agentDefsById.get(cursor)?.base ?? getFallbackBaseAgentId(cursor);
    if (baseAgentId === cursor || visited.has(baseAgentId)) {
      return undefined;
    }

    const inheritedDefaults = agentAiDefaults[baseAgentId];
    if (inheritedDefaults) {
      return inheritedDefaults;
    }

    visited.add(baseAgentId);
    cursor = baseAgentId;
  }
}

function buildAgentsListInput(
  workspaceId?: string
):
  | { workspaceId: string; includeDisabled: boolean }
  | { projectPath: string; includeDisabled: boolean } {
  const trimmedWorkspaceId = workspaceId?.trim();
  if (trimmedWorkspaceId) {
    return { workspaceId: trimmedWorkspaceId, includeDisabled: true };
  }

  // Fallback for callers that do not have workspace context yet.
  return { projectPath: process.cwd(), includeDisabled: true };
}

export async function resolveAgentAiSettings(
  client: ORPCClient,
  agentId: string,
  workspaceId?: string
): Promise<ResolvedAiSettings> {
  const trimmedAgentId = agentId.trim();
  assert(trimmedAgentId.length > 0, "resolveAgentAiSettings: agentId must be non-empty");

  const [config, agents] = await Promise.all([
    client.config.getConfig(),
    client.agents.list(buildAgentsListInput(workspaceId)),
  ]);

  const agentDef = agents.find((agent) => agent.id === trimmedAgentId);
  const agentDefsById = new Map<string, { base?: string }>(
    agents.map((agent) => [agent.id, { base: agent.base }])
  );

  const agentAiDefaults = config.agentAiDefaults ?? {};
  const directDefaults = agentAiDefaults[trimmedAgentId];
  const inheritedDefaults = directDefaults
    ? undefined
    : resolveInheritedConfigDefaults(trimmedAgentId, agentDefsById, agentAiDefaults);
  const descriptorDefaults = agentDef?.aiDefaults;

  const model =
    directDefaults?.modelString ??
    inheritedDefaults?.modelString ??
    descriptorDefaults?.model ??
    DEFAULT_MODEL;

  const thinkingLevel =
    directDefaults?.thinkingLevel ??
    inheritedDefaults?.thinkingLevel ??
    descriptorDefaults?.thinkingLevel ??
    DEFAULT_THINKING_LEVEL;

  return {
    model,
    thinkingLevel,
  };
}
