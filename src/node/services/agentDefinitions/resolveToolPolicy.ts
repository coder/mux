import type { AgentMode } from "@/common/types/mode";
import type { AgentDefinitionFrontmatter } from "@/common/types/agentDefinition";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

export interface ResolveToolPolicyOptions {
  base: AgentMode;
  frontmatter: AgentDefinitionFrontmatter;
  isSubagent: boolean;
  disableTaskToolsForDepth: boolean;
}

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

function normalizeToolName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildPolicyFromToolFilter(args: {
  base: AgentMode;
  filter: NonNullable<NonNullable<AgentDefinitionFrontmatter["policy"]>["tools"]>;
}): ToolPolicy {
  if (args.base === "compact") {
    // Compact baseline is already "no tools". Do not allow overrides.
    return [{ regex_match: ".*", action: "disable" }];
  }

  // Baseline restrictions that must never be re-enabled.
  const baselineDenied: string[] = args.base === "exec" ? ["propose_plan"] : [];

  const deny = args.filter.deny?.map(normalizeToolName).filter(Boolean) as string[];
  const only = args.filter.only?.map(normalizeToolName).filter(Boolean) as string[];

  if (only && only.length > 0) {
    const allowed = only.filter((name) => !baselineDenied.includes(name));
    return [
      { regex_match: ".*", action: "disable" },
      ...allowed.map((name) => ({ regex_match: name, action: "enable" as const })),
    ];
  }

  const policy: ToolPolicy = [];

  for (const name of deny ?? []) {
    policy.push({ regex_match: name, action: "disable" });
  }

  // Apply baseline denies last so callers cannot re-enable them.
  for (const name of baselineDenied) {
    policy.push({ regex_match: name, action: "disable" });
  }

  return policy;
}

export function resolveToolPolicyForAgent(options: ResolveToolPolicyOptions): ToolPolicy {
  const base = options.base;

  // Compact is an internal no-tools flow.
  if (base === "compact") {
    return [{ regex_match: ".*", action: "disable" }];
  }

  // Start with agent-specific filter policy.
  const agentPolicy: ToolPolicy = options.frontmatter.policy?.tools
    ? buildPolicyFromToolFilter({ base, filter: options.frontmatter.policy.tools })
    : // Baseline: exec disables propose_plan; plan allows all tools.
      base === "exec"
      ? [{ regex_match: "propose_plan", action: "disable" as const }]
      : [];

  const depthPolicy: ToolPolicy = options.disableTaskToolsForDepth ? DEPTH_HARD_DENY : [];
  const subagentPolicy: ToolPolicy = options.isSubagent ? SUBAGENT_HARD_DENY : [];

  // IMPORTANT: depth + subagent policies must be applied last.
  return [...agentPolicy, ...depthPolicy, ...subagentPolicy];
}
