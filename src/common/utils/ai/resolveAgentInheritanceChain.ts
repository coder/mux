/**
 * Pure agent base-chain traversal over an already-gathered agentId -> baseId
 * lookup. Reads no agent files; Node/browser adapters build the lookup from
 * their environment and own cycle/missing-definition logging.
 */

export interface AgentAncestorRef {
  agentId: string;
  /** False for the implicit terminus fallback (plan -> plan, otherwise exec). */
  declared: boolean;
}

export interface AgentInheritanceChainResult {
  /** Ancestors ordered child to root, excluding the target agent itself. */
  ancestors: AgentAncestorRef[];
  /** Set when traversal stopped early; adapters decide whether to log. */
  truncated?: "cycle" | "depth";
}

/** Matches MAX_INHERITANCE_DEPTH in the Node definition loader. */
export const MAX_AGENT_CHAIN_DEPTH = 10;

export function resolveAgentAncestorChain(params: {
  agentId: string;
  baseByAgentId: ReadonlyMap<string, string | undefined>;
  maxDepth?: number;
}): AgentInheritanceChainResult {
  const maxDepth = params.maxDepth ?? MAX_AGENT_CHAIN_DEPTH;
  const visited = new Set<string>([params.agentId]);
  const ancestors: AgentAncestorRef[] = [];
  let truncated: AgentInheritanceChainResult["truncated"];
  let cursor = params.agentId;

  for (let depth = 0; ; depth++) {
    const base = params.baseByAgentId.get(cursor);
    if (base == null || base === cursor) {
      // Same-id bases (e.g. project exec.md with base: exec) refine the
      // definition, not the config chain: one config entry per agent id.
      break;
    }
    if (visited.has(base)) {
      truncated = "cycle";
      break;
    }
    if (depth >= maxDepth) {
      truncated = "depth";
      break;
    }
    visited.add(base);
    ancestors.push({ agentId: base, declared: true });
    cursor = base;
  }

  // ACP parity: a chain terminus without a declared base still falls back to
  // the default base (plan -> plan, otherwise exec).
  if (truncated === undefined) {
    const terminus = ancestors[ancestors.length - 1]?.agentId ?? params.agentId;
    const fallback = terminus === "plan" ? "plan" : "exec";
    if (fallback !== terminus && !visited.has(fallback)) {
      ancestors.push({ agentId: fallback, declared: false });
    }
  }

  return truncated === undefined ? { ancestors } : { ancestors, truncated };
}
