import { type Tool } from "ai";
import { createFileReadTool } from "@/services/tools/file_read";
import { createBashTool } from "@/services/tools/bash";
import { createFileEditReplaceStringTool } from "@/services/tools/file_edit_replace_string";
// DISABLED: import { createFileEditReplaceLinesTool } from "@/services/tools/file_edit_replace_lines";
import { createFileEditInsertTool } from "@/services/tools/file_edit_insert";
import { createProposePlanTool } from "@/services/tools/propose_plan";
import { createTodoWriteTool, createTodoReadTool } from "@/services/tools/todo";
import { createStatusSetTool } from "@/services/tools/status_set";
import { wrapWithInitWait } from "@/services/tools/wrapWithInitWait";
import { log } from "@/services/log";

import type { Runtime } from "@/runtime/Runtime";
import type { InitStateManager } from "@/services/initStateManager";

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
  /** Process niceness level (optional, -20 to 19, lower = higher priority) */
  niceness?: number;
  /** Temporary directory for tool outputs in runtime's context (local or remote) */
  runtimeTempDir: string;
  /** Overflow policy for bash tool output (optional, not exposed to AI) */
  overflow_policy?: "truncate" | "tmpfile";
}

/**
 * Factory function interface for creating tools with configuration
 */
export type ToolFactory = (config: ToolConfiguration) => Tool;

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
 * @returns Promise resolving to record of tools available for the model
 */
export async function getToolsForModel(
  modelString: string,
  config: ToolConfiguration,
  workspaceId: string,
  initStateManager: InitStateManager
): Promise<Record<string, Tool>> {
  const [provider, modelId] = modelString.split(":");

  // Helper to reduce repetition when wrapping runtime tools
  const wrap = <TParameters, TResult>(tool: Tool<TParameters, TResult>) =>
    wrapWithInitWait(tool, workspaceId, initStateManager);

  // Runtime-dependent tools need to wait for workspace initialization
  // Wrap them to handle init waiting centrally instead of in each tool
  const runtimeTools: Record<string, Tool> = {
    file_read: wrap(createFileReadTool(config)),
    file_edit_replace_string: wrap(createFileEditReplaceStringTool(config)),
    file_edit_insert: wrap(createFileEditInsertTool(config)),
    // DISABLED: file_edit_replace_lines - causes models (particularly GPT-5-Codex)
    // to leave repository in broken state due to issues with concurrent file modifications
    // and line number miscalculations. Use file_edit_replace_string instead.
    // file_edit_replace_lines: wrap(createFileEditReplaceLinesTool(config)),
    bash: wrap(createBashTool(config)),
  };

  // Non-runtime tools execute immediately (no init wait needed)
  const nonRuntimeTools: Record<string, Tool> = {
    propose_plan: createProposePlanTool(config),
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
  try {
    switch (provider) {
      case "anthropic": {
        const { anthropic } = await import("@ai-sdk/anthropic");
        return {
          ...baseTools,
          web_search: anthropic.tools.webSearch_20250305({ maxUses: 1000 }),
        };
      }

      case "openai": {
        // Only add web search for models that support it
        if (modelId.includes("gpt-5") || modelId.includes("gpt-4")) {
          const { openai } = await import("@ai-sdk/openai");
          return {
            ...baseTools,
            web_search: openai.tools.webSearch({
              searchContextSize: "high",
            }),
          };
        }
        break;
      }
    }
  } catch (error) {
    // If tools aren't available, just return base tools
    log.error(`No web search tools available for ${provider}:`, error);
  }

  return baseTools;
}
