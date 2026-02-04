import type { AgentId } from "@/common/types/agentDefinition";

export interface ToolsConfig {
  add?: readonly string[];
  remove?: readonly string[];
}

export interface AgentToolsLike {
  id: AgentId;
  base?: AgentId;
  tools?: ToolsConfig;
}

export interface ToolsConfigCarrier {
  tools?: ToolsConfig;
}

function toolMatchesPatterns(toolName: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    const regex = new RegExp(`^${pattern}$`);
    if (regex.test(toolName)) {
      return true;
    }
  }
  return false;
}

/**
 * Apply add/remove semantics to a single tool name.
 *
 * `configs` must be ordered base → child.
 *
 * Semantics:
 * - Baseline is deny-all.
 * - If a tool matches any `add` pattern it becomes enabled.
 * - If a tool matches any `remove` pattern it becomes disabled (overrides earlier adds).
 */
export function isToolEnabledByConfigs(toolName: string, configs: readonly ToolsConfig[]): boolean {
  let enabled = false;

  for (const config of configs) {
    if (config.add && toolMatchesPatterns(toolName, config.add)) {
      enabled = true;
    }

    if (config.remove && toolMatchesPatterns(toolName, config.remove)) {
      enabled = false;
    }
  }

  return enabled;
}

/**
 * Extract tool configs from a resolved inheritance chain.
 *
 * Input order: child → base (selected agent first)
 * Output order: base → child (for correct add/remove semantics)
 */
export function collectToolConfigsFromResolvedChain(
  agents: readonly ToolsConfigCarrier[],
  maxDepth = 10
): ToolsConfig[] {
  return [...agents]
    .slice(0, maxDepth)
    .reverse()
    .filter((agent): agent is ToolsConfigCarrier & { tools: ToolsConfig } => agent.tools != null)
    .map((agent) => agent.tools);
}

/**
 * Extract tool configs by walking `base` pointers in a graph of unique agent IDs.
 *
 * This is intended for UI usage where the caller has a flat list from discovery.
 */
export function collectToolConfigsFromDefinitionGraph(
  agentId: AgentId,
  agents: readonly AgentToolsLike[],
  maxDepth = 10
): ToolsConfig[] {
  const byId = new Map<AgentId, AgentToolsLike>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }

  const configsChildToBase: ToolsConfig[] = [];
  const visited = new Set<AgentId>();

  let currentId: AgentId | undefined = agentId;
  let depth = 0;

  while (currentId && depth < maxDepth) {
    if (visited.has(currentId)) {
      break;
    }
    visited.add(currentId);

    const agent = byId.get(currentId);
    if (!agent) {
      break;
    }

    if (agent.tools) {
      configsChildToBase.push(agent.tools);
    }

    currentId = agent.base;
    depth++;
  }

  return configsChildToBase.reverse();
}

export function isToolEnabledInResolvedChain(
  toolName: string,
  agents: readonly ToolsConfigCarrier[],
  maxDepth = 10
): boolean {
  return isToolEnabledByConfigs(toolName, collectToolConfigsFromResolvedChain(agents, maxDepth));
}

export function isPlanLikeInResolvedChain(
  agents: readonly ToolsConfigCarrier[],
  maxDepth = 10
): boolean {
  return isToolEnabledInResolvedChain("propose_plan", agents, maxDepth);
}

export function isExecLikeEditingCapableInResolvedChain(
  agents: ReadonlyArray<ToolsConfigCarrier & { id: AgentId }>,
  maxDepth = 10
): boolean {
  const inheritsExec = agents.some((agent) => agent.id === "exec");
  if (!inheritsExec) {
    return false;
  }

  return (
    isToolEnabledInResolvedChain("file_edit_insert", agents, maxDepth) ||
    isToolEnabledInResolvedChain("file_edit_replace_string", agents, maxDepth)
  );
}
