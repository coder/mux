import { type Tool, tool } from "ai";
import { z } from "zod";
import { createFileReadTool } from "@/node/services/tools/file_read";
import { createBashTool } from "@/node/services/tools/bash";
import { createFileEditReplaceStringTool } from "@/node/services/tools/file_edit_replace_string";
// DISABLED: import { createFileEditReplaceLinesTool } from "@/node/services/tools/file_edit_replace_lines";
import { createFileEditInsertTool } from "@/node/services/tools/file_edit_insert";
import { createProposePlanTool } from "@/node/services/tools/propose_plan";
import { createTodoWriteTool, createTodoReadTool } from "@/node/services/tools/todo";
import { createStatusSetTool } from "@/node/services/tools/status_set";
import { wrapWithInitWait } from "@/node/services/tools/wrapWithInitWait";
import { listScripts } from "@/utils/scripts/discovery";
import { runWorkspaceScript } from "@/node/services/scriptRunner";
import { log } from "@/node/services/log";

import type { Runtime } from "@/node/runtime/Runtime";
import type { InitStateManager } from "@/node/services/initStateManager";

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
  /** Additional environment variables to inject (optional) */
  env?: Record<string, string>;
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
  toolInstructions?: Record<string, string>
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
    file_edit_replace_string: wrap(createFileEditReplaceStringTool(config)),
    file_edit_insert: wrap(createFileEditInsertTool(config)),
    // DISABLED: file_edit_replace_lines - causes models (particularly GPT-5-Codex)
    // to leave repository in broken state due to issues with concurrent file modifications
    // and line number miscalculations. Use file_edit_replace_string instead.
    // file_edit_replace_lines: wrap(createFileEditReplaceLinesTool(config)),
    bash: wrap(createBashTool(config)),
    web_fetch: wrap(createWebFetchTool(config)),
  };

  // Discover and register user scripts as tools
  // These are treated as runtime tools (execution happens in runtime)
  try {
    const scripts = await listScripts(config.runtime, config.cwd);
    for (const script of scripts) {
      if (!script.isExecutable) continue;

      // Sanitize script name for tool name (e.g., "deploy-prod" -> "script_deploy_prod")
      const sanitizedName = script.name.replace(/[^a-zA-Z0-9_]/g, "_");
      const toolName = `script_${sanitizedName}`;

      // Create tool definition
      const scriptTool = tool({
        description: `(User Script) ${script.description ?? `Execute the ${script.name} script`}`,
        inputSchema: z.object({
          args: z.array(z.string()).optional().describe("Arguments to pass to the script"),
        }),
        execute: async (input: { args?: string[] }) => {
          const { args } = input;

          const result = await runWorkspaceScript(
            config.runtime,
            config.cwd,
            script.name,
            args ?? [],
            {
              env: config.env ?? {},
              secrets: config.secrets ?? {},
              timeoutSecs: 300,
              overflowPolicy: "tmpfile",
            }
          );

          if (!result.success) {
            return `Script execution failed: ${result.error}`;
          }

          const scriptResult = result.data;

          // Combine all outputs
          const parts: string[] = [];

          if (scriptResult.stdout.trim()) {
            parts.push(scriptResult.stdout);
          }

          if (scriptResult.stderr.trim()) {
            parts.push(`Error: ${scriptResult.stderr}`);
          }

          if (scriptResult.exitCode !== 0) {
            parts.push(`(Exit Code: ${scriptResult.exitCode})`);
          }

          if (scriptResult.outputFileContent?.trim()) {
            parts.push(`--- MUX_OUTPUT ---\n${scriptResult.outputFileContent.trim()}`);
          }

          if (scriptResult.promptFileContent?.trim()) {
            parts.push(`--- MUX_PROMPT ---\n${scriptResult.promptFileContent.trim()}`);
          }

          return parts.join("\n\n");
        },
      });

      // Wrap with init wait and register
      runtimeTools[toolName] = wrap(scriptTool);
    }
  } catch (error) {
    log.error("Failed to discover/register script tools:", error);
    // Continue without script tools on error
  }

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
  let allTools = baseTools;
  try {
    switch (provider) {
      case "anthropic": {
        const { anthropic } = await import("@ai-sdk/anthropic");
        allTools = {
          ...baseTools,
          // Type assertion needed due to SDK version mismatch between ai and @ai-sdk/anthropic
          web_search: anthropic.tools.webSearch_20250305({ maxUses: 1000 }) as Tool,
        };
        break;
      }

      case "openai": {
        // Only add web search for models that support it
        if (modelId.includes("gpt-5") || modelId.includes("gpt-4")) {
          const { openai } = await import("@ai-sdk/openai");
          allTools = {
            ...baseTools,
            // Type assertion needed due to SDK version mismatch between ai and @ai-sdk/openai
            web_search: openai.tools.webSearch({
              searchContextSize: "high",
            }) as Tool,
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
    return augmentedTools;
  }

  return allTools;
}
