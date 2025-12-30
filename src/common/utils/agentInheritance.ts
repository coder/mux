import type { AgentId } from "@/common/types/agentDefinition";

/**
 * Tool configuration with add/remove patterns.
 */
interface ToolsConfig {
  add?: readonly string[];
  remove?: readonly string[];
}

/**
 * Interface for objects that have an `id`, optional `base`, and optional `tools` field.
 * Works with both AgentDefinitionDescriptor and AgentDefinitionPackage.
 */
interface AgentLike {
  id: AgentId;
  base?: AgentId;
  tools?: ToolsConfig;
}

/**
 * Check if a tool name matches any pattern in a list.
 * Patterns are treated as regex (consistent with toolPolicy.ts).
 */
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
 * Resolve the effective tools for an agent, including inherited tools from base agents.
 *
 * Inheritance is processed in order (base first, then child):
 * 1. Start with base agent's resolved tools
 * 2. Apply child's add patterns (union)
 * 3. Apply child's remove patterns (difference)
 *
 * @param agentId The agent to resolve tools for
 * @param agents All available agent definitions
 * @param maxDepth Maximum inheritance depth to prevent infinite loops (default: 10)
 * @returns Array of tool patterns that are enabled for this agent
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

  // Collect tool configs from inheritance chain (base first)
  const configs: ToolsConfig[] = [];
  let currentId: AgentId | undefined = agentId;
  let depth = 0;

  while (currentId && depth < maxDepth) {
    const agent = byId.get(currentId);
    if (!agent) break;

    if (agent.tools) {
      configs.unshift(agent.tools); // Base configs go first
    }
    currentId = agent.base;
    depth++;
  }

  // Process configs in order: base → child
  // Each layer's add patterns are added, then remove patterns are applied
  const enabled = new Set<string>();
  for (const config of configs) {
    // Add patterns
    if (config.add) {
      for (const pattern of config.add) {
        enabled.add(pattern);
      }
    }
    // Remove patterns (removes matching patterns from enabled set)
    if (config.remove) {
      for (const removePattern of config.remove) {
        // Remove any enabled pattern that matches the remove pattern
        for (const enabledPattern of [...enabled]) {
          if (enabledPattern === removePattern) {
            enabled.delete(enabledPattern);
          }
        }
      }
    }
  }

  return [...enabled];
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
