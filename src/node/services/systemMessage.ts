import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { MCPServerMap } from "@/common/types/mcp";
import {
  readInstructionSet,
  readInstructionSetFromRuntime,
} from "@/node/utils/main/instructionFiles";
import {
  extractModeSection,
  extractModelSection,
  extractToolSection,
  stripScopedInstructionSections,
} from "@/node/utils/main/markdown";
import type { Runtime } from "@/node/runtime/Runtime";
import { getMuxHome } from "@/common/constants/paths";
import { getAvailableTools } from "@/common/utils/tools/toolDefinitions";

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

When creating mermaid diagrams:
- Avoid side-by-side subgraphs (they display too wide)
- For comparisons, use separate diagram blocks or single graph with visual separation
- When using custom fill colors, include contrasting color property (e.g., "style note fill:#ff6b6b,color:#fff")
- Make good use of visual space: e.g. use inline commentary
- Wrap node labels containing brackets or special characters in quotes (e.g., Display["Message[]"] not Display[Message[]])

Use GitHub-style \`<details>/<summary>\` tags to create collapsible sections for lengthy content, error traces, or supplementary information. Toggles help keep responses scannable while preserving detail.
</markdown>

<memory>
When the user asks you to remember something:
- If it's about the general codebase: encode that lesson into the project's AGENTS.md file, matching its existing tone and structure.
- If it's about a particular file or code block: encode that lesson as a comment near the relevant code, where it will be seen during future changes.
</memory>
</prelude>
`;

/**
 * Build environment context XML block describing the workspace.
 * @param workspacePath - Workspace directory path
 * @param runtimeType - Runtime type: "local", "worktree", or "ssh"
 */
function buildEnvironmentContext(
  workspacePath: string,
  runtimeType: "local" | "worktree" | "ssh"
): string {
  if (runtimeType === "local") {
    // Local runtime works directly in project directory - may or may not be git
    return `
<environment>
You are working in a directory at ${workspacePath}

- Tools run here automatically
- You are meant to do your work isolated from the user and other agents
</environment>
`;
  }

  if (runtimeType === "ssh") {
    // SSH runtime clones the repository on a remote host
    return `
<environment>
You are in a clone of a git repository at ${workspacePath}

- This IS a git repository - run git commands directly (no cd needed)
- Tools run here automatically
- You are meant to do your work isolated from the user and other agents
</environment>
`;
  }

  // Worktree runtime creates a git worktree locally
  return `
<environment>
You are in a git worktree at ${workspacePath}

- This IS a git repository - run git commands directly (no cd needed)
- Tools run here automatically
- Do not modify or visit other worktrees (especially the main project) without explicit user intent
- You are meant to do your work isolated from the user and other agents
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
MCP (Model Context Protocol) servers provide additional tools. Configured in user's local project's .mux/mcp.jsonc:

${serverList}

Use /mcp add|edit|remove or Settings → Projects to manage servers.
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
 * Extract tool-specific instructions from instruction sources.
 * Searches context (workspace/project) first, then falls back to global instructions.
 *
 * @param globalInstructions Global instructions from ~/.mux/AGENTS.md
 * @param contextInstructions Context instructions from workspace/project AGENTS.md
 * @param modelString Active model identifier to determine available tools
 * @param mode Optional mode ("plan" | "exec") - affects which tools are available
 * @returns Map of tool names to their additional instructions
 */
export function extractToolInstructions(
  globalInstructions: string | null,
  contextInstructions: string | null,
  modelString: string,
  mode?: "plan" | "exec",
  options?: { enableAgentReport?: boolean }
): Record<string, string> {
  const availableTools = getAvailableTools(modelString, mode, options);
  const toolInstructions: Record<string, string> = {};

  for (const toolName of availableTools) {
    // Try context instructions first, then global
    const content =
      (contextInstructions && extractToolSection(contextInstructions, toolName)) ??
      (globalInstructions && extractToolSection(globalInstructions, toolName)) ??
      null;

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
 * @param mode Optional mode ("plan" | "exec") - affects which tools are available
 * @returns Map of tool names to their additional instructions
 */
export async function readToolInstructions(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspacePath: string,
  modelString: string,
  mode?: "plan" | "exec"
): Promise<Record<string, string>> {
  const [globalInstructions, contextInstructions] = await readInstructionSources(
    metadata,
    runtime,
    workspacePath
  );

  return extractToolInstructions(globalInstructions, contextInstructions, modelString, mode, {
    enableAgentReport: Boolean(metadata.parentWorkspaceId),
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
 * 3. Mode: Extracts "Mode: <mode>" section from context then global (if mode provided)
 *
 * File search order: AGENTS.md → AGENT.md → CLAUDE.md
 * Local variants: AGENTS.local.md appended if found (for .gitignored personal preferences)
 *
 * @param metadata - Workspace metadata (contains projectPath)
 * @param runtime - Runtime for reading workspace files (supports SSH)
 * @param workspacePath - Workspace directory path
 * @param mode - Optional mode name (e.g., "plan", "exec")
 * @param additionalSystemInstructions - Optional instructions appended last
 * @param modelString - Active model identifier used for Model-specific sections
 * @param mcpServers - Optional MCP server configuration (name -> command)
 * @throws Error if metadata or workspacePath invalid
 */
export async function buildSystemMessage(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspacePath: string,
  mode?: string,
  additionalSystemInstructions?: string,
  modelString?: string,
  mcpServers?: MCPServerMap,
  options?: {
    variant?: "default" | "agent";
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

  if (options?.variant === "agent") {
    const agentPrompt = options.agentSystemPrompt?.trim();
    if (agentPrompt) {
      systemMessage += `\n<agent-instructions>\n${agentPrompt}\n</agent-instructions>`;
    }
    return systemMessage;
  }

  // Read instruction sets
  const [globalInstructions, contextInstructions] = await readInstructionSources(
    metadata,
    runtime,
    workspacePath
  );

  // Combine: global + context (workspace takes precedence over project) after stripping scoped sections
  const sanitizeScopedInstructions = (input?: string | null): string | undefined => {
    if (!input) return undefined;
    const stripped = stripScopedInstructionSections(input);
    return stripped.trim().length > 0 ? stripped : undefined;
  };

  const customInstructionSources = [
    sanitizeScopedInstructions(globalInstructions),
    sanitizeScopedInstructions(contextInstructions),
  ].filter((value): value is string => Boolean(value));
  const customInstructions = customInstructionSources.join("\n\n");

  // Extract mode-specific section (context first, then global fallback)
  let modeContent: string | null = null;
  if (mode) {
    modeContent =
      (contextInstructions && extractModeSection(contextInstructions, mode)) ??
      (globalInstructions && extractModeSection(globalInstructions, mode)) ??
      null;
  }

  // Extract model-specific section based on active model identifier (context first)
  let modelContent: string | null = null;
  if (modelString) {
    modelContent =
      (contextInstructions && extractModelSection(contextInstructions, modelString)) ??
      (globalInstructions && extractModelSection(globalInstructions, modelString)) ??
      null;
  }

  if (customInstructions) {
    systemMessage += `\n<custom-instructions>\n${customInstructions}\n</custom-instructions>`;
  }

  const modeSection = buildTaggedSection(modeContent, mode, "mode");
  if (modeSection) {
    systemMessage += modeSection;
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
