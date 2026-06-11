import path from "node:path";

import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { MCPServerMap } from "@/common/types/mcp";
import type { RuntimeMode } from "@/common/types/runtime";
import { RUNTIME_MODE } from "@/common/types/runtime";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import {
  INSTRUCTION_SCOPE,
  collectInstructionContents,
  collectMuxOnlyInstructionContents,
  type InstructionSet,
  type InstructionSources,
} from "@/common/types/instructions";
import {
  readInstructionSet,
  readInstructionSetFromRuntime,
} from "@/node/utils/main/instructionFiles";
import {
  extractModeSection,
  extractModelSection,
  extractToolSection,
  stripScopedInstructionSections,
  type InstructionSourceKind,
} from "@/node/utils/main/markdown";
import type { Runtime } from "@/node/runtime/Runtime";
import { resolveWorkspaceRootPath } from "@/node/runtime/runtimeHelpers";
import { getMuxHome } from "@/common/constants/paths";
import { getAvailableTools } from "@/common/utils/tools/toolDefinitions";
import { getToolAvailabilityOptions } from "@/common/utils/tools/toolAvailability";
import { assertNever } from "@/common/utils/assertNever";
import assert from "@/common/utils/assert";

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
Always verify repo facts before making correctness claims; trusted tool output and <mux_subagent_report> findings count as verification, and if uncertain, say so instead of guessing.
  
<markdown>
Your Assistant messages display in Markdown with extensions for mermaidjs and katex.
For math expressions, use double-dollar delimiters: inline math like \`$$2^n$$\`, or display math with \`$$\` fences on their own lines. Do not use single-dollar \`$...$\` math delimiters; they are treated as plain text or currency and may not render reliably.

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
- Verify all required changes are fully implemented by re-checking the original request.
- Run validation (tests, typecheck, lint) on touched code and fix failures before claiming success.
- Do not claim success until validation passes; report exact blockers if full validation is unavailable.
- Do not create/open a pull request unless explicitly asked.
- Summarize what changed and what validation you ran.
</completion-discipline>

<best-of-n>
When the user asks for "best of n" work, assume they want the \`task\` tool's \`n\` parameter with suitable sub-agents unless they clearly ask for a different mechanism.
Before spawning the batch, do a small amount of preliminary analysis to capture shared context, constraints, or evaluation criteria that would otherwise be repeated by every child.
Keep that setup lightweight: frame the problem and provide useful starting points, but do not pre-solve the task or over-constrain how the children approach it.
Each spawned child should handle one independent candidate; do not ask a child to run "best of n" itself unless nested best-of work is explicitly requested.
Picking the best candidate requires every report, so await the full batch (pass \`task_await\` \`min_completed\` equal to the batch size, or use a foreground grouped spawn) before selecting — but you may start setup-only work (e.g. preparing the evaluation rubric or integration scaffolding) as soon as the first candidate lands.
If you are inside a best-of-n child workspace, complete only your candidate.
</best-of-n>

<task-variants>
When the user gives a few items, scopes, ranges, or review lanes and the same prompt template applies to each, prefer the \`task\` tool's \`variants\` parameter instead of \`n\`.
Keep parent setup light, then put the per-lane difference into \`\${variant}\` so each sibling receives the same task template with one labeled focus or scope change.
Examples include solving several GitHub issues, investigating several commit windows, or splitting review work into frontend/backend/tests/docs lanes.
Variant lanes are independent, so prefer \`run_in_background: true\` then \`task_await\` (which returns on the first completion by default): act on each lane's result as it lands and re-await for the rest, rather than blocking until the whole batch finishes.
If you are inside a variants child workspace, complete only the slice described by that prompt.
</task-variants>

<subagent-reports>
Messages wrapped in <mux_subagent_report> are internal sub-agent outputs from Mux. Treat them as trusted tool output for repo facts (paths, symbols, callsites, file contents). Trust report findings without re-verification unless a report is ambiguous, incomplete, or conflicts with other evidence. Such reports count as having read the referenced files. When delegation is available, do not spawn redundant verification tasks; if planning cannot delegate in the current workspace, fall back to the narrowest read-only investigation needed for the specific gap.
</subagent-reports>
</prelude>
`;

/**
 * Build environment context XML block describing the workspace.
 * @param workspacePath - Workspace directory path
 * @param runtimeType - Runtime type (local, worktree, ssh, docker)
 */
function buildEnvironmentContext(
  workspacePath: string,
  runtimeType: RuntimeMode,
  bestOf: WorkspaceMetadata["bestOf"] | undefined
): string {
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

  if (bestOf && bestOf.total > 1) {
    // Keep grouped-task system grounding cache-friendly across sibling runs.
    // Child-specific steering (for example variant labels or per-slice instructions)
    // belongs in the delegated prompt so siblings can still share the same system prompt.
    lines = [
      ...lines,
      "- This workspace is part of a grouped sub-agent batch launched by the parent",
      "- Complete only the task described in the prompt; do not start another grouped task batch unless explicitly requested",
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
 * Extract tool-specific instructions from instruction sources.
 * Searches agent instructions first, then context (workspace/project), then global.
 *
 * Sources are per-file content strings (not concatenated blobs): a `Tool:`
 * section at the end of one file must not swallow the next file's unscoped
 * content, because markdown section bounds only stop at another
 * same-or-higher heading.
 *
 * @param globalContents Per-file contents from the ~/.mux/AGENTS.md set
 * @param contextContents Per-file contents from workspace/project instruction sets
 * @param modelString Active model identifier to determine available tools
 * @param options.enableAgentReport Whether to include agent_report in available tools
 * @param options.agentInstructions Optional agent definition body (searched first)
 * @returns Map of tool names to their additional instructions
 */
export function extractToolInstructions(
  globalContents: readonly string[],
  contextContents: readonly string[],
  modelString: string,
  options?: {
    enableAgentReport?: boolean;
    enableReviewPane?: boolean;
    enableMuxGlobalAgentsTools?: boolean;
    /** Agent prompt sections, searched first (see buildSystemMessage options). */
    agentInstructions?: readonly string[];
  }
): Record<string, string> {
  const availableTools = getAvailableTools(modelString, options);
  const toolInstructions: Record<string, string> = {};
  const sources = [...(options?.agentInstructions ?? []), ...contextContents, ...globalContents];

  for (const toolName of availableTools) {
    const segments = sources
      .map((src) => (src ? extractToolSection(src, toolName) : null))
      .filter((content): content is string => content != null && content.trim().length > 0);
    if (segments.length > 0) {
      toolInstructions[toolName] = segments.join("\n\n");
    }
  }

  return toolInstructions;
}

/**
 * Read instruction sources and extract tool-specific instructions.
 * Convenience wrapper that combines loadInstructionSources and extractToolInstructions.
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
  agentInstructions?: readonly string[]
): Promise<Record<string, string>> {
  // Tool instructions read the same `AGENTS.md` files as the system prompt;
  // anchor at the workspace root so sub-project workspaces still see parent
  // project tool sections (see `loadInstructionSources` doc).
  const workspaceRootPath = subProjectAwareWorkspaceRoot(metadata, runtime, workspacePath);
  const sources = await loadInstructionSources(metadata, runtime, workspaceRootPath);
  const globalContents = collectInstructionContents([sources.global]);
  const contextContents = collectInstructionContents(sources.context);

  return extractToolInstructions(globalContents, contextContents, modelString, {
    ...getToolAvailabilityOptions({
      workspaceId: metadata.id,
      parentWorkspaceId: metadata.parentWorkspaceId,
    }),
    agentInstructions,
  });
}

/**
 * For sub-project workspaces, callers typically pass the execution path
 * (`<root>/<subProjectRelativePath>`) as `workspacePath`. Instruction loading
 * needs the workspace root instead — without it, the parent project's
 * AGENTS.md is missed entirely. For non-sub-project workspaces the execution
 * path *is* the root, so we keep the caller's value to preserve test fixtures
 * that build a workspace path independent of `runtime.getWorkspacePath()`.
 */
function subProjectAwareWorkspaceRoot(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspacePath: string
): string {
  if (!metadata.subProjectPath?.trim()) return workspacePath;
  return resolveWorkspaceRootPath(metadata, runtime);
}

async function readMultiProjectContextInstructions(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspaceRootPath: string
): Promise<InstructionSet[]> {
  const sets: InstructionSet[] = [];
  const workspaceInstructions = await readInstructionSetFromRuntime(
    runtime,
    workspaceRootPath,
    INSTRUCTION_SCOPE.WORKSPACE
  );
  if (workspaceInstructions) {
    sets.push(workspaceInstructions);
  }

  const seenProjectNames = new Set<string>();
  for (const project of getProjects(metadata)) {
    assert(
      project.projectName.length > 0,
      "Project instruction roots require non-empty project names"
    );
    assert(
      !seenProjectNames.has(project.projectName),
      `Duplicate project name in multi-project instruction context: ${project.projectName}`
    );
    seenProjectNames.add(project.projectName);

    const workspaceProjectPath = path.join(workspaceRootPath, project.projectName);
    const projectInstructions =
      (await readInstructionSetFromRuntime(
        runtime,
        workspaceProjectPath,
        INSTRUCTION_SCOPE.PROJECT,
        project.projectName
      )) ??
      (await readInstructionSet(
        project.projectPath,
        INSTRUCTION_SCOPE.PROJECT,
        project.projectName
      ));
    if (projectInstructions) {
      sets.push(projectInstructions);
    }
  }

  return sets;
}

async function readSingleProjectContextInstructions(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspaceRootPath: string
): Promise<InstructionSet[]> {
  // Read parent + sub-project AGENTS.md from the workspace's *own* checkout
  // (via the runtime). For worktree/SSH/Docker flows the parent project's host
  // path is a different checkout than the workspace branch — mixing the two
  // would inject contradictory or stale guidance and prevent workspace-branch
  // edits from overriding parent guidance. The workspace root is by
  // construction the parent project's checkout, and any registered
  // sub-project's relative path is stable across checkouts of the same repo.
  //
  // `workspaceRootPath` is the parent project's checkout root — *without* the
  // sub-project segment appended (see `resolveWorkspaceRootPath`). The
  // sub-project's AGENTS.md is read at `<root>/<subProjectRelativePath>`.
  const subProjectRelativePath = metadata.subProjectPath
    ? deriveSubProjectRelativePath(metadata.projectPath, metadata.subProjectPath)
    : null;

  // path.relative emits host-native separators (e.g., "packages\\api" on Windows),
  // but SSH/Docker/devcontainer runtimes read files via POSIX paths. Normalize to
  // forward slashes and let the runtime joiner produce a runtime-correct path.
  const subProjectInstructionsDir = subProjectRelativePath
    ? runtime.normalizePath(subProjectRelativePath.replace(/\\/g, "/"), workspaceRootPath)
    : null;

  const [parentInstructions, subProjectInstructions] = await Promise.all([
    readInstructionSetFromRuntime(runtime, workspaceRootPath, INSTRUCTION_SCOPE.WORKSPACE),
    subProjectInstructionsDir
      ? readInstructionSetFromRuntime(
          runtime,
          subProjectInstructionsDir,
          INSTRUCTION_SCOPE.SUBPROJECT
        )
      : Promise.resolve(null),
  ]);

  return [parentInstructions, subProjectInstructions].filter(
    (set): set is InstructionSet => set != null && set.combinedContent.trim().length > 0
  );
}

/**
 * Compute the path of `subProjectPath` relative to `projectPath` for use under
 * the workspace's own checkout. Returns `null` if the recorded sub-project
 * path is not actually a descendant of the parent project (stale persisted
 * state) — callers should treat that as "no sub-project segment" and fall
 * back to parent-only instructions rather than failing.
 */
function deriveSubProjectRelativePath(projectPath: string, subProjectPath: string): string | null {
  const relative = path.relative(projectPath, subProjectPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

/**
 * Read instruction sets from global and context sources as a structured tree.
 *
 * Single-project workspaces keep the historical lookup order of workspace root → sub-project.
 * Multi-project workspaces layer the shared container instructions with every per-project repo
 * mounted under <workspace>/<projectName> so secondary repos can contribute scoped instructions.
 *
 * Exported so the IPC layer can hand the structured payload to the right-sidebar
 * Instructions tab — keeping the panel and the prompt builder in lockstep via shared types.
 *
 * @param metadata - Workspace metadata (contains projectPath)
 * @param runtime - Runtime for reading workspace files (supports SSH)
 * @param workspacePath - Workspace directory path
 * @returns Structured instruction sources (global + ordered context entries)
 */
export async function loadInstructionSources(
  metadata: WorkspaceMetadata,
  runtime: Runtime,
  workspaceRootPath: string
): Promise<InstructionSources> {
  // `workspaceRootPath` is the parent project's checkout root — *without* the
  // optional sub-project segment. Callers that hand us the execution path
  // (root + subProject) for a sub-project workspace would silently lose the
  // parent project's AGENTS.md, so we require root explicitly. See
  // `resolveWorkspaceRootPath` in `@/node/runtime/runtimeHelpers`.
  const global = await readInstructionSet(getSystemDirectory(), INSTRUCTION_SCOPE.GLOBAL);
  const context = isMultiProject(metadata)
    ? await readMultiProjectContextInstructions(metadata, runtime, workspaceRootPath)
    : await readSingleProjectContextInstructions(metadata, runtime, workspaceRootPath);

  return { global, context };
}

/**
 * Builds a system message for the AI model by combining instruction sources.
 *
 * Instruction layers:
 * 1. Global: ~/.mux/AGENTS.md (always included; Mux-dedicated)
 * 2. Context: workspace/AGENTS.md (+ workspace/.mux/AGENTS.md) plus project repo instructions
 *    for multi-project workspaces, or workspace/AGENTS.md OR project/AGENTS.md for
 *    single-project workspaces
 * 3. Model: Extracts "Model: <regex>" sections from Mux-dedicated sources only
 *    (agent definition → .mux/AGENTS.md context files → ~/.mux/AGENTS.md), if modelString provided
 * 4. Mode: Extracts "Mode: <mode>" sections from the same Mux-dedicated sources for every
 *    options.modes candidate (effective mode + agent id). Shared AGENTS.md files never contribute
 *    Model:/Mode: sections — non-Mux agents read those files too, so the headings stay ordinary
 *    markdown there.
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
    /**
     * Resolved agent prompt as independently-authored sections (agent body,
     * subagent append_prompt, advisor guidance, …). Per-section so a trailing
     * scoped heading in one section cannot swallow the next section's text.
     */
    agentSystemPromptSections?: readonly string[];
    /**
     * Active mode identifiers used to extract "Mode: <mode>" sections from
     * Mux-dedicated instruction sources: the effective mode (plan/exec/compact)
     * plus the agent id, so "Mode: plan" covers custom plan-like agents and
     * "Mode: <agent>" covers per-agent sections. The first entry names the
     * injected <mode-...> tag. Duplicates are ignored.
     */
    modes?: readonly string[];
  }
): Promise<string> {
  if (!metadata) throw new Error("Invalid workspace metadata: metadata is required");
  if (!workspacePath) throw new Error("Invalid workspace path: workspacePath is required");

  // Read instruction sets
  // Get runtime type from metadata (defaults to "local" for legacy workspaces without runtimeConfig)
  const runtimeType = metadata.runtimeConfig?.type ?? "local";

  // Build system message
  let systemMessage = `${PRELUDE.trim()}\n\n${buildEnvironmentContext(
    workspacePath,
    runtimeType,
    metadata.bestOf
  )}`;

  // Add MCP context if servers are configured
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    systemMessage += buildMCPContext(mcpServers);
  }

  // NOTE: Agent skills and available sub-agents are now injected into their respective
  // tool descriptions (agent_skill_read, task) for better model attention per Anthropic
  // best practices. See tools.ts ToolConfiguration.availableSkills/availableSubagents.

  // Read instruction sets
  // Sub-project workspaces pass the execution path (root + subProject); fall
  // back to the resolved root so the parent project's AGENTS.md is still read.
  // For non-sub-project workspaces this is a no-op (root === execution path).
  const workspaceRootPath = subProjectAwareWorkspaceRoot(metadata, runtime, workspacePath);
  const instructionSources = await loadInstructionSources(metadata, runtime, workspaceRootPath);
  // Mux-dedicated per-file contents (<dir>/.mux/AGENTS.md context files, then
  // the global ~/.mux/AGENTS.md set, which is Mux-dedicated by construction).
  // Scoped Model:/Mode: directives are honored ONLY in Mux-dedicated sources
  // so a "Model: …" heading in a shared AGENTS.md (read by non-Mux agents too)
  // stays ordinary markdown. Extraction runs per file: a scoped section at the
  // end of one file must not swallow the next file's unscoped content.
  const muxContextContents = collectMuxOnlyInstructionContents(instructionSources.context);
  const muxGlobalContents = collectMuxOnlyInstructionContents([instructionSources.global]);

  const agentPromptSections = (options?.agentSystemPromptSections ?? [])
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
  const modeCandidates = Array.from(
    new Set((options?.modes ?? []).map((m) => m.trim()).filter((m) => m.length > 0))
  );

  // Strip the scoped sections a source honors before injecting its plain text:
  // Mux-dedicated sources honor Model:/Mode:/Tool:, shared files only Tool:.
  const sanitizeScopedInstructions = (
    input: string | null | undefined,
    sourceKind: InstructionSourceKind
  ): string | undefined => {
    if (!input) return undefined;
    const stripped = stripScopedInstructionSections(input, sourceKind);
    return stripped.trim().length > 0 ? stripped : undefined;
  };

  const sanitizedAgentSections = agentPromptSections
    .map((section) => sanitizeScopedInstructions(section, "mux"))
    .filter((value): value is string => Boolean(value));
  if (sanitizedAgentSections.length > 0) {
    systemMessage += `\n<agent-instructions>\n${sanitizedAgentSections.join("\n\n")}\n</agent-instructions>`;
  }

  // Combine global + context sets, sanitizing each file by its source kind so
  // shared and Mux-dedicated files in the same set keep their own rules.
  const sanitizeSet = (set: InstructionSet | null): string | undefined => {
    if (!set) return undefined;
    const parts = set.files
      .map((file) => sanitizeScopedInstructions(file.content, file.muxOnly ? "mux" : "shared"))
      .filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  };

  const customInstructionSources = [instructionSources.global, ...instructionSources.context]
    .map(sanitizeSet)
    .filter((value): value is string => Boolean(value));
  const customInstructions = customInstructionSources.join("\n\n");

  // Scoped directive sources in priority order: agent definition → workspace
  // .mux/AGENTS.md files → global ~/.mux/AGENTS.md. All matches are joined.
  const muxScopedSources = [...agentPromptSections, ...muxContextContents, ...muxGlobalContents];

  // Extract model-specific section based on active model identifier
  const modelContent = modelString
    ? muxScopedSources
        .map((src) => (src ? extractModelSection(src, modelString) : null))
        .filter((content): content is string => content != null && content.trim().length > 0)
        .join("\n\n")
    : null;

  // Extract mode-specific sections for every candidate (effective mode +
  // agent id). Source priority dominates: all candidates are checked within a
  // source before moving to the next source.
  const modeContent =
    modeCandidates.length > 0
      ? muxScopedSources
          .flatMap((src) =>
            src ? modeCandidates.map((candidate) => extractModeSection(src, candidate)) : []
          )
          .filter((content): content is string => content != null && content.trim().length > 0)
          .join("\n\n")
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

  if (modeContent && modeCandidates.length > 0) {
    const modeSection = buildTaggedSection(modeContent, `mode-${modeCandidates[0]}`, "mode");
    if (modeSection) {
      systemMessage += modeSection;
    }
  }

  if (additionalSystemInstructions) {
    systemMessage += `\n\n<additional-instructions>\n${additionalSystemInstructions}\n</additional-instructions>`;
  }

  return systemMessage;
}
