import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Tool } from "ai";

import { applyToolPolicyAndExperiments } from "./toolAssembly";

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
});
