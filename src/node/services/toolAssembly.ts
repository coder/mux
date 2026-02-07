/**
 * Tool assembly: applies tool policy and PTC (Programmatic Tool Calling) experiments.
 *
 * Extracted from `streamMessage()` to isolate the tool policy + PTC experiment
 * concerns (including lazy-loading of heavy PTC dependencies: typescript,
 * prettier, QuickJS WASM).
 *
 * The function takes pre-assembled tools from `getToolsForModel()` and returns
 * the final tool set after policy filtering and PTC wrapping.
 */

import type { Tool } from "ai";

import { applyToolPolicy, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
// PTC types only — modules lazy-loaded to avoid loading typescript/prettier at startup
import type {
  PTCEventWithParent,
  createCodeExecutionTool as CreateCodeExecutionToolFn,
} from "@/node/services/tools/code_execution";
import type { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { ToolBridge } from "@/node/services/ptc/toolBridge";
import { log } from "./log";

// ---------------------------------------------------------------------------
// PTC Lazy-Loading Singleton
// ---------------------------------------------------------------------------

// Lazy-loaded PTC modules (only loaded when experiment is enabled).
// This avoids loading typescript/prettier at startup which causes issues:
// - Integration tests fail without --experimental-vm-modules (prettier uses dynamic imports)
// - Smoke tests fail if typescript isn't in production bundle
// Dynamic imports are justified: PTC pulls in ~10MB of dependencies that would slow startup.
interface PTCModules {
  createCodeExecutionTool: typeof CreateCodeExecutionToolFn;
  QuickJSRuntimeFactory: typeof QuickJSRuntimeFactory;
  ToolBridge: typeof ToolBridge;
  runtimeFactory: QuickJSRuntimeFactory | null;
}
let ptcModules: PTCModules | null = null;

async function getPTCModules(): Promise<PTCModules> {
  if (ptcModules) return ptcModules;

  /* eslint-disable no-restricted-syntax -- Dynamic imports required here to avoid loading
     ~10MB of typescript/prettier/quickjs at startup (causes CI failures) */
  const [codeExecution, quickjs, toolBridge] = await Promise.all([
    import("@/node/services/tools/code_execution"),
    import("@/node/services/ptc/quickjsRuntime"),
    import("@/node/services/ptc/toolBridge"),
  ]);
  /* eslint-enable no-restricted-syntax */

  ptcModules = {
    createCodeExecutionTool: codeExecution.createCodeExecutionTool,
    QuickJSRuntimeFactory: quickjs.QuickJSRuntimeFactory,
    ToolBridge: toolBridge.ToolBridge,
    runtimeFactory: null,
  };
  return ptcModules;
}

// ---------------------------------------------------------------------------
// Tool Policy + PTC Application
// ---------------------------------------------------------------------------

/** Options for applying tool policy and PTC experiments. */
export interface ApplyToolPolicyAndExperimentsOptions {
  /** Tools from `getToolsForModel()` (before policy or PTC). */
  allTools: Record<string, Tool>;
  /** CLI-injected extra tools (bypass policy since they're runtime-provided). */
  extraTools?: Record<string, Tool>;
  /** Composed tool policy (agent → caller → system workspace). */
  effectiveToolPolicy: ToolPolicy | undefined;
  /** PTC experiment flags. */
  experiments?: {
    programmaticToolCalling?: boolean;
    programmaticToolCallingExclusive?: boolean;
  };
  /** Callback to forward nested PTC tool events to the stream. */
  emitNestedToolEvent: (event: PTCEventWithParent) => void;
}

/**
 * Apply tool policy, then wrap with PTC code_execution if experiments are enabled.
 *
 * Steps:
 * 1. Merge extra tools (CLI tools bypass policy — injected by runtime, not user)
 * 2. Apply tool policy (agent → caller → system workspace deny/enable rules)
 * 3. If PTC experiment is enabled, lazy-load PTC and create code_execution tool:
 *    - Supplement mode: adds code_execution alongside existing tools
 *    - Exclusive mode: replaces bridgeable tools with code_execution only
 *
 * @returns The final tool set ready for the AI model.
 */
export async function applyToolPolicyAndExperiments(
  opts: ApplyToolPolicyAndExperimentsOptions
): Promise<Record<string, Tool>> {
  const { allTools, extraTools, effectiveToolPolicy, experiments, emitNestedToolEvent } = opts;

  // Merge in extra tools (e.g., CLI-specific tools like set_exit_code).
  // These bypass policy filtering since they're injected by the runtime, not user config.
  const allToolsWithExtra = extraTools ? { ...allTools, ...extraTools } : allTools;

  // Apply tool policy FIRST — this must happen before PTC to ensure the sandbox
  // respects allow/deny filters. The policy-filtered tools are passed to
  // ToolBridge so the mux.* API only exposes policy-allowed tools.
  const policyFilteredTools = applyToolPolicy(allToolsWithExtra, effectiveToolPolicy);

  // Handle PTC experiments — add or replace tools with code_execution
  let toolsForModel = policyFilteredTools;
  if (experiments?.programmaticToolCalling || experiments?.programmaticToolCallingExclusive) {
    try {
      // Lazy-load PTC modules only when experiments are enabled
      const ptc = await getPTCModules();

      // ToolBridge uses policy-filtered tools — sandbox only exposes allowed tools
      const toolBridge = new ptc.ToolBridge(policyFilteredTools);

      // Singleton runtime factory (WASM module is expensive to load)
      ptc.runtimeFactory ??= new ptc.QuickJSRuntimeFactory();

      const codeExecutionTool = await ptc.createCodeExecutionTool(
        ptc.runtimeFactory,
        toolBridge,
        emitNestedToolEvent
      );

      if (experiments?.programmaticToolCallingExclusive) {
        // Exclusive mode: code_execution is mandatory — it's the only way to use bridged
        // tools. The experiment flag is the opt-in; policy cannot disable it here since
        // that would leave no way to access tools. nonBridgeable is already policy-filtered.
        const nonBridgeable = toolBridge.getNonBridgeableTools();
        toolsForModel = { ...nonBridgeable, code_execution: codeExecutionTool };
      } else {
        // Supplement mode: add code_execution, then apply policy to determine final set.
        // This correctly handles all policy combinations (require, enable, disable).
        toolsForModel = applyToolPolicy(
          { ...policyFilteredTools, code_execution: codeExecutionTool },
          effectiveToolPolicy
        );
      }
    } catch (error) {
      // Fall back to policy-filtered tools if PTC creation fails
      log.error("Failed to create code_execution tool, falling back to base tools", { error });
    }
  }

  return toolsForModel;
}
