import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "@/common/types/thinking";
import { resolveWorkspaceAiSettingsForAgent } from "./workspaceModeAi";

describe("resolveWorkspaceAiSettingsForAgent", () => {
  test("uses global agent defaults when configured", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "high" },
      },
      fallbackModel: "openai:gpt-5.2",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.3-codex",
      resolvedThinking: "high",
    });
  });

  test("inherits existing workspace settings when global defaults are unset", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      fallbackModel: "openai:gpt-5.2",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "medium",
    });

    expect(result).toEqual({
      resolvedModel: "anthropic:claude-opus-4-6",
      resolvedThinking: "medium",
    });
  });

  test('treats empty modelString as "inherit"', () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: "  " },
      },
      fallbackModel: "openai:gpt-5.2",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "low",
    });

    expect(result).toEqual({
      resolvedModel: "anthropic:claude-opus-4-6",
      resolvedThinking: "low",
    });
  });

  test("guards non-string global default model values", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: 42 as unknown as string },
      },
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
      },
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.2",
      resolvedThinking: "medium",
    });
  });

  test("uses workspace-by-agent fallback when global defaults are inherit", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
      },
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.2",
      resolvedThinking: "medium",
    });
  });

  test("guards non-string workspace-by-agent model values", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: 42 as unknown as string, thinkingLevel: "medium" },
      },
      fallbackModel: "openai:gpt-5.2",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "anthropic:claude-opus-4-6",
      resolvedThinking: "medium",
    });
  });

  test("self-heals invalid inherited workspace settings", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      fallbackModel: "openai:gpt-5.2",
      existingModel: "   ",
      existingThinking: "legacy-invalid" as unknown as ThinkingLevel,
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.2",
      resolvedThinking: "off",
    });
  });

  test("guards non-string persisted model values", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      fallbackModel: "openai:gpt-5.2",
      existingModel: 42 as unknown as string,
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.2",
      resolvedThinking: "off",
    });
  });
});
