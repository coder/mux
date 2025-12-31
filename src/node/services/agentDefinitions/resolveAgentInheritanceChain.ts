import type { Runtime } from "@/node/runtime/Runtime";

import type { AgentDefinitionPackage, AgentId } from "@/common/types/agentDefinition";
import { log } from "@/node/services/log";

import { readAgentDefinition } from "./agentDefinitionsService";

export interface AgentForInheritance {
  id: AgentId;
  base?: AgentId;
  tools?: AgentDefinitionPackage["frontmatter"]["tools"];
}

interface ResolveAgentInheritanceChainOptions {
  runtime: Runtime;
  workspacePath: string;
  agentId: AgentId;
  agentDefinition: AgentDefinitionPackage;
  workspaceId: string;
  maxDepth?: number;
}

/**
 * Resolve an agent's `base` inheritance chain (starting at the selected agent).
 *
 * IMPORTANT: Tool-policy computation requires the base chain to be present.
 * Building an "all agents" set in callers is error-prone because base agents
 * can be workspace-defined (project/global) rather than built-ins.
 */
export async function resolveAgentInheritanceChain(
  options: ResolveAgentInheritanceChainOptions
): Promise<AgentForInheritance[]> {
  const { runtime, workspacePath, agentId, agentDefinition, workspaceId } = options;
  const maxDepth = options.maxDepth ?? 10;

  const agentsForInheritance: AgentForInheritance[] = [];
  const seenAgentIds = new Set<AgentId>();
  let currentAgentId = agentId;
  let currentDefinition = agentDefinition;

  for (let depth = 0; depth < maxDepth; depth++) {
    if (seenAgentIds.has(currentAgentId)) {
      log.warn("Agent definition base chain has a cycle; stopping resolution", {
        workspaceId,
        agentId,
        currentAgentId,
      });
      break;
    }
    seenAgentIds.add(currentAgentId);

    agentsForInheritance.push({
      id: currentAgentId,
      base: currentDefinition.frontmatter.base,
      tools: currentDefinition.frontmatter.tools,
    });

    const baseId = currentDefinition.frontmatter.base;
    if (!baseId) {
      break;
    }

    currentAgentId = baseId;
    try {
      currentDefinition = await readAgentDefinition(runtime, workspacePath, baseId);
    } catch (error) {
      log.warn("Failed to load base agent definition; stopping inheritance resolution", {
        workspaceId,
        agentId,
        baseId,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  return agentsForInheritance;
}
