import type { AgentId } from "@/common/types/agentDefinition";

/**
 * Interface for objects that have an `id` and optional `tools` field.
 * Works with both AgentDefinitionDescriptor and AgentDefinitionPackage.
 */
interface AgentLike {
  id: AgentId;
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
 * Check if an agent has a specific tool in its whitelist.
 */
export function agentHasTool(
  agentId: AgentId,
  toolName: string,
  agents: readonly AgentLike[]
): boolean {
  const agent = agents.find((a) => a.id === agentId);
  if (!agent?.tools) {
    return false;
  }
  return toolMatchesPatterns(toolName, agent.tools);
}

/**
 * Check if an agent is "plan-like" (has propose_plan in its tools whitelist).
 * Plan-like agents get plan-mode UI styling.
 */
export function isPlanLike(agentId: AgentId, agents: readonly AgentLike[]): boolean {
  return agentHasTool(agentId, "propose_plan", agents);
}

/**
 * Check if an agent is "exec-like" (does NOT have propose_plan in tools).
 */
export function isExecLike(agentId: AgentId, agents: readonly AgentLike[]): boolean {
  return !isPlanLike(agentId, agents);
}
