/**
 * Agent presets for subagent workspaces.
 * Each preset defines a tool policy and system prompt for a specific agent type.
 */

import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { AgentType } from "@/common/types/task";

export interface AgentPreset {
  /** Human-readable name for the preset */
  name: string;
  /** Tool policy enforced for this preset (applied after caller's policy) */
  toolPolicy: ToolPolicy;
  /** System prompt for this agent type */
  systemPrompt: string;
  /** Short description of what this agent does */
  description: string;
}

/**
 * Research agent: can search the web and fetch pages, but cannot edit files.
 * Good for gathering information, researching topics, finding documentation.
 */
const researchPreset: AgentPreset = {
  name: "Research",
  description: "Web search and research without file edits",
  toolPolicy: [
    // Disable all tools first
    { regex_match: ".*", action: "disable" },
    // Enable read-only and research tools
    { regex_match: "web_search", action: "enable" },
    { regex_match: "web_fetch", action: "enable" },
    { regex_match: "file_read", action: "enable" },
    // Enable task delegation and reporting
    { regex_match: "task", action: "enable" },
    { regex_match: "agent_report", action: "enable" },
    // Enable todo for tracking
    { regex_match: "todo_.*", action: "enable" },
  ],
  systemPrompt: `You are a Research Agent. Your job is to gather information, search the web, and synthesize findings.

CAPABILITIES:
- Search the web using web_search
- Fetch and read web pages using web_fetch
- Read local files for context using file_read
- Delegate subtasks to other agents using task (if needed)
- Track progress with todo_write

CONSTRAINTS:
- You CANNOT edit files - you are read-only
- You CANNOT run bash commands
- Focus on gathering information accurately

REPORTING:
When you have completed your research and have a final answer or synthesis:
1. Call agent_report with your findings in markdown format
2. Include sources/citations where applicable
3. Be concise but comprehensive

If you cannot find the requested information after reasonable effort, report what you found and what remains unknown.`,
};

/**
 * Explore agent: can explore the codebase using file_read and bash (for rg/git).
 * Good for understanding code structure, finding patterns, tracing dependencies.
 */
const explorePreset: AgentPreset = {
  name: "Explore",
  description: "Codebase exploration without file edits",
  toolPolicy: [
    // Disable all tools first
    { regex_match: ".*", action: "disable" },
    // Enable read-only exploration tools
    { regex_match: "file_read", action: "enable" },
    { regex_match: "bash", action: "enable" },
    { regex_match: "bash_output", action: "enable" },
    { regex_match: "bash_background_list", action: "enable" },
    { regex_match: "bash_background_terminate", action: "enable" },
    // Enable task delegation and reporting
    { regex_match: "task", action: "enable" },
    { regex_match: "agent_report", action: "enable" },
    // Enable todo for tracking
    { regex_match: "todo_.*", action: "enable" },
  ],
  systemPrompt: `You are an Explore Agent. Your job is to explore and understand the codebase.

CAPABILITIES:
- Read files using file_read
- Search code using bash with rg (ripgrep), grep, find, git commands
- Navigate the repository structure
- Delegate subtasks to other agents using task (if needed)
- Track progress with todo_write

CONSTRAINTS:
- You CANNOT edit files - you are read-only
- Use bash only for read-only operations (rg, grep, find, git log, git show, etc.)
- Do NOT run commands that modify the filesystem

REPORTING:
When you have completed your exploration:
1. Call agent_report with your findings in markdown format
2. Include relevant code snippets, file paths, and structural insights
3. Be specific about locations (file:line) when referencing code

If the codebase is too large to fully explore, focus on the most relevant parts and note areas that weren't covered.`,
};

/**
 * Registry of all agent presets by type.
 */
export const AGENT_PRESETS: Record<AgentType, AgentPreset> = {
  research: researchPreset,
  explore: explorePreset,
};

/**
 * Get an agent preset by type.
 * @throws Error if preset not found
 */
export function getAgentPreset(agentType: AgentType): AgentPreset {
  const preset = AGENT_PRESETS[agentType];
  if (!preset) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }
  return preset;
}

/**
 * Get tool policy for an agent type (merges preset policy after caller's policy).
 * The preset policy is applied last so it cannot be overridden by the caller.
 */
export function getAgentToolPolicy(agentType: AgentType, callerPolicy?: ToolPolicy): ToolPolicy {
  const preset = getAgentPreset(agentType);
  // Caller's policy first, then preset policy (last wins)
  return [...(callerPolicy ?? []), ...preset.toolPolicy];
}
