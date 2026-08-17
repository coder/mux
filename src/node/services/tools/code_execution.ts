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
import type { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import type { PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";
import type { SandboxMount } from "@/node/services/sandbox/sandboxHostService";

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
 * @param mountProvider Optional SandboxHostService mount source. When absent,
 *   behavior is the classic ephemeral per-call flow (create → eval → dispose).
 *   A persistent mount survives across calls: `vars` is shared, the tool
 *   bridge is registered once, and the runtime is not disposed here.
 */
export async function createCodeExecutionTool(
  runtimeFactory: IJSRuntimeFactory,
  toolBridge: ToolBridge,
  emitNestedEvent?: (event: PTCEventWithParent) => void,
  mountProvider?: () => Promise<SandboxMount>
): Promise<Tool> {
  const bridgeableTools = toolBridge.getBridgeableTools();

  // Generate mux types for type validation and documentation (cached by tool set hash)
  const muxTypes = await getCachedMuxTypes(bridgeableTools);

  return tool({
    description: `Execute sandboxed JavaScript to batch tools and transform outputs.

**When to use:** Prefer this tool when making 2+ tool calls, especially when later calls depend on earlier results. Reduces round-trip latency.

**Available tools (TypeScript definitions):**
\`\`\`typescript
${muxTypes}
\`\`\`

**Usage notes:**
- \`mux.*\` functions are synchronous—do not use \`await\`
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
          "JavaScript code to execute. mux.* calls are synchronous—do not use await. Use 'return' for final result."
        ),
      timeout_secs: z
        .number()
        .int()
        .positive()
        .nullish()
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

      // Static analysis before execution - catch syntax errors and sandbox-forbidden patterns.
      // TypeScript typing issues are intentionally non-blocking for one-off runtime scripts.
      const analysis = await analyzeCode(code);
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

      // Acquire the runtime: a SandboxHostService mount when provided
      // (persistent mounts are reused across calls), otherwise the classic
      // ephemeral per-call runtime.
      const mount = mountProvider ? await mountProvider() : null;
      const runtime = mount ? mount.runtime : await runtimeFactory.create();

      const onAbort = () => runtime.abort();
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

        // Register tools - they'll use runtime.getAbortSignal() for cancellation.
        // Persistent mounts register once; re-registering on a reused runtime
        // would rebuild the mux.* object every call for no benefit.
        if (!mount?.bridgeRegistered) {
          toolBridge.register(runtime);
          if (mount) {
            mount.bridgeRegistered = true;
          }
        }

        // Handle abort signal - interrupt sandbox and cancel nested tools
        if (abortSignal) {
          // If already aborted, abort runtime immediately
          if (abortSignal.aborted) {
            runtime.abort();
          } else {
            abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        }

        // Execute the code
        const result = await runtime.eval(code);

        // Persist the shared vars namespace after each call on persistent
        // mounts so state survives crashes/restarts (turn-boundary snapshots
        // are the Track 2 refinement; per-call is the safe foundation).
        if (mount?.lifetime === "persistent" && mount.grants.vars && result.success) {
          await mount.persistVars();
        }
        return result;
      } finally {
        // A late abort of THIS call's signal must not poison a reused runtime.
        abortSignal?.removeEventListener("abort", onAbort);
        if (mount) {
          mount.release(); // dispose ephemeral mounts; keep persistent alive
        } else {
          // Clean up runtime resources
          runtime.dispose();
        }
      }
    },
  });
}
