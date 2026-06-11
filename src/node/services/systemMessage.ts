import path from "node:path";

import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { MCPServerMap } from "@/common/types/mcp";
import type { RuntimeMode } from "@/common/types/runtime";
import { RUNTIME_MODE } from "@/common/types/runtime";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import {
  INSTRUCTION_SCOPE,
  joinInstructionSets,
  type InstructionSet,
  type InstructionSources,
} from "@/common/types/instructions";
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
 *
 * Sub-project workspaces are framed identically to regular projects: the cwd
 * (already the sub-project directory thanks to resolveWorkspaceExecutionPath)
 * is presented as "the project" with no parent-repo callout. The agent does
 * not need to know about the parent's existence to do work — it just sees a
 * project rooted at this directory.
 *
 * @param workspacePath - Workspace directory path (cwd; for sub-projects this is already the sub-project path)
 * @param runtimeType - Runtime type (local, worktree, ssh, docker)
 * @param bestOf - Best-of grouping metadata for sibling sub-agent batches
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
    enableReviewPane?: boolean;
    enableMuxGlobalAgentsTools?: boolean;
    agentInstructions?: string;
  }
): Record<string, string> {
  const availableTools = getAvailableTools(modelString, options);
  const toolInstructions: Record<string, string> = {};
  const sources = {
    agent: options?.agentInstructions ?? null,
    context: contextInstructions,
    global: globalInstructions,
  };

  for (const toolName of availableTools) {
    const segments = [sources.agent, sources.context, sources.global]
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
  agentInstructions?: string
): Promise<Record<string, string>> {
  // Tool instructions read the same `AGENTS.md` files as the system prompt;
  // anchor at the workspace root so sub-project workspaces still see parent
  // project tool sections (see `loadInstructionSources` doc).
  const workspaceRootPath = subProjectAwareWorkspaceRoot(metadata, runtime, workspacePath);
  const sources = await loadInstructionSources(metadata, runtime, workspaceRootPath);
  const globalInstructions = sources.global?.combinedContent ?? null;
  const contextInstructions = joinInstructionSets(sources.context) || null;

  return extractToolInstructions(globalInstructions, contextInstructions, modelString, {
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
  const subProjectPath = metadata.subProjectPath?.trim();
  if (!subProjectPath) return workspacePath;
  // If persisted sub-project metadata is stale, instruction loading should
  // degrade to the caller's cwd instead of treating some unrelated path as a
  // parent root. Normal execution already self-heals stale sub-project paths to
  // the root, so this preserves the active cwd either way.
  const subProjectRelativePath = deriveSubProjectRelativePath(metadata.projectPath, subProjectPath);
  if (!subProjectRelativePath) return workspacePath;
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
  // Sub-project workspaces should look like regular projects in <environment>
  // and tool descriptions, while still inheriting the parent project's
  // AGENTS.md. We therefore load parent then sub-project from the workspace's
  // own checkout and add only lightweight path-source headings/comments to the
  // prompt content so relative-path guidance remains anchored to the directory
  // where each segment was authored.
  const subProjectRelativePath = metadata.subProjectPath
    ? deriveSubProjectRelativePath(metadata.projectPath, metadata.subProjectPath)
    : null;

  // path.relative emits host-native separators (e.g., "packages\\api" on Windows),
  // but SSH/Docker/devcontainer runtimes read files via POSIX paths. Normalize to
  // forward slashes and let the runtime joiner produce a runtime-correct path.
  const normalizedSubProjectRelativePath = subProjectRelativePath?.replace(/\\/g, "/") ?? null;
  const subProjectInstructionsDir = normalizedSubProjectRelativePath
    ? runtime.normalizePath(normalizedSubProjectRelativePath, workspaceRootPath)
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

  // Non-sub-project workspaces and stale sub-project metadata preserve the
  // historical prompt: one unwrapped AGENTS.md source, no path-source markers.
  if (!normalizedSubProjectRelativePath) {
    return [parentInstructions].filter(
      (set): set is InstructionSet => set != null && set.combinedContent.trim().length > 0
    );
  }

  const parentAgentsMdRelativePath = parentAgentsMdRelativePathForSubProject(
    normalizedSubProjectRelativePath
  );
  const taggedParentInstructions = parentInstructions
    ? tagInstructionSetContent(parentInstructions, parentAgentsMdRelativePath)
    : null;
  const taggedSubProjectInstructions = subProjectInstructions
    ? tagInstructionSetContent(subProjectInstructions, "./AGENTS.md")
    : null;

  return [taggedParentInstructions, taggedSubProjectInstructions].filter(
    (set): set is InstructionSet => set != null && set.combinedContent.trim().length > 0
  );
}

/**
 * Match an ATX-style scoped heading line at any heading level (`## Tool: bash`,
 * `### Model: …`, etc.). Used by `tagAgentsSegment` to find heading lines
 * that should receive an injected path-source comment.
 *
 * Per CommonMark §4.2, ATX headings may start with up to 3 spaces of
 * indentation and still be parsed as headings — markdown-it recognizes
 * these and the downstream `extractToolSection`/`extractModelSection`
 * extract them. Allow the same optional leading spaces here so the scanner
 * stays aligned with the parser used downstream; otherwise an indented
 * `   ## Tool: bash` heading would survive into the per-tool prompt
 * without provenance.
 *
 * Setext-style headings (underline form) are intentionally not handled —
 * the codebase consistently uses ATX for AGENTS.md scoped headings, and
 * supporting setext would require AST-based injection.
 */
const SCOPED_HEADING_LINE_REGEX = /^ {0,3}#{1,6}\s+(?:Tool|Model):/i;

/**
 * Match a CommonMark-style fenced-code-block delimiter line: three or more
 * backticks or tildes at the start of the line (with up to 3 leading
 * spaces, per CommonMark §4.5). Capture group 1 is the fence marker, group
 * 2 is anything after the marker (info string, trailing whitespace, etc.).
 *
 * The two captures are required because opening and closing fences obey
 * different rules:
 *
 *   - An opening fence may carry an info string (`` ```markdown ``,
 *     `` ```ts ``, etc.).
 *   - A closing fence must have NO info string — only optional trailing
 *     whitespace. Anything else (e.g. `` ```ts `` inside an outer
 *     `` ```markdown `` fence) is parsed by markdown-it as still-inside-
 *     the-fence content, NOT as a closer.
 */
const FENCE_LINE_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)/;

/**
 * Wrap a sub-project AGENTS.md segment with path-source markers so the
 * agent can resolve relative path references in each segment to the right
 * root, and so scoped sections inside the segment don't accidentally span
 * across the segment join.
 *
 * The wrapper does two things:
 *
 *   1. Emit an H1 heading with the source path as the heading body
 *      (e.g. `` # `../../AGENTS.md` ``). This is a visible note that names
 *      the segment's source AND bounds any scoped `## Tool:` / `## Model:`
 *      sections inside the segment. Without an H1 boundary, a scoped
 *      section in the parent segment would extend across the join into
 *      the sub-project's narrative — `stripScopedInstructionSections`
 *      would then delete the sub-project's narrative along with the
 *      parent's scoped section.
 *
 *   2. Inject a markdown-invisible HTML comment with the same path
 *      immediately after every ATX-style `## Tool:` / `## Model:` heading
 *      in the segment. The H1 above doesn't survive scoped extraction
 *      (extractToolSection returns the section body, not the surrounding
 *      H1), so the inner HTML comment carries the path provenance into
 *      per-tool/per-model contexts.
 *
 *      Heading-line scanning is fence-aware: scoped-looking lines that
 *      sit inside a fenced code block (e.g. an AGENTS.md authored with a
 *      `markdown` example showing how to structure scoped sections) do
 *      NOT receive an injected comment. The downstream markdown parser
 *      used by `stripScopedInstructionSections` / `extractToolSection`
 *      correctly ignores fenced content, so injecting there would only
 *      corrupt the documented example without serving any provenance
 *      purpose.
 *
 * The visible H1 heading is deliberately a lightweight `path note` rather
 * than the v1 framing `# Project context (root: …)`: it tells the agent
 * which directory the segment was authored against without dressing the
 * sub-project up as a special structural feature.
 */
function tagAgentsSegment(content: string, sourcePath: string): string {
  const comment = `<!-- ${sourcePath} -->`;
  const lines = content.split("\n");
  const out: string[] = [];
  // Tracks the marker that opened the current fence (e.g. "```" or "~~~~").
  // Closing fences must use the same character as the opener and at least
  // as many delimiters; null means we are not currently inside a fence.
  let openFence: string | null = null;

  for (const line of lines) {
    out.push(line);

    const fenceMatch = FENCE_LINE_REGEX.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const trailing = fenceMatch[2];
      if (openFence === null) {
        // Opening fence — info string is allowed and ignored here.
        openFence = marker;
      } else if (
        marker.startsWith(openFence[0]) &&
        marker.length >= openFence.length &&
        trailing.trim().length === 0
      ) {
        // Closing fence — must use the same character as the opener, be
        // at least as long, and carry NO info string (only optional
        // trailing whitespace). Per CommonMark §4.5, an inner line like
        // `` ```ts `` inside an outer `` ```markdown `` fence is NOT a
        // closer and the outer fence stays open.
        openFence = null;
      }
      continue;
    }

    if (openFence === null && SCOPED_HEADING_LINE_REGEX.test(line)) {
      out.push(comment);
    }
  }

  return `# \`${sourcePath}\`\n\n${out.join("\n")}`;
}

function tagInstructionSetContent(set: InstructionSet, sourcePath: string): InstructionSet {
  return {
    ...set,
    // Prompt-only wrapper: `files` stay as authored so the Instructions tab can
    // render the real file contents, while prompt consumers that read
    // `combinedContent` get path provenance for each flattened segment.
    combinedContent: tagAgentsSegment(set.combinedContent, sourcePath),
  };
}

/**
 * Compute the path of `subProjectPath` relative to `projectPath` for use under
 * the workspace's own checkout. Returns `null` if the recorded sub-project
 * path is not actually a descendant of the parent project (stale persisted
 * state) — callers should treat that as "no sub-project segment" and fall
 * back to unwrapped cwd/root instructions rather than failing.
 */
function deriveSubProjectRelativePath(projectPath: string, subProjectPath: string): string | null {
  const relative = path.relative(projectPath, subProjectPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function parentAgentsMdRelativePathForSubProject(posixRelativeSubProjectPath: string): string {
  // Depth = number of non-empty segments in the sub-project relative path,
  // which equals the number of "../" levels needed to climb from the cwd
  // to the parent root.
  const depth = posixRelativeSubProjectPath
    .split("/")
    .filter((segment) => segment.length > 0).length;
  return `${"../".repeat(depth)}AGENTS.md`;
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
 * 1. Global: ~/.mux/AGENTS.md (always included)
 * 2. Context: workspace/AGENTS.md plus project repo instructions for multi-project workspaces,
 *    or workspace/AGENTS.md OR project/AGENTS.md for single-project workspaces
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
  const globalInstructions = instructionSources.global?.combinedContent ?? null;
  // Concatenated context content for downstream string-based helpers
  // (`stripScopedInstructionSections`, `extractModelSection`, …). The structured
  // form lives in `instructionSources` for consumers that need per-file metadata.
  const contextInstructions = joinInstructionSets(instructionSources.context) || null;

  const agentPrompt = options?.agentSystemPrompt?.trim() ?? null;

  // Combine: global + concatenated project/sub-project/workspace after stripping scoped sections.
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
    ? [agentPrompt, contextInstructions, globalInstructions]
        .map((src) => (src ? extractModelSection(src, modelString) : null))
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

  if (additionalSystemInstructions) {
    systemMessage += `\n\n<additional-instructions>\n${additionalSystemInstructions}\n</additional-instructions>`;
  }

  return systemMessage;
}
