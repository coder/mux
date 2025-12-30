import type { AgentId } from "@/common/types/agentDefinition";

/**
 * Interface for objects that have an `id` and optional `base` field.
 * Works with both AgentDefinitionDescriptor and AgentDefinitionPackage.
 */
interface AgentLike {
  id: AgentId;
  base?: AgentId;
}

/**
 * Check if an agent inherits from a target agent by traversing the `base` chain.
 *
 * Examples with agents = [
 *   { id: "plan", base: undefined },
 *   { id: "my-plan", base: "plan" },
 *   { id: "my-sub-plan", base: "my-plan" }
 * ]:
 *
 * - inheritsFrom("plan", "plan", agents) → true (self-match)
 * - inheritsFrom("my-plan", "plan", agents) → true (direct base)
 * - inheritsFrom("my-sub-plan", "plan", agents) → true (transitive: my-sub-plan → my-plan → plan)
 * - inheritsFrom("exec", "plan", agents) → false
 *
 * @param agentId The agent to check
 * @param targetId The target base to look for in the inheritance chain
 * @param agents All available agent definitions (for chain traversal)
 * @param maxDepth Maximum inheritance depth to prevent infinite loops (default: 10)
 */
export function inheritsFrom(
  agentId: AgentId,
  targetId: AgentId,
  agents: readonly AgentLike[],
  maxDepth = 10
): boolean {
  // Build a lookup map for efficiency
  const byId = new Map<AgentId, AgentLike>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }

  let currentId: AgentId | undefined = agentId;
  let depth = 0;

  while (currentId && depth < maxDepth) {
    // Self-match or match found in chain
    if (currentId === targetId) {
      return true;
    }

    // Look up the current agent to find its base
    const current = byId.get(currentId);
    if (!current) {
      // Agent not found in the collection - can't traverse further
      return false;
    }

    // Move up the chain
    currentId = current.base;
    depth++;
  }

  return false;
}

/**
 * Check if an agent is "plan-like" (inherits from "plan").
 * Plan-like agents can use propose_plan and have plan-mode UI styling.
 */
export function isPlanLike(agentId: AgentId, agents: readonly AgentLike[]): boolean {
  return inheritsFrom(agentId, "plan", agents);
}

/**
 * Check if an agent is "exec-like" (does NOT inherit from "plan").
 * Exec-like agents cannot use propose_plan.
 */
export function isExecLike(agentId: AgentId, agents: readonly AgentLike[]): boolean {
  return !isPlanLike(agentId, agents);
}
