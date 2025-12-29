import { type Tool } from "ai";
import assert from "@/common/utils/assert";
import { createFileReadTool } from "@/node/services/tools/file_read";
import { createBashTool } from "@/node/services/tools/bash";
import { createBashOutputTool } from "@/node/services/tools/bash_output";
import { createBashBackgroundListTool } from "@/node/services/tools/bash_background_list";
import { createBashBackgroundTerminateTool } from "@/node/services/tools/bash_background_terminate";
import { createFileEditReplaceStringTool } from "@/node/services/tools/file_edit_replace_string";
// DISABLED: import { createFileEditReplaceLinesTool } from "@/node/services/tools/file_edit_replace_lines";
import { createFileEditInsertTool } from "@/node/services/tools/file_edit_insert";
import { createAskUserQuestionTool } from "@/node/services/tools/ask_user_question";
import { createProposePlanTool } from "@/node/services/tools/propose_plan";
import { createTodoWriteTool, createTodoReadTool } from "@/node/services/tools/todo";
import { createStatusSetTool } from "@/node/services/tools/status_set";
import { createTaskTool } from "@/node/services/tools/task";
import { createTaskAwaitTool } from "@/node/services/tools/task_await";
import { createTaskTerminateTool } from "@/node/services/tools/task_terminate";
import { createTaskListTool } from "@/node/services/tools/task_list";
import { createAgentSkillReadTool } from "@/node/services/tools/agent_skill_read";
import { createAgentSkillReadFileTool } from "@/node/services/tools/agent_skill_read_file";
import { createAgentReportTool } from "@/node/services/tools/agent_report";
import { wrapWithInitWait } from "@/node/services/tools/wrapWithInitWait";
import { log } from "@/node/services/log";
import { attachModelOnlyToolNotifications } from "@/common/utils/tools/internalToolResultFields";
import { NotificationEngine } from "@/node/services/agentNotifications/NotificationEngine";
import { TodoListReminderSource } from "@/node/services/agentNotifications/sources/TodoListReminderSource";
import { getAvailableTools } from "@/common/utils/tools/toolDefinitions";
import { sanitizeMCPToolsForOpenAI } from "@/common/utils/tools/schemaSanitizer";

import type { Runtime } from "@/node/runtime/Runtime";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { TaskService } from "@/node/services/taskService";
import type { UIMode } from "@/common/types/mode";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { FileState } from "@/node/services/agentSession";

/**
 * Configuration for tools that need runtime context
 */
export interface ToolConfiguration {
  /** Working directory for command execution - actual path in runtime's context (local or remote) */
  cwd: string;
  /** Runtime environment for executing commands and file operations */
  runtime: Runtime;
  /** Environment secrets to inject (optional) */
  secrets?: Record<string, string>;
  /** MUX_ environment variables (MUX_PROJECT_PATH, MUX_RUNTIME) - set from init hook env */
  muxEnv?: Record<string, string>;
  /** Temporary directory for tool outputs in runtime's context (local or remote) */
  runtimeTempDir: string;
  /** Overflow policy for bash tool output (optional, not exposed to AI) */
  overflow_policy?: "truncate" | "tmpfile";
  /** Background process manager for bash tool (optional, AI-only) */
  backgroundProcessManager?: BackgroundProcessManager;
  /** Current UI mode (plan or exec) - used for plan file path enforcement */
  mode?: UIMode;
  /** Plan file path - only this file can be edited in plan mode */
  planFilePath?: string;
  /**
   * Optional callback for emitting UI-only workspace chat events.
   * Used for streaming bash stdout/stderr to the UI without sending it to the model.
   */
  emitChatEvent?: (event: WorkspaceChatMessage) => void;
  /** Workspace session directory (e.g. ~/.mux/sessions/<workspaceId>) for persistent tool state */
  workspaceSessionDir?: string;
  /** Workspace ID for tracking background processes and plan storage */
  workspaceId?: string;
  /** Callback to record file state for external edit detection (plan files) */
  recordFileState?: (filePath: string, state: FileState) => void;
  /** Task orchestration for sub-agent tasks */
  taskService?: TaskService;
  /** Enable agent_report tool (only valid for child task workspaces) */
  enableAgentReport?: boolean;
  /** PTC experiments inherited from parent (for subagent spawning) */
  experiments?: { programmaticToolCalling?: boolean; programmaticToolCallingExclusive?: boolean };
}

/**
 * Factory function interface for creating tools with configuration
 */
export type ToolFactory = (config: ToolConfiguration) => Tool;

/**
 * Augment a tool's description with additional instructions from "Tool: <name>" sections
 * Mutates the base tool in place to append the instructions to its description.
 * This preserves any provider-specific metadata or internal state on the tool object.
 * @param baseTool The original tool to augment
 * @param additionalInstructions Additional instructions to append to the description
 * @returns The same tool instance with the augmented description
 */
function augmentToolDescription(baseTool: Tool, additionalInstructions: string): Tool {
  // Access the tool as a record to get its properties
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseToolRecord = baseTool as any as Record<string, unknown>;
  const originalDescription =
    typeof baseToolRecord.description === "string" ? baseToolRecord.description : "";
  const augmentedDescription = `${originalDescription}\n\n${additionalInstructions}`;

  // Mutate the description in place to preserve other properties (e.g. provider metadata)
  baseToolRecord.description = augmentedDescription;

  return baseTool;
}

function cloneToolPreservingDescriptors(tool: unknown): Tool {
  assert(tool && typeof tool === "object", "tool must be an object");

  // Clone the tool without invoking getters (important for some dynamic tools).
  const prototype = Object.getPrototypeOf(tool) as unknown;
  assert(
    prototype === null || typeof prototype === "object",
    "tool prototype must be an object or null"
  );

  const clone = Object.create(prototype) as object;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(tool));
  return clone as Tool;
}

function wrapToolExecuteWithModelOnlyNotifications(
  toolName: string,
  baseTool: Tool,
  engine: NotificationEngine
): Tool {
  // Access the tool as a record to get its properties.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseToolRecord = baseTool as any as Record<string, unknown>;
  const originalExecute = baseToolRecord.execute;

  if (typeof originalExecute !== "function") {
    return baseTool;
  }

  const executeFn = originalExecute as (this: unknown, args: unknown, options: unknown) => unknown;

  // Avoid mutating cached tools in place (e.g. MCP tools cached per workspace).
  // Repeated getToolsForModel() calls should not stack wrappers.
  const wrappedTool = cloneToolPreservingDescriptors(baseTool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrappedToolRecord = wrappedTool as any as Record<string, unknown>;

  wrappedToolRecord.execute = async (args: unknown, options: unknown) => {
    try {
      const result: unknown = await executeFn.call(baseTool, args, options);

      let notifications: string[] = [];
      try {
        notifications = await engine.pollAfterToolCall({
          toolName,
          toolSucceeded: true,
          now: Date.now(),
        });
      } catch (error) {
        log.debug("[getToolsForModel] notification poll failed", { error, toolName });
      }

      return attachModelOnlyToolNotifications(result, notifications);
    } catch (error) {
      try {
        await engine.pollAfterToolCall({
          toolName,
          toolSucceeded: false,
          now: Date.now(),
        });
      } catch (pollError) {
        log.debug("[getToolsForModel] notification poll failed", { pollError, toolName });
      }

      throw error;
    }
  };

  return wrappedTool;
}

function wrapToolsWithModelOnlyNotifications(
  tools: Record<string, Tool>,
  config: ToolConfiguration
): Record<string, Tool> {
  if (!config.workspaceSessionDir) {
    return tools;
  }

  const engine = new NotificationEngine([
    new TodoListReminderSource({ workspaceSessionDir: config.workspaceSessionDir }),
  ]);

  const wrappedTools: Record<string, Tool> = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    wrappedTools[toolName] = wrapToolExecuteWithModelOnlyNotifications(toolName, tool, engine);
  }

  return wrappedTools;
}

/**
 * Get tools available for a specific model with configuration
 *
 * Providers are lazy-loaded to reduce startup time. AI SDK providers are only
 * imported when actually needed for a specific model.
 *
 * @param modelString The model string in format "provider:model-id"
 * @param config Required configuration for tools
 * @param workspaceId Workspace ID for init state tracking (required for runtime tools)
 * @param initStateManager Init state manager for runtime tools to wait for initialization
 * @param toolInstructions Optional map of tool names to additional instructions from "Tool: <name>" sections
 * @returns Promise resolving to record of tools available for the model
 */
export async function getToolsForModel(
  modelString: string,
  config: ToolConfiguration,
  workspaceId: string,
  initStateManager: InitStateManager,
  toolInstructions?: Record<string, string>,
  mcpTools?: Record<string, Tool>
): Promise<Record<string, Tool>> {
  const [provider, modelId] = modelString.split(":");

  // Helper to reduce repetition when wrapping runtime tools
  const wrap = <TParameters, TResult>(tool: Tool<TParameters, TResult>) =>
    wrapWithInitWait(tool, workspaceId, initStateManager);

  // Lazy-load web_fetch to avoid loading jsdom (ESM-only) at Jest setup time
  // This allows integration tests to run without transforming jsdom's dependencies
  const { createWebFetchTool } = await import("@/node/services/tools/web_fetch");

  // Runtime-dependent tools need to wait for workspace initialization
  // Wrap them to handle init waiting centrally instead of in each tool
  const runtimeTools: Record<string, Tool> = {
    file_read: wrap(createFileReadTool(config)),
    agent_skill_read: wrap(createAgentSkillReadTool(config)),
    agent_skill_read_file: wrap(createAgentSkillReadFileTool(config)),
    file_edit_replace_string: wrap(createFileEditReplaceStringTool(config)),
    file_edit_insert: wrap(createFileEditInsertTool(config)),
    // DISABLED: file_edit_replace_lines - causes models (particularly GPT-5-Codex)
    // to leave repository in broken state due to issues with concurrent file modifications
    // and line number miscalculations. Use file_edit_replace_string instead.
    // file_edit_replace_lines: wrap(createFileEditReplaceLinesTool(config)),

    // Sub-agent task orchestration (child workspaces)
    task: wrap(createTaskTool(config)),
    task_await: wrap(createTaskAwaitTool(config)),
    task_terminate: wrap(createTaskTerminateTool(config)),
    task_list: wrap(createTaskListTool(config)),

    // Bash execution (foreground/background). Manage background output via task_await/task_list/task_terminate.
    bash: wrap(createBashTool(config)),

    // Legacy bash process tools (deprecated)
    bash_output: wrap(createBashOutputTool(config)),
    bash_background_list: wrap(createBashBackgroundListTool(config)),
    bash_background_terminate: wrap(createBashBackgroundTerminateTool(config)),

    web_fetch: wrap(createWebFetchTool(config)),
  };

  // Non-runtime tools execute immediately (no init wait needed)
  const nonRuntimeTools: Record<string, Tool> = {
    ...(config.mode === "plan" ? { ask_user_question: createAskUserQuestionTool(config) } : {}),
    propose_plan: createProposePlanTool(config),
    ...(config.enableAgentReport ? { agent_report: createAgentReportTool(config) } : {}),
    todo_write: createTodoWriteTool(config),
    todo_read: createTodoReadTool(config),
    status_set: createStatusSetTool(config),
  };

  // Base tools available for all models
  const baseTools: Record<string, Tool> = {
    ...runtimeTools,
    ...nonRuntimeTools,
  };

  // Try to add provider-specific web search tools if available
  // Lazy-load providers to avoid loading all AI SDKs at startup
  let allTools = { ...baseTools, ...(mcpTools ?? {}) };
  try {
    switch (provider) {
      case "anthropic": {
        const { anthropic } = await import("@ai-sdk/anthropic");
        allTools = {
          ...baseTools,
          ...(mcpTools ?? {}),
          // Provider-specific tool types are compatible with Tool at runtime
          web_search: anthropic.tools.webSearch_20250305({ maxUses: 1000 }) as Tool,
        };
        break;
      }

      case "openai": {
        // Sanitize MCP tools for OpenAI's stricter JSON Schema validation.
        // OpenAI's Responses API doesn't support certain schema properties like
        // minLength, maximum, default, etc. that are valid JSON Schema but not
        // accepted by OpenAI's Structured Outputs implementation.
        const sanitizedMcpTools = mcpTools ? sanitizeMCPToolsForOpenAI(mcpTools) : {};

        // Only add web search for models that support it
        if (modelId.includes("gpt-5") || modelId.includes("gpt-4")) {
          const { openai } = await import("@ai-sdk/openai");
          allTools = {
            ...baseTools,
            ...sanitizedMcpTools,
            // Provider-specific tool types are compatible with Tool at runtime
            web_search: openai.tools.webSearch({
              searchContextSize: "high",
            }) as Tool,
          };
        } else {
          // For other OpenAI models (o1, o3, etc.), still use sanitized MCP tools
          allTools = {
            ...baseTools,
            ...sanitizedMcpTools,
          };
        }
        break;
      }

      // Note: Gemini 3 tool support:
      // Combining native tools with function calling is currently only
      // supported in the Live API. Thus no `google_search` or `url_context` added here.
      // - https://ai.google.dev/gemini-api/docs/function-calling?example=meeting#native-tools
    }
  } catch (error) {
    // If tools aren't available, just use base tools
    log.error(`No web search tools available for ${provider}:`, error);
  }

  // Filter tools to the canonical allowlist so system prompt + toolset stay in sync.
  // Include MCP tools even if they're not in getAvailableTools().
  const allowlistedToolNames = new Set(
    getAvailableTools(modelString, config.mode, { enableAgentReport: config.enableAgentReport })
  );
  for (const toolName of Object.keys(mcpTools ?? {})) {
    allowlistedToolNames.add(toolName);
  }

  allTools = Object.fromEntries(
    Object.entries(allTools).filter(([toolName]) => allowlistedToolNames.has(toolName))
  );

  let finalTools = allTools;
  // Apply tool-specific instructions if provided
  if (toolInstructions) {
    const augmentedTools: Record<string, Tool> = {};
    for (const [toolName, baseTool] of Object.entries(allTools)) {
      const instructions = toolInstructions[toolName];
      if (instructions) {
        augmentedTools[toolName] = augmentToolDescription(baseTool, instructions);
      } else {
        augmentedTools[toolName] = baseTool;
      }
    }
    finalTools = augmentedTools;
  }

  finalTools = wrapToolsWithModelOnlyNotifications(finalTools, config);

  return finalTools;
}
