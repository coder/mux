import type { WorkspaceMetadata } from "@/common/types/workspace";
import {
  readInstructionSet,
  readInstructionSetFromRuntime,
} from "@/node/utils/main/instructionFiles";
import {
  extractModeSection,
  extractModelSection,
  stripScopedInstructionSections,
} from "@/node/utils/main/markdown";
import type { Runtime } from "@/node/runtime/Runtime";
import { getMuxHome } from "@/common/constants/paths";

// NOTE: keep this in sync with the docs/models.md file

// The PRELUDE is intentionally minimal to not conflict with the user's instructions.
// mux is designed to be model agnostic, and models have shown large inconsistency in how they
// follow instructions.

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
const PRELUDE = ` 
<prelude>
You are a coding agent.
  
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
</prelude>
`;

/**
 * Build environment context XML block describing the workspace.
 */
function buildEnvironmentContext(workspacePath: string): string {
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
 * Get the system directory where global mux configuration lives.
 * Users can place global AGENTS.md and .mux/PLAN.md files here.
 */
function getSystemDirectory(): string {
  return getMuxHome();
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
 * @throws Error if metadata or workspacePath invalid
 */
export async function buildSystemMessage(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspacePath: string,
  mode?: string,
  additionalSystemInstructions?: string,
  modelString?: string
): Promise<string> {
  if (!metadata) throw new Error("Invalid workspace metadata: metadata is required");
  if (!workspacePath) throw new Error("Invalid workspace path: workspacePath is required");

  // Read instruction sets
  const globalInstructions = await readInstructionSet(getSystemDirectory());
  const workspaceInstructions = await readInstructionSetFromRuntime(runtime, workspacePath);
  const contextInstructions =
    workspaceInstructions ?? (await readInstructionSet(metadata.projectPath));

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

  // Build system message
  let systemMessage = `${PRELUDE.trim()}\n\n${buildEnvironmentContext(workspacePath)}`;

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
