import { describe, expect, it, mock, spyOn } from "bun:test";

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

  it("keeps prompts past the full-entry cap discoverable via a names-only tail", () => {
    const prompts = Array.from({ length: 60 }, (_, index) => ({
      ...STATUS_PROMPT,
      commandKey: `mcp__coder__p${index}`,
      stableKey: `mcp__coder__p${index}__hash`,
      promptName: `p${index}`,
    }));
    const tool = createTool({ prompts, getPrompt: mock(() => Promise.resolve({ text: "" })) });

    expect(tool.description).toContain("mcp__coder__p49");
    expect(tool.description).not.toContain("mcp__coder__p50:");
    expect(tool.description).toContain("names only:");
    // Every prompt past the cap stays discoverable by exact key.
    for (let index = 50; index < 60; index++) {
      expect(tool.description).toContain(`mcp__coder__p${index}`);
    }
    expect(tool.description).not.toContain("more not shown");
  });

  it("builds argument hints incrementally instead of materializing huge argument arrays", () => {
    let elementReads = 0;
    const hugeArguments = new Proxy(
      Array.from({ length: 10_000 }, (_, index) => ({ name: `arg_${index}`, required: true })),
      {
        get(target, property, receiver): unknown {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            elementReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );
    const tool = createTool({
      prompts: [{ ...STATUS_PROMPT, arguments: hugeArguments }],
      getPrompt: mock(() => Promise.resolve({ text: "" })),
    });

    expect(tool.description!.length).toBeLessThan(2_000);
    // Construction stops at the hint budget rather than visiting all 10k entries.
    expect(elementReads).toBeLessThan(100);
  });

  it("clamps server-supplied prompt and argument descriptions", () => {
    const tool = createTool({
      prompts: [
        {
          ...STATUS_PROMPT,
          description: "d".repeat(5_000),
          arguments: [{ name: "arg", description: "a".repeat(5_000), required: true }],
        },
      ],
      getPrompt: mock(() => Promise.resolve({ text: "" })),
    });

    expect(tool.description!.length).toBeLessThan(2_000);
    expect(tool.description).toContain("d".repeat(100));
    expect(tool.description).not.toContain("d".repeat(300));
    expect(tool.description).not.toContain("a".repeat(300));
  });

  it("moves prompts past the total index budget into the names-only tail", () => {
    // Max clamped entry (~535 chars: 300 arg hint + 200 description); the
    // 10k index budget fits ~18 of 30 as full entries.
    const prompts = Array.from({ length: 30 }, (_, index) => ({
      ...STATUS_PROMPT,
      commandKey: `mcp__coder__q${index}`,
      stableKey: `mcp__coder__q${index}__hash`,
      promptName: `q${index}`,
      description: "x".repeat(600),
      arguments: [{ name: "arg", description: "y".repeat(600), required: true }],
    }));
    const tool = createTool({ prompts, getPrompt: mock(() => Promise.resolve({ text: "" })) });

    expect(tool.description!.length).toBeLessThan(15_000);
    expect(tool.description).toContain("names only:");
    // The last prompt is still discoverable even though its full entry did not fit.
    expect(tool.description).toContain("mcp__coder__q29");
  });

  it("bounds the names-only tail and reports the truly omitted count", () => {
    const prompts = Array.from({ length: 400 }, (_, index) => ({
      ...STATUS_PROMPT,
      commandKey: `mcp__coder__long_prompt_name_${index}`,
      stableKey: `mcp__coder__long_prompt_name_${index}__hash`,
      promptName: `long_prompt_name_${index}`,
    }));
    const tool = createTool({ prompts, getPrompt: mock(() => Promise.resolve({ text: "" })) });

    expect(tool.description!.length).toBeLessThan(20_000);
    expect(tool.description).toMatch(/\(\+\d+ more not shown; call this tool/);
    // Keys are never cut mid-name: every advertised tail key is complete.
    const tail = /\(more prompts, names only: ([^)]+)\)/.exec(tool.description as string);
    expect(tail).not.toBeNull();
    for (const key of tail![1].split(", ")) {
      expect(key).toMatch(/^mcp__coder__long_prompt_name_\d+$/);
    }
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

  it("never lets a stableKey alias shadow another prompt's exact commandKey", async () => {
    const getPrompt = mock(() => Promise.resolve({ text: "ok" }));
    // STATUS_PROMPT's stableKey doubles as a later prompt's current commandKey.
    const shadowed: MCPPromptDescriptor = {
      commandKey: "mcp__coder__status__def456",
      stableKey: "mcp__coder__status__def456__zzz",
      serverName: "coder",
      promptName: "status__def456",
    };
    const tool = createTool({ prompts: [STATUS_PROMPT, shadowed], getPrompt });

    const result = await execute(tool, { name: "mcp__coder__status__def456" });

    expect(result).toEqual({ success: true, text: "ok" });
    expect(getPrompt).toHaveBeenCalledWith("coder", "status__def456", {}, undefined);
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

  it("lists every prompt key in the unknown-name error, including ones cut from the description", async () => {
    const prompts = Array.from({ length: 400 }, (_, index) => ({
      ...STATUS_PROMPT,
      commandKey: `mcp__coder__long_prompt_name_${index}`,
      stableKey: `mcp__coder__long_prompt_name_${index}__hash`,
      promptName: `long_prompt_name_${index}`,
    }));
    const tool = createTool({ prompts, getPrompt: mock(() => Promise.resolve({ text: "" })) });
    // Prompt 399 is beyond both description budgets, so the description omits it.
    expect(tool.description).not.toContain("mcp__coder__long_prompt_name_399");

    const result = await execute(tool, { name: "?" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("mcp__coder__long_prompt_name_399");
      expect(result.error.length).toBeLessThan(25_000);
    }
  });

  it("narrows the unknown-name error by substring so prompts past the error budget stay reachable", async () => {
    // Full catalog exceeds the 20k error budget; prompt 999 falls past it.
    const prompts = Array.from({ length: 1_000 }, (_, index) => ({
      ...STATUS_PROMPT,
      commandKey: `mcp__coder__long_prompt_name_${index}`,
      stableKey: `mcp__coder__long_prompt_name_${index}__hash`,
      promptName: `long_prompt_name_${index}`,
    }));
    const tool = createTool({ prompts, getPrompt: mock(() => Promise.resolve({ text: "" })) });

    const unfiltered = await execute(tool, { name: "?" });
    expect(unfiltered.success).toBe(false);
    if (!unfiltered.success) {
      expect(unfiltered.error).not.toContain("mcp__coder__long_prompt_name_999");
      expect(unfiltered.error).toContain("more; use a longer partial name to narrow");
    }

    const narrowed = await execute(tool, { name: "name_999" });
    expect(narrowed.success).toBe(false);
    if (!narrowed.success) {
      expect(narrowed.error).toContain("Prompts matching 'name_999'");
      expect(narrowed.error).toContain("mcp__coder__long_prompt_name_999");
    }
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

  it("truncates oversized prompt expansions and clamps the result description", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({ text: "x".repeat(200_000), description: "y".repeat(5_000) })
    );
    const tool = createTool({ prompts: [STATUS_PROMPT], getPrompt });

    const result = await execute(tool, { name: "mcp__coder__status" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.text.length).toBeLessThan(70_000);
      expect(result.text).toEndWith("[Prompt text truncated]");
      expect(result.description!.length).toBeLessThan(300);
    }
  });

  it("returns a failure result when the prompt fetch throws", async () => {
    const getPrompt = mock(() => Promise.reject(new Error("server exploded")));
    const tool = createTool({ prompts: [STATUS_PROMPT], getPrompt });

    const result = await execute(tool, { name: "mcp__coder__status" });

    expect(result).toEqual({ success: false, error: "server exploded" });
  });

  it("never encodes more than the byte budget when truncating a huge expansion", async () => {
    const getPrompt = mock(() => Promise.resolve({ text: "a".repeat(10 * 1024 * 1024) }));
    const tool = createTool({ prompts: [STATUS_PROMPT], getPrompt });
    const fromSpy = spyOn(Buffer, "from");

    try {
      const result = await execute(tool, { name: "mcp__coder__status" });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.text).toEndWith("[Prompt text truncated]");
      }
      // The transient encoding copy is bounded by the budget, not input size.
      for (const call of fromSpy.mock.calls) {
        const input = call[0];
        if (typeof input === "string") {
          expect(input.length).toBeLessThanOrEqual(64 * 1024);
        }
      }
    } finally {
      fromSpy.mockRestore();
    }
  });

  it("scans the catalog once when building the unknown-name error", async () => {
    let keyReads = 0;
    const prompts = Array.from({ length: 100 }, (_, index) => {
      const descriptor = {
        ...STATUS_PROMPT,
        stableKey: `mcp__coder__p${index}__hash`,
        promptName: `p${index}`,
      };
      Object.defineProperty(descriptor, "commandKey", {
        get() {
          keyReads++;
          return `mcp__coder__p${index}`;
        },
      });
      return descriptor;
    });
    const tool = createTool({ prompts, getPrompt: mock(() => Promise.resolve({ text: "" })) });
    keyReads = 0;

    const result = await execute(tool, { name: "no_match_anywhere" });

    expect(result.success).toBe(false);
    // One read per key in the exact-match pass plus one in the search scan;
    // the no-match fallback must not rescan the catalog.
    expect(keyReads).toBeLessThanOrEqual(250);
  });

  it("enforces the expansion cap in encoded bytes without splitting characters", async () => {
    // 64k "€" chars encode to ~192KB UTF-8, triple the nominal cap.
    const getPrompt = mock(() => Promise.resolve({ text: "€".repeat(64 * 1024) }));
    const tool = createTool({ prompts: [STATUS_PROMPT], getPrompt });

    const result = await execute(tool, { name: "mcp__coder__status" });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(64 * 1024 + 40);
      expect(result.text).toEndWith("[Prompt text truncated]");
      expect(result.text).not.toContain("\uFFFD");
    }
  });

  it("bounds the missing-argument error against hostile argument lists", async () => {
    const prompt: MCPPromptDescriptor = {
      ...STATUS_PROMPT,
      arguments: Array.from({ length: 500 }, (_, index) => ({
        name: `required_argument_with_a_very_long_name_${index}`,
        required: true,
      })),
    };
    const tool = createTool({
      prompts: [prompt],
      getPrompt: mock(() => Promise.resolve({ text: "" })),
    });

    const result = await execute(tool, { name: "mcp__coder__status" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeLessThan(5_000);
      expect(result.error).toMatch(/\(\+\d+ more\)/);
    }
  });

  it("clamps server-controlled error messages", async () => {
    const getPrompt = mock(() => Promise.reject(new Error("e".repeat(100_000))));
    const tool = createTool({ prompts: [STATUS_PROMPT], getPrompt });

    const result = await execute(tool, { name: "mcp__coder__status" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeLessThan(3_000);
    }
  });
});
