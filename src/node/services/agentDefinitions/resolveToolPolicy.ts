import {
  collectToolConfigsFromResolvedChain,
  isPlanLikeInResolvedChain,
  type ToolsConfig,
} from "@/common/utils/agentTools";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

/**
 * Minimal agent structure needed for tool policy resolution.
 * Compatible with AgentForInheritance from resolveAgentInheritanceChain.
 */
export interface AgentLikeForPolicy {
  tools?: ToolsConfig;
}

export interface ResolveToolPolicyOptions {
  /**
   * Pre-resolved inheritance chain from resolveAgentInheritanceChain.
   * Ordered child → base (selected agent first, then its base, etc.).
   */
  agents: readonly AgentLikeForPolicy[];
  isSubagent: boolean;
  disableTaskToolsForDepth: boolean;
}

// Runtime restrictions that cannot be overridden by agent definitions.
// Ask-for-input tools are never allowed in autonomous sub-agent flows.
const SUBAGENT_HARD_DENY: ToolPolicy = [{ regex_match: "ask_user_question", action: "disable" }];

const DEPTH_HARD_DENY: ToolPolicy = [
  { regex_match: "task", action: "disable" },
  { regex_match: "task_.*", action: "disable" },
];

/**
 * Resolves tool policy for an agent, including inherited tools from base agents.
 *
 * The policy is built from:
 * 1. Inheritance chain processed base → child:
 *    - Each layer's `tools.add` patterns (enable)
 *    - Each layer's `tools.remove` patterns (disable)
 * 2. Runtime restrictions (subagent limits, depth limits) applied last
 *
 * Example: ask (base: exec)
 * - exec has add: [.*], remove: [propose_plan, ask_user_question]
 * - ask has remove: [file_edit_.*]
 * - Result: deny-all → enable .* → disable propose_plan → disable ask_user_question → disable file_edit_.*
 *
 * Subagent completion tool is mode-dependent:
 * - plan-like subagents: enable `propose_plan`, disable `agent_report`
 * - non-plan subagents: disable `propose_plan`, enable `agent_report`
 */
export function resolveToolPolicyForAgent(options: ResolveToolPolicyOptions): ToolPolicy {
  const { agents, isSubagent, disableTaskToolsForDepth } = options;

  // Start with deny-all baseline
  const agentPolicy: ToolPolicy = [{ regex_match: ".*", action: "disable" }];

  // Process inheritance chain: base → child
  const configs = collectToolConfigsFromResolvedChain(agents);
  for (const config of configs) {
    // Enable tools from add list (treated as regex patterns)
    if (config.add) {
      for (const pattern of config.add) {
        const trimmed = pattern.trim();
        if (trimmed.length > 0) {
          agentPolicy.push({ regex_match: trimmed, action: "enable" });
        }
      }
    }

    // Disable tools from remove list
    if (config.remove) {
      for (const pattern of config.remove) {
        const trimmed = pattern.trim();
        if (trimmed.length > 0) {
          agentPolicy.push({ regex_match: trimmed, action: "disable" });
        }
      }
    }
  }

  // Runtime restrictions (applied last, cannot be overridden)
  const runtimePolicy: ToolPolicy = [];

  if (disableTaskToolsForDepth) {
    runtimePolicy.push(...DEPTH_HARD_DENY);
  }

  if (isSubagent) {
    runtimePolicy.push(...SUBAGENT_HARD_DENY);

    const isPlanLikeSubagent = isPlanLikeInResolvedChain(agents);
    if (isPlanLikeSubagent) {
      // Plan-mode subagents must finish by proposing a plan, not by reporting.
      runtimePolicy.push({ regex_match: "propose_plan", action: "enable" });
      runtimePolicy.push({ regex_match: "agent_report", action: "disable" });
    } else {
      // Non-plan subagents should complete through agent_report.
      runtimePolicy.push({ regex_match: "propose_plan", action: "disable" });
      runtimePolicy.push({ regex_match: "agent_report", action: "enable" });
    }
  }

  return [...agentPolicy, ...runtimePolicy];
}
