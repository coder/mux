import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

export interface AgentPreset {
  /** Normalized agentType key (e.g., "research") */
  agentType: string;
  toolPolicy: ToolPolicy;
  systemPrompt: string;
}

const RESEARCH_PRESET: AgentPreset = {
  agentType: "research",
  toolPolicy: [
    { regex_match: ".*", action: "disable" },
    { regex_match: "web_search", action: "enable" },
    { regex_match: "web_fetch", action: "enable" },
    { regex_match: "file_read", action: "enable" },
    { regex_match: "task", action: "enable" },
    { regex_match: "task_await", action: "enable" },
    { regex_match: "task_list", action: "enable" },
    { regex_match: "task_terminate", action: "enable" },
    { regex_match: "agent_report", action: "enable" },
  ],
  systemPrompt: [
    "You are a Research sub-agent running inside a child workspace.",
    "",
    "Goals:",
    "- Gather accurate, relevant information efficiently.",
    "- Prefer primary sources and official docs when possible.",
    "",
    "Rules:",
    "- Do not edit files.",
    "- Do not run bash commands unless explicitly enabled (assume it is not).",
    "- If you need repository exploration beyond file_read, delegate to an Explore sub-agent via the task tool.",
    "",
    "Delegation:",
    '- Use: task({ subagent_type: "explore", prompt: "..." }) when you need repo exploration.',
    "",
    "Reporting:",
    "- When you have a final answer, call agent_report exactly once.",
    "- Do not call agent_report until any spawned sub-tasks have completed and you have integrated their results.",
  ].join("\n"),
};

const EXPLORE_PRESET: AgentPreset = {
  agentType: "explore",
  toolPolicy: [
    { regex_match: ".*", action: "disable" },
    { regex_match: "file_read", action: "enable" },
    { regex_match: "bash", action: "enable" },
    { regex_match: "bash_output", action: "enable" },
    { regex_match: "bash_background_list", action: "enable" },
    { regex_match: "bash_background_terminate", action: "enable" },
    { regex_match: "task", action: "enable" },
    { regex_match: "task_await", action: "enable" },
    { regex_match: "task_list", action: "enable" },
    { regex_match: "task_terminate", action: "enable" },
    { regex_match: "agent_report", action: "enable" },
  ],
  systemPrompt: [
    "You are an Explore sub-agent running inside a child workspace.",
    "",
    "Goals:",
    "- Explore the repository to answer the prompt using read-only investigation.",
    "- Keep output concise and actionable (paths, symbols, and findings).",
    "",
    "Rules:",
    "- Do not edit files.",
    "- Treat bash as read-only: prefer commands like rg, ls, cat, git show, git diff (read-only).",
    "- If you need external information, delegate to a Research sub-agent via the task tool.",
    "",
    "Delegation:",
    '- Use: task({ subagent_type: "research", prompt: "..." }) when you need web research.',
    "",
    "Reporting:",
    "- When you have a final answer, call agent_report exactly once.",
    "- Do not call agent_report until any spawned sub-tasks have completed and you have integrated their results.",
  ].join("\n"),
};

const PRESETS_BY_AGENT_TYPE: Record<string, AgentPreset> = {
  research: RESEARCH_PRESET,
  explore: EXPLORE_PRESET,
};

export function getAgentPreset(agentType: string | undefined): AgentPreset | null {
  const normalized = (agentType ?? "").trim().toLowerCase();
  return PRESETS_BY_AGENT_TYPE[normalized] ?? null;
}
