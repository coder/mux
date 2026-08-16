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
    // Bridgeable tools are absorbed by the sandbox in exclusive mode.
    expect(names).not.toContain("bash");
    // mcp_prompt_get stays direct: its description carries the prompt catalog,
    // which sandbox type declarations (first line only) would hide.
    expect(names).toContain("mcp_prompt_get");
    expect(result.mcp_prompt_get.description).toContain("mcp__s__p");
  });
});
