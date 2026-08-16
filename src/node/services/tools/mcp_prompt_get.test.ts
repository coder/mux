import { describe, expect, it, mock } from "bun:test";

import type { Tool } from "ai";

import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import type { MCPPromptGetToolResult } from "@/common/types/tools";
import type { MCPPromptRuntime } from "@/common/utils/tools/tools";
import { createMcpPromptGetTool } from "./mcp_prompt_get";
import { createTestToolConfig, mockToolCallOptions } from "./testHelpers";

const REVIEW_PROMPT: MCPPromptDescriptor = {
  commandKey: "mcp__coder__review",
  stableKey: "mcp__coder__review__abc123",
  serverName: "coder",
  promptName: "review",
  description: "Review a pull request",
  arguments: [
    { name: "pr", description: "PR number", required: true },
    { name: "focus", required: false },
  ],
};

const STATUS_PROMPT: MCPPromptDescriptor = {
  commandKey: "mcp__coder__status",
  stableKey: "mcp__coder__status__def456",
  serverName: "coder",
  promptName: "status",
};

function createTool(runtime: MCPPromptRuntime): Tool {
  const config = createTestToolConfig("/tmp");
  return createMcpPromptGetTool({ ...config, mcpPromptRuntime: runtime });
}

async function execute(
  tool: Tool,
  args: { name: string; arguments?: Record<string, string> }
): Promise<MCPPromptGetToolResult> {
  return (await tool.execute!(args, mockToolCallOptions)) as MCPPromptGetToolResult;
}

describe("createMcpPromptGetTool", () => {
  it("advertises prompts with argument hints in the description", () => {
    const tool = createTool({
      prompts: [REVIEW_PROMPT, STATUS_PROMPT],
      getPrompt: mock(() => Promise.resolve({ text: "" })),
    });

    expect(tool.description).toContain("mcp__coder__review");
    expect(tool.description).toContain("pr: PR number");
    expect(tool.description).toContain("focus?");
    expect(tool.description).toContain("Review a pull request");
    expect(tool.description).toContain("mcp__coder__status");
  });

  it("caps the advertised prompt list and reports the omitted count", () => {
    const prompts = Array.from({ length: 60 }, (_, index) => ({
      ...STATUS_PROMPT,
      commandKey: `mcp__coder__p${index}`,
      stableKey: `mcp__coder__p${index}__hash`,
      promptName: `p${index}`,
    }));
    const tool = createTool({ prompts, getPrompt: mock(() => Promise.resolve({ text: "" })) });

    expect(tool.description).toContain("mcp__coder__p49");
    expect(tool.description).not.toContain("mcp__coder__p50:");
    expect(tool.description).toContain("(+10 more not shown)");
  });

  it("fetches a prompt and forwards resolved server/prompt names and arguments", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({ text: "Review PR 42", description: "expanded" })
    );
    const tool = createTool({ prompts: [REVIEW_PROMPT], getPrompt });

    const result = await execute(tool, {
      name: "mcp__coder__review",
      arguments: { pr: "42" },
    });

    expect(result).toEqual({ success: true, text: "Review PR 42", description: "expanded" });
    expect(getPrompt).toHaveBeenCalledWith("coder", "review", { pr: "42" }, undefined);
  });

  it("resolves prompts by stableKey alias", async () => {
    const getPrompt = mock(() => Promise.resolve({ text: "ok" }));
    const tool = createTool({ prompts: [STATUS_PROMPT], getPrompt });

    const result = await execute(tool, { name: "mcp__coder__status__def456" });

    expect(result).toEqual({ success: true, text: "ok" });
    expect(getPrompt).toHaveBeenCalledWith("coder", "status", {}, undefined);
  });

  it("rejects unknown prompt names without calling the server", async () => {
    const getPrompt = mock(() => Promise.resolve({ text: "" }));
    const tool = createTool({ prompts: [STATUS_PROMPT], getPrompt });

    const result = await execute(tool, { name: "mcp__coder__missing" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("mcp__coder__missing");
    }
    expect(getPrompt).not.toHaveBeenCalled();
  });

  it("rejects calls missing required arguments without calling the server", async () => {
    const getPrompt = mock(() => Promise.resolve({ text: "" }));
    const tool = createTool({ prompts: [REVIEW_PROMPT], getPrompt });

    const result = await execute(tool, {
      name: "mcp__coder__review",
      arguments: { focus: "security" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("pr");
    }
    expect(getPrompt).not.toHaveBeenCalled();
  });

  it("forwards the tool call's abort signal to the prompt fetch", async () => {
    const getPrompt = mock(() => Promise.resolve({ text: "ok" }));
    const tool = createTool({ prompts: [STATUS_PROMPT], getPrompt });
    const controller = new AbortController();

    await tool.execute!(
      { name: "mcp__coder__status" },
      { ...mockToolCallOptions, abortSignal: controller.signal }
    );

    expect(getPrompt).toHaveBeenCalledWith("coder", "status", {}, { signal: controller.signal });
  });

  it("returns a failure result when the prompt fetch throws", async () => {
    const getPrompt = mock(() => Promise.reject(new Error("server exploded")));
    const tool = createTool({ prompts: [STATUS_PROMPT], getPrompt });

    const result = await execute(tool, { name: "mcp__coder__status" });

    expect(result).toEqual({ success: false, error: "server exploded" });
  });
});
