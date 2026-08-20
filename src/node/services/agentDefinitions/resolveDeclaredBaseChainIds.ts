import type { Runtime } from "@/node/runtime/Runtime";
import { readAgentDefinition } from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";

/**
 * Resolves an agent's declared base chain (ordered ancestor IDs, excluding the
 * agent itself) from its definition files, terminated with the ACP-style
 * default base when the chain ends without declaring one. Returns undefined
 * when the definition cannot be read, so callers keep their sync
 * approximation.
 */
export async function resolveDeclaredBaseChainIds(params: {
  runtime: Runtime;
  workspacePath: string;
  agentId: string;
  workspaceId: string;
}): Promise<string[] | undefined> {
  try {
    const agentDefinition = await readAgentDefinition(
      params.runtime,
      params.workspacePath,
      params.agentId
    );
    const chain = await resolveAgentInheritanceChain({
      runtime: params.runtime,
      workspacePath: params.workspacePath,
      agentId: agentDefinition.id,
      agentDefinition,
      workspaceId: params.workspaceId,
    });
    const ids: string[] = [];
    for (const entry of chain) {
      if (entry.id !== params.agentId && !ids.includes(entry.id)) {
        ids.push(entry.id);
      }
    }
    // ACP parity: a chain terminus without a declared base still falls back
    // to the default base (plan -> plan, else exec).
    const terminus = chain[chain.length - 1]?.id ?? params.agentId;
    const fallbackBase = terminus === "plan" ? "plan" : "exec";
    if (fallbackBase !== terminus && fallbackBase !== params.agentId) {
      if (!ids.includes(fallbackBase)) {
        ids.push(fallbackBase);
      }
    }
    return ids;
  } catch {
    return undefined;
  }
}
