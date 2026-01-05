/**
 * Code Execution Tool for Programmatic Tool Calling (PTC)
 *
 * Executes JavaScript code in a sandboxed QuickJS environment with access to all
 * Mux tools via the `mux.*` namespace. Enables multi-tool workflows in a single
 * inference instead of multiple round-trips.
 */

import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import type { PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";

import { analyzeCode } from "@/node/services/ptc/staticAnalysis";
import { getCachedMuxTypes, clearTypeCache } from "@/node/services/ptc/typeGenerator";

// Default limits
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024; // 64MB
const DEFAULT_TIMEOUT_SECS = 5 * 60; // 5 minutes
const MAX_TIMEOUT_SECS = 60 * 60; // 1 hour

/**
 * Clear all type caches. Call for test isolation or when tool schemas might have changed.
 */
export function clearTypeCaches(): void {
  clearTypeCache();
}

/**
 * Pre-generate type definitions for the given tools.
 * Call during workspace initialization to avoid first-call latency.
 * Integration with workspace initialization is handled in Phase 6.
 */
export async function preGenerateMuxTypes(tools: Record<string, Tool>): Promise<void> {
  const toolBridge = new ToolBridge(tools);
  await getCachedMuxTypes(toolBridge.getBridgeableTools());
}

/** PTC event with parentToolCallId attached by code_execution */
export type PTCEventWithParent = PTCEvent & { parentToolCallId: string };

/**
 * Create the code_execution tool.
 *
 * This function is async because it generates TypeScript type definitions
 * from the tool schemas, which requires async JSON Schema to TypeScript conversion.
 *
 * @param runtimeFactory Factory for creating QuickJS runtime instances
 * @param toolBridge Bridge containing tools to expose in sandbox
 * @param emitNestedEvent Callback for streaming nested tool events (includes parentToolCallId)
 */
export async function createCodeExecutionTool(
  runtimeFactory: IJSRuntimeFactory,
  toolBridge: ToolBridge,
  emitNestedEvent?: (event: PTCEventWithParent) => void
): Promise<Tool> {
  const bridgeableTools = toolBridge.getBridgeableTools();

  // Generate mux types for type validation and documentation (cached by tool set hash)
  const muxTypes = await getCachedMuxTypes(bridgeableTools);

  return tool({
    description: `Execute sandboxed JavaScript to batch tools and transform outputs.

**Available tools (TypeScript definitions):**
\`\`\`typescript
${muxTypes}
\`\`\`

**Usage notes:**
- \`mux.*\` functions return results directly (no \`await\` needed)
- Use \`return\` to provide a final result to the model
- Use \`console.log/warn/error\` for debugging - output is captured
- Results are JSON-serialized; non-serializable values return \`{ error: "..." }\`
- On failure, partial results (completed tool calls) are returned for debugging

**Security:** The sandbox has no access to \`require\`, \`import\`, \`process\`, \`fetch\`, or filesystem outside of \`mux.*\` tools.`,

    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .describe(
          "JavaScript code to execute. All mux.* functions are async. Use 'return' for final result."
        ),
      timeout_secs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Execution timeout in seconds (default: 300, max: 3600). " +
            "Increase when spawning subagents that may take 5-15+ minutes."
        ),
    }),

    execute: async (
      { code, timeout_secs },
      { abortSignal, toolCallId }
    ): Promise<PTCExecutionResult> => {
      const execStartTime = Date.now();

      // Static analysis before execution - catch syntax errors, forbidden patterns, and type errors
      const analysis = await analyzeCode(code, muxTypes);
      if (!analysis.valid) {
        const errorMessages = analysis.errors.map((e) => {
          const location =
            e.line && e.column
              ? ` (line ${e.line}, col ${e.column})`
              : e.line
                ? ` (line ${e.line})`
                : "";
          return `- ${e.message}${location}`;
        });
        return {
          success: false,
          error: `Code analysis failed:\n${errorMessages.join("\n")}`,
          toolCalls: [],
          consoleOutput: [],
          duration_ms: Date.now() - execStartTime,
        };
      }

      // Create runtime with resource limits
      const runtime = await runtimeFactory.create();

      try {
        // Set resource limits (clamp timeout to max)
        const timeoutSecs = Math.min(timeout_secs ?? DEFAULT_TIMEOUT_SECS, MAX_TIMEOUT_SECS);
        runtime.setLimits({
          memoryBytes: DEFAULT_MEMORY_BYTES,
          timeoutMs: timeoutSecs * 1000,
        });

        // Subscribe to events for UI streaming
        // Wrap callback to include parentToolCallId from AI SDK context
        if (emitNestedEvent) {
          runtime.onEvent((event: PTCEvent) => {
            emitNestedEvent({ ...event, parentToolCallId: toolCallId });
          });
        }

        // Register tools - they'll use runtime.getAbortSignal() for cancellation
        toolBridge.register(runtime);

        // Handle abort signal - interrupt sandbox and cancel nested tools
        if (abortSignal) {
          // If already aborted, abort runtime immediately
          if (abortSignal.aborted) {
            runtime.abort();
          } else {
            abortSignal.addEventListener("abort", () => runtime.abort(), { once: true });
          }
        }

        // Execute the code
        return await runtime.eval(code);
      } finally {
        // Clean up runtime resources
        runtime.dispose();
      }
    },
  });
}
