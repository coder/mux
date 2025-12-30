import type { AgentId } from "@/common/types/agentDefinition";

/**
 * Interface for objects that have an `id`, optional `base`, and optional `tools` field.
 * Works with both AgentDefinitionDescriptor and AgentDefinitionPackage.
 */
interface AgentLike {
  id: AgentId;
  base?: AgentId;
  tools?: readonly string[];
}

/**
 * Check if a tool name matches any pattern in the tools whitelist.
 * Patterns can be exact matches or glob-like with `*` suffix.
 */
function toolMatchesPatterns(toolName: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === "*") {
      return true;
    }
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (toolName.startsWith(prefix)) {
        return true;
      }
    } else if (pattern === toolName) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the effective tools for an agent, including inherited tools from base agents.
 * Tools are merged up the inheritance chain (child tools extend parent tools).
 *
 * @param agentId The agent to resolve tools for
 * @param agents All available agent definitions
 * @param maxDepth Maximum inheritance depth to prevent infinite loops (default: 10)
 */
export function resolveAgentTools(
  agentId: AgentId,
  agents: readonly AgentLike[],
  maxDepth = 10
): readonly string[] {
  const byId = new Map<AgentId, AgentLike>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }

  // Collect tools from inheritance chain (parent first, then child overrides)
  const toolSets: Array<readonly string[]> = [];
  let currentId: AgentId | undefined = agentId;
  let depth = 0;

  while (currentId && depth < maxDepth) {
    const agent = byId.get(currentId);
    if (!agent) break;

    if (agent.tools) {
      toolSets.unshift(agent.tools); // Parent tools go first
    }
    currentId = agent.base;
    depth++;
  }

  // Merge all tool sets (later entries can override, but we just union for now)
  const merged = new Set<string>();
  for (const tools of toolSets) {
    for (const tool of tools) {
      merged.add(tool);
    }
  }

  return [...merged];
}

/**
 * Check if an agent has a specific tool in its resolved tools (including inherited).
 */
export function agentHasTool(
  agentId: AgentId,
  toolName: string,
  agents: readonly AgentLike[]
): boolean {
  const tools = resolveAgentTools(agentId, agents);
  return toolMatchesPatterns(toolName, tools);
}

/**
 * Check if an agent is "plan-like" (has propose_plan in its resolved tools).
 * Plan-like agents get plan-mode UI styling.
 */
export function isPlanLike(agentId: AgentId, agents: readonly AgentLike[]): boolean {
  return agentHasTool(agentId, "propose_plan", agents);
}

/**
 * Check if an agent is "exec-like" (does NOT have propose_plan in resolved tools).
 */
export function isExecLike(agentId: AgentId, agents: readonly AgentLike[]): boolean {
  return !isPlanLike(agentId, agents);
}
