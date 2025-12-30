import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

export interface ResolveToolPolicyOptions {
  agentId: string;
  frontmatter: AgentDefinitionFrontmatter;
  isSubagent: boolean;
  disableTaskToolsForDepth: boolean;
  /** Whether this agent inherits from "plan" (pre-computed by caller) */
  isPlanLike: boolean;
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
 * 1. Agent's `tools` whitelist (regex patterns) - if empty/missing, no tools allowed
 * 2. Runtime restrictions (subagent limits, depth limits) applied last
 *
 * Subagents always get `agent_report` enabled regardless of their tool list.
 */
export function resolveToolPolicyForAgent(options: ResolveToolPolicyOptions): ToolPolicy {
  const { frontmatter, isSubagent, disableTaskToolsForDepth, isPlanLike } = options;

  // Start with deny-all, then enable only whitelisted tools
  const agentPolicy: ToolPolicy = [{ regex_match: ".*", action: "disable" }];

  // Enable tools from the whitelist (treated as regex patterns)
  const tools = frontmatter.tools ?? [];
  for (const pattern of tools) {
    const trimmed = pattern.trim();
    if (trimmed.length > 0) {
      agentPolicy.push({ regex_match: trimmed, action: "enable" });
    }
  }

  // Runtime restrictions (applied last, cannot be overridden)
  const runtimePolicy: ToolPolicy = [];

  // Exec-like agents (those not inheriting from plan) cannot use propose_plan
  if (!isPlanLike) {
    runtimePolicy.push({ regex_match: "propose_plan", action: "disable" });
  }

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
