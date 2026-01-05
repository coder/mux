import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

export interface AgentPreset {
  /** Normalized agentType key (e.g., "explore" or "exec") */
  agentType: string;
  toolPolicy: ToolPolicy;
  systemPrompt: string;
}

const REPORTING_TOOL_NAMES = ["agent_report"] as const;

function enableOnly(...toolNames: readonly string[]): ToolPolicy {
  return [
    { regex_match: ".*", action: "disable" },
    ...toolNames.map((toolName) => ({ regex_match: toolName, action: "enable" as const })),
  ];
}

const REPORTING_PROMPT_LINES = [
  "Reporting:",
  "- When you have a final answer, call agent_report exactly once.",
  "- Do not call agent_report until you have completed the assigned task and integrated all relevant findings.",
] as const;

function buildSystemPrompt(args: {
  agentLabel: string;
  goals: string[];
  rules: string[];
  delegation?: string[];
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
    ...(args.delegation && args.delegation.length > 0
      ? ["Delegation:", ...args.delegation, ""]
      : []),
    ...REPORTING_PROMPT_LINES,
  ].join("\n");
}

const EXEC_PRESET: AgentPreset = {
  agentType: "exec",
  toolPolicy: [
    // Only the main plan-mode session should call propose_plan.
    { regex_match: "propose_plan", action: "disable" },
  ],
  systemPrompt: buildSystemPrompt({
    agentLabel: "Exec",
    goals: [
      "- Complete the assigned coding task end-to-end in this child workspace.",
      "- Make minimal, correct changes that match existing codebase patterns.",
    ],
    rules: [
      "- You MUST NOT spawn additional sub-agent tasks.",
      "- Do not call propose_plan.",
      "- Prefer small, reviewable diffs and run targeted checks when feasible.",
    ],
  }),
};

const EXPLORE_PRESET: AgentPreset = {
  agentType: "explore",
  toolPolicy: enableOnly(
    "file_read",
    "bash",
    "task_await",
    "task_list",
    "task_terminate",
    "web_fetch",
    "web_search",
    "google_search",
    ...REPORTING_TOOL_NAMES
  ),
  systemPrompt: buildSystemPrompt({
    agentLabel: "Explore",
    goals: [
      "- Explore the repository to answer the prompt using read-only investigation.",
      "- Return concise, actionable findings (paths, symbols, callsites, and facts).",
    ],
    rules: [
      "=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===",
      "- You MUST NOT create, edit, delete, move, or copy files.",
      "- You MUST NOT create temporary files anywhere (including /tmp).",
      "- You MUST NOT use redirect operators (>, >>, |) or heredocs to write to files.",
      "- You MUST NOT run commands that change system state (rm, mv, cp, mkdir, touch, git add/commit, installs, etc.).",
      "- Use bash only for read-only operations (rg, ls, cat, git diff/show/log, etc.).",
      "- You MUST NOT spawn additional sub-agent tasks.",
    ],
  }),
};

const PRESETS_BY_AGENT_TYPE: Record<string, AgentPreset> = {
  explore: EXPLORE_PRESET,
  exec: EXEC_PRESET,
};

export function getAgentPreset(agentType: string | undefined): AgentPreset | null {
  const normalized = (agentType ?? "").trim().toLowerCase();
  return PRESETS_BY_AGENT_TYPE[normalized] ?? null;
}
