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

const READ_ONLY_TOOL_ALLOWLIST: readonly string[] = [
  "file_read",
  "agent_skill_read",
  "agent_skill_read_file",
  "web_fetch",
];

function normalizeToolPattern(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  switch (normalized) {
    case "read":
      return "file_read";
    case "edit":
      return "file_edit_.*";
    case "bash":
      // NOTE: applyToolPolicy wraps patterns in ^...$, so alternation must be grouped.
      return "(?:bash|bash_output|bash_background_.*)";
    default:
      return normalized;
  }
}

function normalizeToolPatterns(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map(normalizeToolPattern)
    .filter((value): value is string => value !== null);
}

function buildPermissionModePolicy(args: {
  base: AgentMode;
  permissionMode: AgentDefinitionFrontmatter["permissionMode"];
}): ToolPolicy {
  if (args.base === "compact") {
    // Compact is an internal no-tools flow.
    return [{ regex_match: ".*", action: "disable" }];
  }

  switch (args.permissionMode) {
    case "default":
      return [];
    case "readOnly":
      return [
        { regex_match: ".*", action: "disable" },
        ...READ_ONLY_TOOL_ALLOWLIST.map((name) => ({
          regex_match: name,
          action: "enable" as const,
        })),
      ];
    case undefined:
      // Safe-by-default: custom agents grant no permissions unless explicitly enabled.
      return [{ regex_match: ".*", action: "disable" }];
  }
}

function buildPolicyFromOnlyAllowlist(args: {
  base: AgentMode;
  only: readonly string[];
}): ToolPolicy {
  if (args.base === "compact") {
    // Compact baseline is already "no tools". Do not allow overrides.
    return [{ regex_match: ".*", action: "disable" }];
  }

  const baselineDenied: string[] = args.base === "exec" ? ["propose_plan"] : [];

  const allowed = normalizeToolPatterns(args.only).filter((name) => !baselineDenied.includes(name));

  return [
    { regex_match: ".*", action: "disable" },
    ...allowed.map((name) => ({ regex_match: name, action: "enable" as const })),
  ];
}

export function resolveToolPolicyForAgent(options: ResolveToolPolicyOptions): ToolPolicy {
  const base = options.base;

  // Compact is an internal no-tools flow.
  if (base === "compact") {
    return [{ regex_match: ".*", action: "disable" }];
  }

  // NOTE: Hard-denies must be applied last so callers cannot re-enable them.
  const baseHardDeny: ToolPolicy =
    base === "exec" ? [{ regex_match: "propose_plan", action: "disable" }] : [];
  const depthPolicy: ToolPolicy = options.disableTaskToolsForDepth ? DEPTH_HARD_DENY : [];
  const subagentPolicy: ToolPolicy = options.isSubagent ? SUBAGENT_HARD_DENY : [];
  const subagentAlwaysAllow: ToolPolicy = options.isSubagent
    ? [{ regex_match: "agent_report", action: "enable" }]
    : [];

  const toolFilter = options.frontmatter.policy?.tools;

  // Ground-up allowlist override.
  if (toolFilter?.only && toolFilter.only.length > 0) {
    const agentPolicy = buildPolicyFromOnlyAllowlist({ base, only: toolFilter.only });
    return [
      ...agentPolicy,
      ...baseHardDeny,
      ...depthPolicy,
      ...subagentPolicy,
      ...subagentAlwaysAllow,
    ];
  }

  const agentPolicy: ToolPolicy = [
    ...buildPermissionModePolicy({ base, permissionMode: options.frontmatter.permissionMode }),

    ...normalizeToolPatterns(options.frontmatter.tools).map((name) => ({
      regex_match: name,
      action: "enable" as const,
    })),

    ...normalizeToolPatterns(options.frontmatter.disallowedTools).map((name) => ({
      regex_match: name,
      action: "disable" as const,
    })),

    ...normalizeToolPatterns(toolFilter?.deny).map((name) => ({
      regex_match: name,
      action: "disable" as const,
    })),
  ];

  return [
    ...agentPolicy,
    ...baseHardDeny,
    ...depthPolicy,
    ...subagentPolicy,
    ...subagentAlwaysAllow,
  ];
}
