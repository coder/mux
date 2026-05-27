import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";

/**
 * Resolved visibility/routability for an agent.
 *
 * - `selectable` controls whether the agent appears in the human picker, the
 *   ACP `agentMode` option list, and `agents.list` (subject to capability gating).
 * - `routable` controls whether `switch_agent` can hand off to the agent.
 *   Defaults to `selectable` when `ui.routable` is unset: visible agents are
 *   routable by default; hidden agents must opt back in via `ui.routable: true`.
 *
 * This is the single source of truth for the rule; do not re-implement it
 * inline. Use {@link resolveAgentVisibility} everywhere these booleans are needed.
 */
export interface AgentVisibility {
  selectable: boolean;
  routable: boolean;
}

export function resolveAgentVisibility(
  ui: AgentDefinitionFrontmatter["ui"] | undefined
): AgentVisibility {
  const selectable = ui?.hidden !== true;
  const routable = typeof ui?.routable === "boolean" ? ui.routable : selectable;
  return { selectable, routable };
}
