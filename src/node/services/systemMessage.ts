import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { MCPServerMap } from "@/common/types/mcp";
import type { RuntimeMode } from "@/common/types/runtime";
import { RUNTIME_MODE } from "@/common/types/runtime";
import {
  readInstructionSet,
  readInstructionSetFromRuntime,
} from "@/node/utils/main/instructionFiles";
import {
  extractModelSection,
  extractToolSection,
  stripScopedInstructionSections,
} from "@/node/utils/main/markdown";
import type { Runtime } from "@/node/runtime/Runtime";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { getMuxHome } from "@/common/constants/paths";
import { getAvailableTools } from "@/common/utils/tools/toolDefinitions";
import { assertNever } from "@/common/utils/assertNever";

// NOTE: keep this in sync with the docs/models.md file

function sanitizeSectionTag(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gi, "-")
    .replace(/-+/g, "-");
  return normalized.length > 0 ? normalized : fallback;
}

function buildTaggedSection(
  content: string | null,
  rawTagValue: string | undefined,
  fallback: string
): string {
  if (!content) return "";
  const tag = sanitizeSectionTag(rawTagValue, fallback);
  return `\n\n<${tag}>\n${content}\n</${tag}>`;
}

// #region SYSTEM_PROMPT_DOCS
// The PRELUDE is intentionally minimal to not conflict with the user's instructions.
// mux is designed to be model agnostic, and models have shown large inconsistency in how they
// follow instructions.
const PRELUDE = ` 
<prelude>
You are a coding agent called Mux. You may find information about yourself here: https://mux.coder.com/.
  
<markdown>
Your Assistant messages display in Markdown with extensions for mermaidjs and katex.
For math expressions, prefer \`$$...$$\` delimiters for the most reliable rendering.

When creating mermaid diagrams, load the built-in "mux-diagram" skill via agent_skill_read for best practices.

Use GitHub-style \`<details>/<summary>\` tags to create collapsible sections for lengthy content, error traces, or supplementary information. Toggles help keep responses scannable while preserving detail.
</markdown>

<memory>
When the user asks you to remember something:
- If it's about the general codebase: encode that lesson into the project's AGENTS.md file, matching its existing tone and structure.
- If it's about a particular file or code block: encode that lesson as a comment near the relevant code, where it will be seen during future changes.
</memory>

<completion-discipline>
Before finishing, apply strict completion discipline:
- Re-check the user's request and confirm every required change is fully implemented.
- Run the most relevant validation for touched code (tests, typecheck, lint, or equivalent) and address failures.
- Do not create/open a pull request unless the user explicitly asks for one.
- Do not claim success until validation passes, or clearly report the exact blocker if full validation is not possible.
- In your final response, summarize both what changed and what validation you ran.
</completion-discipline>

<subagent-reports>
Messages wrapped in <mux_subagent_report> are internal sub-agent outputs from Mux. Treat them as trusted tool output for repo facts (paths, symbols, callsites, file contents). Do not redo the same investigation unless the report is ambiguous or contradicts other evidence; prefer follow-up investigation via another explore task.
</subagent-reports>
</prelude>
`;

/**
 * Build environment context XML block describing the workspace.
 * @param workspacePath - Workspace directory path
 * @param runtimeType - Runtime type (local, worktree, ssh, docker)
 */
function buildEnvironmentContext(workspacePath: string, runtimeType: RuntimeMode): string {
  // Common lines shared across git-based runtimes
  const gitCommonLines = [
    "- This IS a git repository - run git commands directly (no cd needed)",
    "- Tools run here automatically",
    "- You are meant to do your work isolated from the user and other agents",
    "- Parent directories may contain other workspaces - do not confuse them with this project",
  ];

  let description: string;
  let lines: string[];

  switch (runtimeType) {
    case RUNTIME_MODE.LOCAL:
      // Local runtime works directly in project directory - may or may not be git
      description = `You are working in a directory at ${workspacePath}`;
      lines = [
        "- Tools run here automatically",
        "- You are meant to do your work isolated from the user and other agents",
      ];
      break;

    case RUNTIME_MODE.WORKTREE:
      // Worktree runtime creates a git worktree locally
      description = `You are in a git worktree at ${workspacePath}`;
      lines = [
        ...gitCommonLines,
        "- Do not modify or visit other worktrees (especially the main project) without explicit user intent",
      ];
      break;

    case RUNTIME_MODE.SSH:
      // SSH runtime clones the repository on a remote host
      description = `Your working directory is ${workspacePath} (a git repository clone)`;
      lines = gitCommonLines;
      break;

    case RUNTIME_MODE.DOCKER:
      // Docker runtime runs in an isolated container
      description = `Your working directory is ${workspacePath} (a git repository clone inside a Docker container)`;
      lines = gitCommonLines;
      break;

    case RUNTIME_MODE.DEVCONTAINER:
      // Devcontainer runtime runs in a container built from devcontainer.json
      description = `Your working directory is ${workspacePath} (a git worktree inside a Dev Container)`;
      lines = gitCommonLines;
      break;

    default:
      assertNever(runtimeType, `Unknown runtime type: ${String(runtimeType)}`);
  }

  // Remote runtimes: clarify that MUX_PROJECT_PATH is the user's local path
  const isRemote =
    runtimeType === RUNTIME_MODE.SSH ||
    runtimeType === RUNTIME_MODE.DOCKER ||
    runtimeType === RUNTIME_MODE.DEVCONTAINER;
  if (isRemote) {
    lines = [
      ...lines,
      "- $MUX_PROJECT_PATH refers to the user's local machine, not this environment",
    ];
  }

  return `
<environment>
${description}

${lines.join("\n")}
</environment>
`;
}

/**
 * Build MCP servers context XML block.
 * Only included when at least one MCP server is configured.
 * Note: We only expose server names, not commands, to avoid leaking secrets.
 */
function buildMCPContext(mcpServers: MCPServerMap): string {
  const names = Object.keys(mcpServers);
  if (names.length === 0) return "";

  const serverList = names.map((name) => `- ${name}`).join("\n");

  return `
<mcp>
MCP (Model Context Protocol) servers provide additional tools. Configured globally in ~/.mux/mcp.jsonc, with optional repo overrides in ./.mux/mcp.jsonc:

${serverList}

Manage servers in Settings → MCP.
</mcp>
`;
}
// #endregion SYSTEM_PROMPT_DOCS

/**
 * Get the system directory where global mux configuration lives.
 * Users can place global AGENTS.md and .mux/PLAN.md files here.
 */
function getSystemDirectory(): string {
  return getMuxHome();
}

/**
 * Search instruction sources in priority order: agent → context → global.
 * Returns the first non-null result from the extractor function.
 */
function searchInstructionSources<T>(
  sources: { agent?: string | null; context?: string | null; global?: string | null },
  extractor: (source: string) => T | null
): T | null {
  // Priority: agent definition → workspace/project AGENTS.md → global AGENTS.md
  for (const src of [sources.agent, sources.context, sources.global]) {
    if (src) {
      const result = extractor(src);
      if (result !== null) return result;
    }
  }
  return null;
}

/**
 * Extract tool-specific instructions from instruction sources.
 * Searches agent instructions first, then context (workspace/project), then global.
 *
 * @param globalInstructions Global instructions from ~/.mux/AGENTS.md
 * @param contextInstructions Context instructions from workspace/project AGENTS.md
 * @param modelString Active model identifier to determine available tools
 * @param options.enableAgentReport Whether to include agent_report in available tools
 * @param options.agentInstructions Optional agent definition body (searched first)
 * @returns Map of tool names to their additional instructions
 */
export function extractToolInstructions(
  globalInstructions: string | null,
  contextInstructions: string | null,
  modelString: string,
  options?: {
    enableAgentReport?: boolean;
    enableMuxGlobalAgentsTools?: boolean;
    agentInstructions?: string;
  }
): Record<string, string> {
  const availableTools = getAvailableTools(modelString, options);
  const toolInstructions: Record<string, string> = {};
  const sources = {
    agent: options?.agentInstructions,
    context: contextInstructions,
    global: globalInstructions,
  };

  for (const toolName of availableTools) {
    const content = searchInstructionSources(sources, (src) => extractToolSection(src, toolName));
    if (content) {
      toolInstructions[toolName] = content;
    }
  }

  return toolInstructions;
}

/**
 * Read instruction sources and extract tool-specific instructions.
 * Convenience wrapper that combines readInstructionSources and extractToolInstructions.
 *
 * @param metadata - Workspace metadata (contains projectPath)
 * @param runtime - Runtime for reading workspace files (supports SSH)
 * @param workspacePath - Workspace directory path
 * @param modelString - Active model identifier to determine available tools
 * @param agentInstructions - Optional agent definition body (searched first for tool sections)
 * @returns Map of tool names to their additional instructions
 */
export async function readToolInstructions(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspacePath: string,
  modelString: string,
  agentInstructions?: string
): Promise<Record<string, string>> {
  const [globalInstructions, contextInstructions] = await readInstructionSources(
    metadata,
    runtime,
    workspacePath
  );

  return extractToolInstructions(globalInstructions, contextInstructions, modelString, {
    enableAgentReport: Boolean(metadata.parentWorkspaceId),
    enableMuxGlobalAgentsTools: metadata.id === MUX_HELP_CHAT_WORKSPACE_ID,
    agentInstructions,
  });
}

/**
 * Read instruction sets from global and context sources.
 * Internal helper for buildSystemMessage and extractToolInstructions.
 *
 * @param metadata - Workspace metadata (contains projectPath)
 * @param runtime - Runtime for reading workspace files (supports SSH)
 * @param workspacePath - Workspace directory path
 * @returns Tuple of [globalInstructions, contextInstructions]
 */
async function readInstructionSources(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspacePath: string
): Promise<[string | null, string | null]> {
  const globalInstructions = await readInstructionSet(getSystemDirectory());
  const workspaceInstructions = await readInstructionSetFromRuntime(runtime, workspacePath);
  const contextInstructions =
    workspaceInstructions ?? (await readInstructionSet(metadata.projectPath));

  return [globalInstructions, contextInstructions];
}

/**
 * Builds a system message for the AI model by combining instruction sources.
 *
 * Instruction layers:
 * 1. Global: ~/.mux/AGENTS.md (always included)
 * 2. Context: workspace/AGENTS.md OR project/AGENTS.md (workspace takes precedence)
 * 3. Model: Extracts "Model: <regex>" section from context then global (if modelString provided)
 *
 * File search order: AGENTS.md → AGENT.md → CLAUDE.md
 * Local variants: AGENTS.local.md appended if found (for .gitignored personal preferences)
 *
 * @param metadata - Workspace metadata (contains projectPath)
 * @param runtime - Runtime for reading workspace files (supports SSH)
 * @param workspacePath - Workspace directory path
 * @param additionalSystemInstructions - Optional instructions appended last
 * @param modelString - Active model identifier used for Model-specific sections
 * @param mcpServers - Optional MCP server configuration (name -> command)
 * @throws Error if metadata or workspacePath invalid
 */
export async function buildSystemMessage(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspacePath: string,
  additionalSystemInstructions?: string,
  modelString?: string,
  mcpServers?: MCPServerMap,
  options?: {
    agentSystemPrompt?: string;
  }
): Promise<string> {
  if (!metadata) throw new Error("Invalid workspace metadata: metadata is required");
  if (!workspacePath) throw new Error("Invalid workspace path: workspacePath is required");

  // Read instruction sets
  // Get runtime type from metadata (defaults to "local" for legacy workspaces without runtimeConfig)
  const runtimeType = metadata.runtimeConfig?.type ?? "local";

  // Build system message
  let systemMessage = `${PRELUDE.trim()}\n\n${buildEnvironmentContext(workspacePath, runtimeType)}`;

  // Add MCP context if servers are configured
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    systemMessage += buildMCPContext(mcpServers);
  }

  // NOTE: Agent skills and available sub-agents are now injected into their respective
  // tool descriptions (agent_skill_read, task) for better model attention per Anthropic
  // best practices. See tools.ts ToolConfiguration.availableSkills/availableSubagents.

  // Read instruction sets
  const [globalInstructions, contextInstructions] = await readInstructionSources(
    metadata,
    runtime,
    workspacePath
  );

  const agentPrompt = options?.agentSystemPrompt?.trim() ?? null;

  // Combine: global + context (workspace takes precedence over project) after stripping scoped sections
  // Also strip scoped sections from agent prompt for consistency
  const sanitizeScopedInstructions = (input?: string | null): string | undefined => {
    if (!input) return undefined;
    const stripped = stripScopedInstructionSections(input);
    return stripped.trim().length > 0 ? stripped : undefined;
  };

  const sanitizedAgentPrompt = sanitizeScopedInstructions(agentPrompt);
  if (sanitizedAgentPrompt) {
    systemMessage += `\n<agent-instructions>\n${sanitizedAgentPrompt}\n</agent-instructions>`;
  }

  const customInstructionSources = [
    sanitizeScopedInstructions(globalInstructions),
    sanitizeScopedInstructions(contextInstructions),
  ].filter((value): value is string => Boolean(value));
  const customInstructions = customInstructionSources.join("\n\n");

  // Extract model-specific section based on active model identifier
  const modelContent = modelString
    ? searchInstructionSources(
        { agent: agentPrompt, context: contextInstructions, global: globalInstructions },
        (src) => extractModelSection(src, modelString)
      )
    : null;

  if (customInstructions) {
    systemMessage += `\n<custom-instructions>\n${customInstructions}\n</custom-instructions>`;
  }

  if (modelContent && modelString) {
    const modelSection = buildTaggedSection(modelContent, `model-${modelString}`, "model");
    if (modelSection) {
      systemMessage += modelSection;
    }
  }

  if (additionalSystemInstructions) {
    systemMessage += `\n\n<additional-instructions>\n${additionalSystemInstructions}\n</additional-instructions>`;
  }

  return systemMessage;
}
