import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Tool } from "ai";

import { applyToolPolicyAndExperiments, reconcileHookReplacedCodeExecution } from "./toolAssembly";

function executableTool(description: string): Tool {
  return {
    description,
    inputSchema: z.object({}),
    execute: () => Promise.resolve({ success: true }),
  } as unknown as Tool;
}

describe("applyToolPolicyAndExperiments", () => {
  test("exclusive PTC mode keeps mcp_prompt_get directly visible", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        mcp_prompt_get: executableTool("Fetch a prompt\n\nAvailable MCP prompts:\n- mcp__s__p"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCallingExclusive: true },
      emitNestedToolEvent: () => undefined,
    });

    const names = Object.keys(result);
    expect(names).toContain("code_execution");
    expect(names).not.toContain("bash");
    // Sandbox declarations keep only the first description line, which would
    // hide the prompt catalog.
    expect(names).toContain("mcp_prompt_get");
    expect(result.mcp_prompt_get.description).toContain("mcp__s__p");
  });

  test("grant-denied tools are hidden from the model but stubbed in the sandbox", async () => {
    const result = await applyToolPolicyAndExperiments({
      allTools: {
        bash: executableTool("Run a command"),
        file_read: executableTool("Read a file"),
      },
      effectiveToolPolicy: undefined,
      experiments: { programmaticToolCalling: true },
      emitNestedToolEvent: () => undefined,
      capabilityGrants: {
        version: 1,
        bridgeTools: { allow: ["file_read"] },
        vars: false,
        hostEvents: false,
      },
    });

    // Grants are a ceiling on the model-visible set...
    expect(Object.keys(result)).not.toContain("bash");
    expect(Object.keys(result)).toContain("code_execution");

    // ...but the guest must still get the documented catchable stub error —
    // the bridge is built from the pre-grant set so denied tools are known,
    // not "mux.bash is not a function".
    const evalResult = (await result.code_execution.execute!(
      { code: "try { mux.bash({}); return 'no error'; } catch (e) { return e.message; }" },
      { toolCallId: "test-call-id", messages: [], context: undefined }
    )) as { success: boolean; result?: unknown };
    expect(evalResult.success).toBe(true);
    expect(evalResult.result).toBe("Capability denied: xum.bash is not granted for this sandbox");
  });
});

describe("reconcileHookReplacedCodeExecution", () => {
  test("spread-style wrapper gets the rebuilt description but keeps its execute", () => {
    const preHook = executableTool("defs: function bash; function file_read");
    // Middleware wrapped by spreading the pre-hook tool: same description,
    // new execute.
    const wrappedExecute = () => Promise.resolve({ success: true, audited: true });
    const hookReplacement: Tool = { ...preHook, execute: wrappedExecute };
    const rebuilt = executableTool("defs: function file_read");

    const result = reconcileHookReplacedCodeExecution(preHook, hookReplacement, rebuilt);

    // Model-facing metadata follows the rebuilt toolset (bash removed)...
    expect(result.description).toBe("defs: function file_read");
    // ...while the middleware's execution wrapper is preserved.
    expect(result.execute).toBe(wrappedExecute);
  });

  test("middleware-authored description is preserved", () => {
    const preHook = executableTool("defs: function bash; function file_read");
    const hookReplacement = executableTool("audited code execution");
    const rebuilt = executableTool("defs: function file_read");

    const result = reconcileHookReplacedCodeExecution(preHook, hookReplacement, rebuilt);

    // Middleware took ownership of the model-facing contract; return it as-is.
    expect(result).toBe(hookReplacement);
  });
});
