import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

export interface ResolveToolPolicyOptions {
  agentId: string;
  frontmatter: AgentDefinitionFrontmatter;
  isSubagent: boolean;
  disableTaskToolsForDepth: boolean;
}

// Runtime restrictions that cannot be overridden by agent definitions
const SUBAGENT_HARD_DENY: ToolPolicy = [
  { regex_match: "task", action: "disable" },
  { regex_match: "task_.*", action: "disable" },
  { regex_match: "propose_plan", action: "disable" },
  { regex_match: "ask_user_question", action: "disable" },
];

const DEPTH_HARD_DENY: ToolPolicy = [
  { regex_match: "task", action: "disable" },
  { regex_match: "task_.*", action: "disable" },
];

/**
 * Resolves tool policy for an agent.
 *
 * The policy is built from:
 * 1. Agent's `tools.add` patterns (enable) - if empty/missing, no tools allowed
 * 2. Agent's `tools.remove` patterns (disable) - removes tools that were added
 * 3. Runtime restrictions (subagent limits, depth limits) applied last
 *
 * Note: This function operates on a single agent's frontmatter. Inheritance
 * (resolving tools from base agents) is handled separately.
 *
 * Subagents always get `agent_report` enabled regardless of their tool list.
 */
export function resolveToolPolicyForAgent(options: ResolveToolPolicyOptions): ToolPolicy {
  const { frontmatter, isSubagent, disableTaskToolsForDepth } = options;

  // Start with deny-all, then enable tools from add list, then disable from remove list
  const agentPolicy: ToolPolicy = [{ regex_match: ".*", action: "disable" }];

  // Enable tools from add list (treated as regex patterns)
  const addPatterns = frontmatter.tools?.add ?? [];
  for (const pattern of addPatterns) {
    const trimmed = pattern.trim();
    if (trimmed.length > 0) {
      agentPolicy.push({ regex_match: trimmed, action: "enable" });
    }
  }

  // Disable tools from remove list
  const removePatterns = frontmatter.tools?.remove ?? [];
  for (const pattern of removePatterns) {
    const trimmed = pattern.trim();
    if (trimmed.length > 0) {
      agentPolicy.push({ regex_match: trimmed, action: "disable" });
    }
  }

  // Runtime restrictions (applied last, cannot be overridden)
  const runtimePolicy: ToolPolicy = [];

  if (disableTaskToolsForDepth) {
    runtimePolicy.push(...DEPTH_HARD_DENY);
  }

  if (isSubagent) {
    runtimePolicy.push(...SUBAGENT_HARD_DENY);
    // Subagents always need agent_report to return results
    runtimePolicy.push({ regex_match: "agent_report", action: "enable" });
  }

  return [...agentPolicy, ...runtimePolicy];
}
