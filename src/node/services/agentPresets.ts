import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

export interface AgentPreset {
  /** Normalized agentType key (e.g., "research") */
  agentType: string;
  toolPolicy: ToolPolicy;
  systemPrompt: string;
}

const TASK_TOOL_NAMES = [
  "task",
  "task_await",
  "task_list",
  "task_terminate",
  "agent_report",
] as const;

function enableOnly(...toolNames: readonly string[]): ToolPolicy {
  return [
    { regex_match: ".*", action: "disable" },
    ...toolNames.map((toolName) => ({ regex_match: toolName, action: "enable" as const })),
  ];
}

const REPORTING_PROMPT_LINES = [
  "Reporting:",
  "- When you have a final answer, call agent_report exactly once.",
  "- Do not call agent_report until any spawned sub-tasks have completed and you have integrated their results.",
] as const;

function buildSystemPrompt(args: {
  agentLabel: string;
  goals: string[];
  rules: string[];
  delegation: string[];
}): string {
  return [
    `You are a ${args.agentLabel} sub-agent running inside a child workspace.`,
    "",
    "Goals:",
    ...args.goals,
    "",
    "Rules:",
    ...args.rules,
    "",
    "Delegation:",
    ...args.delegation,
    "",
    ...REPORTING_PROMPT_LINES,
  ].join("\n");
}

const RESEARCH_PRESET: AgentPreset = {
  agentType: "research",
  toolPolicy: enableOnly("web_search", "web_fetch", "file_read", ...TASK_TOOL_NAMES),
  systemPrompt: buildSystemPrompt({
    agentLabel: "Research",
    goals: [
      "- Gather accurate, relevant information efficiently.",
      "- Prefer primary sources and official docs when possible.",
    ],
    rules: [
      "- Do not edit files.",
      "- Do not run bash commands unless explicitly enabled (assume it is not).",
      "- If the task tool is available and you need repository exploration beyond file_read, delegate to an Explore sub-agent.",
      "- Use task_list only for discovery (e.g. after interruptions). Do not poll task_list to wait; use task_await to wait for completion.",
    ],
    delegation: [
      '- If available, use: task({ subagent_type: "explore", prompt: "..." }) when you need repo exploration.',
    ],
  }),
};

const EXPLORE_PRESET: AgentPreset = {
  agentType: "explore",
  toolPolicy: enableOnly(
    "file_read",
    "bash",
    "bash_output",
    "bash_background_list",
    "bash_background_terminate",
    ...TASK_TOOL_NAMES
  ),
  systemPrompt: buildSystemPrompt({
    agentLabel: "Explore",
    goals: [
      "- Explore the repository to answer the prompt using read-only investigation.",
      "- Keep output concise and actionable (paths, symbols, and findings).",
    ],
    rules: [
      "- Do not edit files.",
      "- Treat bash as read-only: prefer commands like rg, ls, cat, git show, git diff (read-only).",
      "- If the task tool is available and you need external information, delegate to a Research sub-agent.",
      "- Use task_list only for discovery (e.g. after interruptions). Do not poll task_list to wait; use task_await to wait for completion.",
    ],
    delegation: [
      '- If available, use: task({ subagent_type: "research", prompt: "..." }) when you need web research.',
    ],
  }),
};

const PRESETS_BY_AGENT_TYPE: Record<string, AgentPreset> = {
  research: RESEARCH_PRESET,
  explore: EXPLORE_PRESET,
};

export function getAgentPreset(agentType: string | undefined): AgentPreset | null {
  const normalized = (agentType ?? "").trim().toLowerCase();
  return PRESETS_BY_AGENT_TYPE[normalized] ?? null;
}
