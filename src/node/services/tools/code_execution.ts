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
import type { IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import type { PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";
import { ToolBridge } from "@/node/services/ptc/toolBridge";
import { analyzeCode } from "@/node/services/ptc/staticAnalysis";
import { getCachedMuxTypes, clearTypeCache } from "@/node/services/ptc/typeGenerator";

// Default limits
const DEFAULT_MEMORY_BYTES = 64 * 1024 * 1024; // 64MB
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

/**
 * Create the code_execution tool.
 *
 * This function is async because it generates TypeScript type definitions
 * from the tool schemas, which requires async JSON Schema to TypeScript conversion.
 *
 * @param runtimeFactory Factory for creating QuickJS runtime instances
 * @param tools All available tools (will be filtered to bridgeable ones)
 * @param onEvent Callback for streaming events (tool calls, console output)
 */
export async function createCodeExecutionTool(
  runtimeFactory: IJSRuntimeFactory,
  tools: Record<string, Tool>,
  onEvent?: (event: PTCEvent) => void
): Promise<Tool> {
  const toolBridge = new ToolBridge(tools);
  const bridgeableTools = toolBridge.getBridgeableTools();

  // Generate mux types for type validation and documentation (cached by tool set hash)
  const muxTypes = await getCachedMuxTypes(bridgeableTools);

  return tool({
    description: `Execute JavaScript code in a sandboxed environment with access to Mux tools.

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
- \`Promise.all()\` executes tools sequentially (sandbox limitation), not in parallel

**Security:** The sandbox has no access to \`require\`, \`import\`, \`process\`, \`fetch\`, or filesystem outside of \`mux.*\` tools.`,

    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .describe(
          "JavaScript code to execute. All mux.* functions are async. Use 'return' for final result."
        ),
    }),

    execute: async ({ code }, { abortSignal }): Promise<PTCExecutionResult> => {
      const execStartTime = Date.now();

      // Static analysis before execution - catch syntax errors, forbidden patterns, and type errors
      const analysis = await analyzeCode(code, muxTypes);
      if (!analysis.valid) {
        const errorMessages = analysis.errors.map((e) => {
          const location = e.line ? ` (line ${e.line})` : "";
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
        // Set resource limits
        runtime.setLimits({
          memoryBytes: DEFAULT_MEMORY_BYTES,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });

        // Subscribe to events for UI streaming
        if (onEvent) {
          runtime.onEvent(onEvent);
        }

        // Register tools with abortSignal for mid-execution cancellation
        toolBridge.register(runtime, abortSignal);

        // Handle abort signal - interrupt sandbox at next checkpoint
        if (abortSignal) {
          abortSignal.addEventListener("abort", () => runtime.abort(), { once: true });
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
