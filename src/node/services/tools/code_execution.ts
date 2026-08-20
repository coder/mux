/**
 * Code Execution Tool for Programmatic Tool Calling (PTC)
 *
 * Executes JavaScript code in a sandboxed QuickJS environment with access to all
 * Xum tools via the `xum.*` namespace (`mux.*` remains a compatibility alias).
 * Enables multi-tool workflows in a single inference instead of multiple round-trips.
 */

import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import type { PTCEvent, PTCExecutionResult } from "@/node/services/ptc/types";
import type { SandboxMount } from "@/node/services/sandbox/sandboxHostService";

import { analyzeCode } from "@/node/services/ptc/staticAnalysis";
import { log } from "@/node/services/log";
import { getCachedXumTypes, clearTypeCache } from "@/node/services/ptc/typeGenerator";

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
 * @param withMount Optional SandboxHostService lease runner
 *   (withPersistentMount bound to this workspace's scope). When absent,
 *   behavior is the classic ephemeral per-call flow (create → eval → dispose).
 *   The runner holds the scope lock from mount acquisition through fn's
 *   completion, so the register→eval→persist sequence cannot race concurrent
 *   grant changes or scope disposal; the persistent runtime is not disposed
 *   here.
 */
export type MountRunner = (
  fn: (mount: SandboxMount) => Promise<PTCExecutionResult>
) => Promise<PTCExecutionResult>;

/**
 * Late-bound dispatch state for a created code_execution instance. execute()
 * reads bridge + mount runner from here at CALL time (not closure-capture
 * time) so retargetCodeExecutionTool can swing an already-created instance —
 * and any middleware wrapper delegating to it, even through a captured
 * `execute` function reference — onto a fresh bridge/mount.
 */
interface RetargetableState {
  toolBridge: ToolBridge;
  withMount: MountRunner | undefined;
}

const retargetableStates = new WeakMap<object, RetargetableState>();

/**
 * Point `target` (an instance returned by createCodeExecutionTool) at the
 * bridge + mount runner of `donor` (another such instance). Used when a
 * request.assemble hook wrapped/replaced code_execution while also editing
 * other bridgeable tools: the wrapper delegates to the PRE-hook instance,
 * which must dispatch through the rebuilt post-hook bridge instead of the
 * stale one. Returns false when either tool was not created by this factory.
 */
export function retargetCodeExecutionTool(target: Tool, donor: Tool): boolean {
  const targetState = retargetableStates.get(target);
  const donorState = retargetableStates.get(donor);
  if (targetState === undefined || donorState === undefined) {
    return false;
  }
  targetState.toolBridge = donorState.toolBridge;
  targetState.withMount = donorState.withMount;
  return true;
}

export async function createCodeExecutionTool(
  runtimeFactory: IJSRuntimeFactory,
  toolBridge: ToolBridge,
  emitNestedEvent?: (event: PTCEventWithParent) => void,
  withMount?: MountRunner
): Promise<Tool> {
  const bridgeableTools = toolBridge.getBridgeableTools();
  const state: RetargetableState = { toolBridge, withMount };

  // Generate xum types for type validation and documentation (cached by tool set hash)
  const xumTypes = await getCachedXumTypes(bridgeableTools);

  const codeExecutionTool = tool({
    description: `Execute sandboxed JavaScript to batch tools and transform outputs.

**When to use:** Prefer this tool when making 2+ tool calls, especially when later calls depend on earlier results. Reduces round-trip latency.

**Available tools (TypeScript definitions):**
\`\`\`typescript
${xumTypes}
\`\`\`

**Usage notes:**
- \`xum.*\` functions are synchronous—do not use \`await\`. \`mux.*\` is a compatibility alias.
- Use \`return\` to provide a final result to the model
- Use \`console.log/warn/error\` for debugging - output is captured
- Results are JSON-serialized; non-serializable values return \`{ error: "..." }\`
- On failure, partial results (completed tool calls) are returned for debugging

**Security:** The sandbox has no access to \`require\`, \`import\`, \`process\`, \`fetch\`, or filesystem outside of \`xum.*\` tools.`,

    inputSchema: z.object({
      code: z
        .string()
        .min(1)
        .describe(
          "JavaScript code to execute. xum.* calls are synchronous—do not use await. mux.* is a compatibility alias. Use 'return' for final result."
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

      // Late-bound dispatch: snapshot the CURRENT bridge + mount runner as a
      // pair so a retarget (see retargetCodeExecutionTool) lands atomically —
      // the whole call uses either the old pair or the new pair, never a mix.
      const { toolBridge: activeBridge, withMount: activeMount } = state;

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

      const runWithRuntime = async (
        mount: SandboxMount | null,
        runtime: IJSRuntime
      ): Promise<PTCExecutionResult> => {
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
          // Always re-register, even on reused persistent mounts: each request
          // builds a fresh ToolBridge from the CURRENT policy + grants, and a
          // stale bridge would keep exposing tools after permissions narrowed.
          // Registration just overwrites the guest's `xum`/`mux` globals, so this is
          // cheap and idempotent.
          activeBridge.register(runtime);

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
          // Failed/timed-out/aborted evals may still have mutated vars before
          // failing and the live guest keeps those mutations, so persist after
          // failures too — memory and disk must agree.
          if (mount?.lifetime === "persistent" && mount.grants.vars) {
            try {
              await mount.persistVars();
            } catch (persistError) {
              // Vars became unsnapshottable (e.g. guest created a cycle then
              // threw). Leaving the live mount would make memory and disk
              // permanently disagree; dispose it so the next acquire rebuilds
              // from the last durable snapshot. Never mask the eval result
              // with a snapshot error.
              log.warn(
                "code_execution: vars snapshot failed; disposing mount so the next call restores the last durable snapshot",
                { persistError }
              );
              mount.dispose();
            }
          }
          return result;
        } finally {
          // A late abort of THIS call's signal must not poison a reused runtime.
          abortSignal?.removeEventListener("abort", onAbort);
        }
      };

      // Persistent mounts can be handed to concurrent code_execution calls
      // for the same workspace, but eval() mutates runtime-wide state (abort
      // controller, tool-call attribution, event handler). The lease runner
      // holds the scope lock from acquisition through the whole
      // register→eval→persist sequence, so concurrent calls, grant changes,
      // and scope disposal are all serialized against this execution.
      if (activeMount) {
        return await activeMount((mount) => runWithRuntime(mount, mount.runtime));
      }
      // Classic ephemeral flow: per-call runtime, no serialization needed.
      const runtime = await runtimeFactory.create();
      try {
        return await runWithRuntime(null, runtime);
      } finally {
        runtime.dispose();
      }
    },
  });
  retargetableStates.set(codeExecutionTool, state);
  return codeExecutionTool;
}
