/**
 * Agent resolution: resolves the active agent and computes tool policy for a stream.
 *
 * Extracted from `streamMessage()` to make the agent resolution logic
 * explicit and testable. Contains:
 * - Agent ID normalization & fallback to exec
 * - Agent definition loading with error recovery
 * - Disabled-agent enforcement (subagent workspaces error, top-level falls back)
 * - Inheritance chain resolution + plan-like detection
 * - Task nesting depth enforcement
 * - Tool policy composition (agent → caller → system workspace)
 * - Sentinel tool name computation for agent transition detection
 */

import * as os from "os";
import { AgentIdSchema } from "@/common/orpc/schemas";
import { MUX_HELP_CHAT_AGENT_ID, MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import type { ErrorEvent } from "@/common/types/stream";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectsConfig } from "@/common/types/project";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import { applyToolPolicy, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { isPlanLikeInResolvedChain } from "@/common/utils/agentTools";
import type { Runtime } from "@/node/runtime/Runtime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import {
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { resolveToolPolicyForAgent } from "@/node/services/agentDefinitions/resolveToolPolicy";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import type { InitStateManager } from "./initStateManager";
import { createAssistantMessageId } from "./utils/messageIds";
import { createErrorEvent } from "./utils/sendMessageError";
import { getTaskDepthFromConfig } from "./taskUtils";
import { log } from "./log";
import { getErrorMessage } from "@/common/utils/errors";

/** Options for agent resolution. */
export interface ResolveAgentOptions {
  workspaceId: string;
  metadata: WorkspaceMetadata;
  runtime: Runtime;
  workspacePath: string;
  /** Requested agent ID from the frontend (may be undefined → defaults to exec). */
  requestedAgentId: string | undefined;
  /** When true, skip workspace-specific agents (for "unbricking" broken agent files). */
  disableWorkspaceAgents: boolean;
  modelString: string;
  /** Caller-supplied tool policy (applied AFTER agent policy for further restriction). */
  callerToolPolicy: ToolPolicy | undefined;
  /** Loaded config from Config.loadConfigOrDefault(). */
  cfg: ProjectsConfig;
  /** Emit an error event on the AIService EventEmitter (for disabled-agent subagent errors). */
  emitError: (event: ErrorEvent) => void;
  /** For sentinel tool name computation. */
  initStateManager: InitStateManager;
}

/** Result of agent resolution — all computed values needed by the stream pipeline. */
export interface AgentResolutionResult {
  effectiveAgentId: string;
  agentDefinition: Awaited<ReturnType<typeof readAgentDefinition>>;
  /** Path used for agent discovery (workspace path or project path if agents disabled). */
  agentDiscoveryPath: string;
  isSubagentWorkspace: boolean;
  /** Whether the resolved agent inherits plan-like behavior (has propose_plan in tool chain). */
  agentIsPlanLike: boolean;
  effectiveMode: "plan" | "exec" | "compact";
  taskSettings: ProjectsConfig["taskSettings"] & {};
  taskDepth: number;
  shouldDisableTaskToolsForDepth: boolean;
  /** Composed tool policy: agent → caller → system workspace (in application order). */
  effectiveToolPolicy: ToolPolicy | undefined;
  /** Tool names for agent transition sentinel injection in message preparation. */
  toolNamesForSentinel: string[];
}

/**
 * Resolve the active agent and compute tool policy for a stream request.
 *
 * This is the first major phase of `streamMessage()` after workspace/runtime setup.
 * It determines which agent definition to use, whether plan mode is active, and what
 * tools are available (via policy). The result feeds into message preparation,
 * system prompt construction, and tool assembly.
 *
 * Returns `Err` only when a disabled agent is requested in a subagent workspace
 * (top-level workspaces silently fall back to exec).
 */
export async function resolveAgentForStream(
  opts: ResolveAgentOptions
): Promise<Result<AgentResolutionResult, SendMessageError>> {
  const {
    workspaceId,
    metadata,
    runtime,
    workspacePath,
    requestedAgentId: rawAgentId,
    disableWorkspaceAgents,
    modelString,
    callerToolPolicy,
    cfg,
    emitError,
    initStateManager,
  } = opts;

  const workspaceLog = log.withFields({ workspaceId, workspaceName: metadata.name });

  // --- Agent ID resolution ---
  // Precedence:
  // - Child workspaces (tasks) use their persisted agentId/agentType.
  // - Main workspaces use the requested agentId (frontend), falling back to exec.
  const requestedAgentIdRaw =
    workspaceId === MUX_HELP_CHAT_WORKSPACE_ID
      ? MUX_HELP_CHAT_AGENT_ID
      : ((metadata.parentWorkspaceId ? (metadata.agentId ?? metadata.agentType) : undefined) ??
        (typeof rawAgentId === "string" ? rawAgentId : undefined) ??
        "exec");
  const requestedAgentIdNormalized = requestedAgentIdRaw.trim().toLowerCase();
  const parsedAgentId = AgentIdSchema.safeParse(requestedAgentIdNormalized);
  const requestedAgentId = parsedAgentId.success ? parsedAgentId.data : ("exec" as const);
  let effectiveAgentId = requestedAgentId;

  // When disableWorkspaceAgents is true, skip workspace-specific agents entirely.
  // Use project path so only built-in/global agents are available. This allows "unbricking"
  // when iterating on agent files — a broken agent in the worktree won't affect message sending.
  const agentDiscoveryPath = disableWorkspaceAgents ? metadata.projectPath : workspacePath;

  const isSubagentWorkspace = Boolean(metadata.parentWorkspaceId);

  // --- Load agent definition (with fallback to exec) ---
  let agentDefinition;
  try {
    agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, effectiveAgentId);
  } catch (error) {
    workspaceLog.warn("Failed to load agent definition; falling back to exec", {
      effectiveAgentId,
      agentDiscoveryPath,
      disableWorkspaceAgents,
      error: getErrorMessage(error),
    });
    agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, "exec");
  }

  // Keep agent ID aligned with the actual definition used (may fall back to exec).
  effectiveAgentId = agentDefinition.id;

  // --- Disabled-agent enforcement ---
  // Disabled agents should never run as sub-agents, even if a task workspace already exists
  // on disk (e.g., config changed since creation).
  // For top-level workspaces, fall back to exec to keep the workspace usable.
  if (agentDefinition.id !== "exec") {
    try {
      const resolvedFrontmatter = await resolveAgentFrontmatter(
        runtime,
        agentDiscoveryPath,
        agentDefinition.id
      );

      const effectivelyDisabled = isAgentEffectivelyDisabled({
        cfg,
        agentId: agentDefinition.id,
        resolvedFrontmatter,
      });

      if (effectivelyDisabled) {
        const errorMessage = `Agent '${agentDefinition.id}' is disabled.`;

        if (isSubagentWorkspace) {
          const errorMessageId = createAssistantMessageId();
          emitError(
            createErrorEvent(workspaceId, {
              messageId: errorMessageId,
              error: errorMessage,
              errorType: "unknown",
            })
          );
          return Err({ type: "unknown", raw: errorMessage });
        }

        workspaceLog.warn("Selected agent is disabled; falling back to exec", {
          agentId: agentDefinition.id,
          requestedAgentId,
        });
        agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, "exec");
        effectiveAgentId = agentDefinition.id;
      }
    } catch (error: unknown) {
      // Best-effort only — do not fail a stream due to disablement resolution.
      workspaceLog.debug("Failed to resolve agent enablement; continuing", {
        agentId: agentDefinition.id,
        error: getErrorMessage(error),
      });
    }
  }

  // --- Inheritance chain & plan-like detection ---
  const agentsForInheritance = await resolveAgentInheritanceChain({
    runtime,
    workspacePath: agentDiscoveryPath,
    agentId: agentDefinition.id,
    agentDefinition,
    workspaceId,
  });

  const agentIsPlanLike = isPlanLikeInResolvedChain(agentsForInheritance);
  const effectiveMode =
    agentDefinition.id === "compact" ? "compact" : agentIsPlanLike ? "plan" : "exec";

  // --- Task nesting depth enforcement ---
  const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
  const taskDepth = getTaskDepthFromConfig(cfg, workspaceId);
  const shouldDisableTaskToolsForDepth = taskDepth >= taskSettings.maxTaskNestingDepth;

  // --- Tool policy composition ---
  // Agent policy establishes baseline (deny-all + enable whitelist + runtime restrictions).
  // Caller policy then narrows further if needed.
  const agentToolPolicy = resolveToolPolicyForAgent({
    agents: agentsForInheritance,
    isSubagent: isSubagentWorkspace,
    disableTaskToolsForDepth: shouldDisableTaskToolsForDepth,
  });

  // The Chat with Mux system workspace must remain sandboxed regardless of caller-supplied
  // toolPolicy (defense-in-depth).
  const systemWorkspaceToolPolicy: ToolPolicy | undefined =
    workspaceId === MUX_HELP_CHAT_WORKSPACE_ID
      ? [
          { regex_match: ".*", action: "disable" },

          // Allow skill management (list/read/write/delete) and global agent
          // config, while keeping filesystem/binary execution locked down.
          { regex_match: "agent_skill_read", action: "enable" },
          { regex_match: "agent_skill_read_file", action: "enable" },
          { regex_match: "agent_skill_list", action: "enable" },
          { regex_match: "agent_skill_write", action: "enable" },
          { regex_match: "agent_skill_delete", action: "enable" },

          { regex_match: "mux_global_agents_read", action: "enable" },
          { regex_match: "mux_global_agents_write", action: "enable" },
          { regex_match: "ask_user_question", action: "enable" },
          { regex_match: "todo_read", action: "enable" },
          { regex_match: "todo_write", action: "enable" },
          { regex_match: "status_set", action: "enable" },
          { regex_match: "notify", action: "enable" },
        ]
      : undefined;

  // Caller require policies (e.g. task completion enforcement) must take precedence.
  // Drop agent-level require filters in that case to avoid multiple-required-tool conflicts.
  const callerRequiresTool =
    callerToolPolicy?.some((filter) => filter.action === "require") === true;
  const agentToolPolicyForComposition = callerRequiresTool
    ? agentToolPolicy.filter((filter) => filter.action !== "require")
    : agentToolPolicy;

  const effectiveToolPolicy: ToolPolicy | undefined =
    callerToolPolicy || agentToolPolicyForComposition.length > 0 || systemWorkspaceToolPolicy
      ? [
          ...agentToolPolicyForComposition,
          ...(callerToolPolicy ?? []),
          ...(systemWorkspaceToolPolicy ?? []),
        ]
      : undefined;

  // --- Sentinel tool names for agent transition detection ---
  // Creates a throwaway runtime to compute the tool name list that the message pipeline
  // uses for mode-transition sentinel injection. This avoids depending on the real
  // tool assembly (which happens later) while still respecting tool policy.
  const earlyRuntime = createRuntime({ type: "local", srcBaseDir: process.cwd() });
  const earlyAllTools = await getToolsForModel(
    modelString,
    {
      cwd: process.cwd(),
      runtime: earlyRuntime,
      runtimeTempDir: os.tmpdir(),
      secrets: {},
      planFileOnly: agentIsPlanLike,
    },
    "", // Empty workspace ID for early stub config
    initStateManager,
    undefined,
    undefined
  );
  const earlyTools = applyToolPolicy(earlyAllTools, effectiveToolPolicy);
  const toolNamesForSentinel = Object.keys(earlyTools);

  return Ok({
    effectiveAgentId,
    agentDefinition,
    agentDiscoveryPath,
    isSubagentWorkspace,
    agentIsPlanLike,
    effectiveMode,
    taskSettings,
    taskDepth,
    shouldDisableTaskToolsForDepth,
    effectiveToolPolicy,
    toolNamesForSentinel,
  });
}
