import type { AgentId } from "@/common/types/agentDefinition";

/**
 * Tool configuration with add/remove patterns.
 */
interface ToolsConfig {
  add?: readonly string[];
  remove?: readonly string[];
}

/**
 * Properties that can be inherited from base agents via resolveAgentProperty.
 * Add new inheritable properties here to enable type-safe resolution.
 */
interface InheritableAgentProperties {
  uiColor?: string;
}

/**
 * Interface for objects that have an `id`, optional `base`, and optional `tools` field.
 * Works with both AgentDefinitionDescriptor and AgentDefinitionPackage.
 */
interface AgentLike extends InheritableAgentProperties {
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

interface CollectToolConfigsOptions {
  /** If true, agents is a pre-resolved chain (child→base order), iterate directly */
  isPreResolvedChain?: boolean;
}

/**
 * Collect tool configs from an agent's inheritance chain (base first, then child).
 *
 * Handles two cases:
 * 1. Pre-resolved chain from resolveAgentInheritanceChain (child→base order, may have
 *    duplicate IDs for same-name overrides like project/exec → built-in/exec)
 * 2. Flat list from discovery (unique IDs, need to walk base pointers)
 */
function collectToolConfigs(
  agentId: AgentId,
  agents: readonly AgentLike[],
  maxDepth = 10,
  options?: CollectToolConfigsOptions
): ToolsConfig[] {
  if (options?.isPreResolvedChain) {
    // Pre-resolved chain: iterate in order (already child→base), reverse for base→child
    return [...agents]
      .slice(0, maxDepth)
      .reverse()
      .filter((agent): agent is AgentLike & { tools: ToolsConfig } => agent.tools != null)
      .map((agent) => agent.tools);
  }

  // Flat list: build map and walk base pointers (original behavior)
  const byId = new Map<AgentId, AgentLike>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }

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

  return configs;
}

/**
 * Resolve the effective tools for an agent, including inherited tools from base agents.
 *
 * Inheritance is processed in order (base first, then child):
 * 1. Start with base agent's resolved tools
 * 2. Apply child's add patterns (union)
 * 3. Apply child's remove patterns (difference)
 *
 * Note: This returns the raw pattern strings. For checking if a specific tool
 * is enabled, use agentHasTool() which properly handles add/remove semantics.
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
  const configs = collectToolConfigs(agentId, agents, maxDepth);

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

export interface AgentInheritanceOptions {
  /**
   * If true, agents is a pre-resolved inheritance chain (child→base order)
   * from resolveAgentInheritanceChain. Use this when the chain may contain
   * duplicate IDs (e.g., project/exec → built-in/exec same-name override).
   */
  isPreResolvedChain?: boolean;
}

/**
 * Check if an agent has a specific tool in its resolved tools (including inherited).
 *
 * This properly handles add/remove semantics:
 * - A tool is enabled if it matches any add pattern
 * - A tool is disabled if it matches any remove pattern that comes after the matching add
 *
 * The inheritance chain is processed base → child, with each layer's add patterns
 * checked first, then remove patterns.
 */
export function agentHasTool(
  agentId: AgentId,
  toolName: string,
  agents: readonly AgentLike[],
  options?: AgentInheritanceOptions
): boolean {
  const configs = collectToolConfigs(agentId, agents, 10, {
    isPreResolvedChain: options?.isPreResolvedChain,
  });

  // Simulate tool policy: process add/remove in order
  // Start with disabled (deny-all baseline)
  let enabled = false;

  for (const config of configs) {
    // Check add patterns
    if (config.add && toolMatchesPatterns(toolName, config.add)) {
      enabled = true;
    }
    // Check remove patterns (can override add)
    if (config.remove && toolMatchesPatterns(toolName, config.remove)) {
      enabled = false;
    }
  }

  return enabled;
}

/**
 * Check if an agent is "plan-like" (has propose_plan in its resolved tools).
 * Plan-like agents get plan-mode UI styling.
 */
export function isPlanLike(
  agentId: AgentId,
  agents: readonly AgentLike[],
  options?: AgentInheritanceOptions
): boolean {
  return agentHasTool(agentId, "propose_plan", agents, options);
}

/**
 * Check if an agent is "exec-like" (does NOT have propose_plan in resolved tools).
 */
export function isExecLike(
  agentId: AgentId,
  agents: readonly AgentLike[],
  options?: AgentInheritanceOptions
): boolean {
  return !isPlanLike(agentId, agents, options);
}

/**
 * Resolve a property from an agent, walking up the inheritance chain until a value is found.
 * Returns undefined if no agent in the chain has the property set.
 *
 * @param agentId The agent to start resolving from
 * @param property The property name to resolve (must be in InheritableAgentProperties)
 * @param agents All available agent definitions or pre-resolved chain
 * @param maxDepth Maximum inheritance depth (default: 10)
 * @param options.isPreResolvedChain If true, agents is a pre-resolved chain (child→base order)
 */
export function resolveAgentProperty<K extends keyof InheritableAgentProperties>(
  agentId: AgentId,
  property: K,
  agents: readonly AgentLike[],
  maxDepth = 10,
  options?: AgentInheritanceOptions
): InheritableAgentProperties[K] {
  if (options?.isPreResolvedChain) {
    // Pre-resolved chain: iterate in order (child→base), return first defined value
    for (let i = 0; i < Math.min(agents.length, maxDepth); i++) {
      const value = agents[i][property];
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  }

  // Flat list: build map and walk base pointers (original behavior)
  const byId = new Map<AgentId, AgentLike>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }

  let currentId: AgentId | undefined = agentId;
  let depth = 0;

  while (currentId && depth < maxDepth) {
    const agent = byId.get(currentId);
    if (!agent) break;

    const value = agent[property];
    if (value !== undefined) {
      return value;
    }

    currentId = agent.base;
    depth++;
  }

  return undefined;
}
