/**
 * Tool Bridge for PTC
 *
 * Bridges Xum tools into the QuickJS sandbox, making them callable via `xum.*`
 * (canonical) and `mux.*` (compatibility alias). Handles argument validation via
 * Zod schemas and result serialization.
 */

import type { Tool } from "ai";
import type { z } from "zod";
import type { IJSRuntime } from "./runtime";
import {
  FULL_GRANTS,
  isBridgeToolGranted,
  type CapabilityGrants,
} from "@/common/types/capabilityGrants";

/** Tools excluded from sandbox - UI-specific or would cause recursion */
const EXCLUDED_TOOLS = new Set([
  "code_execution", // Prevent recursive sandbox creation
  "ask_user_question", // Requires UI interaction
  "propose_plan", // Mode-specific, call directly
  "todo_write", // UI-specific
  "todo_read", // UI-specific
  "status_set", // UI-specific
  "agent_report", // Must be top-level for taskService to read args from history
]);

/**
 * Bridge that exposes Xum tools in the QuickJS sandbox under canonical `xum.*` and legacy `mux.*` namespaces.
 */
export class ToolBridge {
  private readonly bridgeableTools: Map<string, Tool>;
  private readonly nonBridgeableTools: Map<string, Tool>;
  /** Bridgeable tools denied by capability grants: stubbed with a clear error
   * in the sandbox and exposed in NEITHER getter (a denied tool must not leak
   * into the model-visible set via getNonBridgeableTools in exclusive mode). */
  private readonly deniedToolNames = new Set<string>();
  private readonly grants: CapabilityGrants;

  constructor(tools: Record<string, Tool>, grants?: CapabilityGrants) {
    this.bridgeableTools = new Map();
    this.nonBridgeableTools = new Map();
    this.grants = grants ?? FULL_GRANTS;

    for (const [name, tool] of Object.entries(tools)) {
      // code_execution is the tool that uses the bridge, not a candidate for bridging
      if (name === "code_execution") continue;

      const isBridgeable = !EXCLUDED_TOOLS.has(name) && this.hasExecute(tool);
      if (!isBridgeable) {
        this.nonBridgeableTools.set(name, tool);
      } else if (isBridgeToolGranted(this.grants, name)) {
        this.bridgeableTools.set(name, tool);
      } else {
        this.deniedToolNames.add(name);
      }
    }
  }

  /** Get list of tools that will be exposed in sandbox */
  getBridgeableToolNames(): string[] {
    return Array.from(this.bridgeableTools.keys());
  }

  /** Get the bridgeable tools as a Record */
  getBridgeableTools(): Record<string, Tool> {
    return Object.fromEntries(this.bridgeableTools.entries());
  }

  /**
   * Get tools that cannot be bridged into the sandbox.
   * These are tools that either:
   * - Are explicitly excluded (UI-specific, mode-specific)
   * - Don't have an execute function (provider-native like web_search)
   *
   * In exclusive PTC mode, these should still be available to the model directly.
   */
  getNonBridgeableTools(): Record<string, Tool> {
    return Object.fromEntries(this.nonBridgeableTools.entries());
  }

  /**
   * Register all bridgeable tools on the runtime under canonical `xum` and legacy `mux` namespaces.
   *
   * Tools receive the runtime's abort signal, which is aborted when:
   * - The sandbox timeout is exceeded
   * - runtime.abort() is called (e.g., from the parent's abort signal)
   *
   * This ensures nested tool calls are cancelled when the sandbox times out,
   * not just when the parent stream is cancelled.
   */
  register(runtime: IJSRuntime): void {
    const xumObj: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

    // Grant-denied tools get an explicit stub: the guest sees a clear
    // capability error instead of a confusing "xum.x is not a function".
    for (const name of this.deniedToolNames) {
      xumObj[name] = () =>
        Promise.reject(new Error(`Capability denied: xum.${name} is not granted for this sandbox`));
    }

    for (const [name, tool] of this.bridgeableTools) {
      // Capture tool for closure
      const boundTool = tool;
      const toolName = name;

      xumObj[name] = async (args: unknown) => {
        // Defense in depth: re-check the grant at call time so a stale or
        // mutated bridge can never invoke a non-granted tool.
        if (!isBridgeToolGranted(this.grants, toolName)) {
          throw new Error(`Capability denied: xum.${toolName} is not granted for this sandbox`);
        }

        // Get the runtime's abort signal - this is aborted on timeout or manual abort
        const abortSignal = runtime.getAbortSignal();

        // Check if already aborted before executing
        if (abortSignal?.aborted) {
          throw new Error("Execution aborted");
        }

        // Validate args against tool's Zod schema
        const validatedArgs = this.validateArgs(toolName, boundTool, args);

        // Execute tool with full options (toolCallId and messages are required by type
        // but not used by most tools - generate synthetic values for sandbox context)
        const result: unknown = await boundTool.execute!(validatedArgs, {
          abortSignal,
          toolCallId: `ptc-${toolName}-${Date.now()}`,
          messages: [],
          context: undefined,
        });

        // Ensure result is JSON-serializable
        return this.serializeResult(result);
      };
    }

    // Same object under both names so saved `mux.*` snippets keep working.
    runtime.registerObject("xum", xumObj);
    runtime.registerObject("mux", xumObj);
  }

  private hasExecute(tool: Tool): tool is Tool & { execute: NonNullable<Tool["execute"]> } {
    return typeof tool.execute === "function";
  }

  private validateArgs(toolName: string, tool: Tool, args: unknown): unknown {
    // Access the tool's Zod schema - AI SDK tools use 'inputSchema', some use 'parameters'
    const toolRecord = tool as { inputSchema?: z.ZodType; parameters?: z.ZodType };
    const schema = toolRecord.inputSchema ?? toolRecord.parameters;
    if (!schema) return args;

    const result = schema.safeParse(args);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid arguments for ${toolName}: ${issues}`);
    }
    return result.data;
  }

  private serializeResult(result: unknown): unknown {
    try {
      // Round-trip through JSON to ensure QuickJS can handle the value
      return JSON.parse(JSON.stringify(result));
    } catch {
      return { error: "Result not JSON-serializable" };
    }
  }
}
