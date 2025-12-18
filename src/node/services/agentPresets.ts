import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

export interface AgentPreset {
  agentType: string;
  systemPrompt: string;
  toolPolicy: ToolPolicy;
}

// NOTE: These presets intentionally omit user/project instructions.
// They are used with the internal `mode: "agent"` system prompt strategy.
const RESEARCH_SYSTEM_PROMPT = `You are a research subagent.

- Your job is to gather information and produce a concise, well-structured report.
- You MUST finish by calling the tool \`agent_report\` exactly once with \`reportMarkdown\`.
- The parent will read your report; do not ask the user follow-up questions.

Report format:
- Summary (3–6 bullets)
- Findings (with links/paths)
- Open risks / unknowns
`;

const EXPLORE_SYSTEM_PROMPT = `You are an exploration subagent.

- Your job is to inspect the repository and answer the parent’s question.
- Prefer reading existing code over speculation.
- You MUST finish by calling the tool \`agent_report\` exactly once with \`reportMarkdown\`.

Report format:
- Summary (3–6 bullets)
- Key files + notes
- Suggested next steps
`;

export const AGENT_PRESETS: Record<string, AgentPreset> = {
  research: {
    agentType: "research",
    systemPrompt: RESEARCH_SYSTEM_PROMPT,
    toolPolicy: [
      // Start from deny-all, then enable a safe allowlist.
      { action: "disable", regex_match: ".*" },
      {
        action: "enable",
        regex_match: "^(web_fetch|web_search|google_search|file_read|task|agent_report)$",
      },
    ],
  },
  explore: {
    agentType: "explore",
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    toolPolicy: [
      { action: "disable", regex_match: ".*" },
      { action: "enable", regex_match: "^(bash|file_read|task|agent_report)$" },
    ],
  },
};

export function getAgentPreset(agentType: string): AgentPreset | undefined {
  return AGENT_PRESETS[agentType];
}
