import { describe, expect, test } from "bun:test";
import type { OpenAIReasoningMode, ThinkingLevel } from "@/common/types/thinking";
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
      resolvedReasoningMode: "standard",
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
      resolvedReasoningMode: "standard",
    });
  });

  test("uses workspace-by-agent fallback when explicitly enabled", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
      },
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "openai:gpt-5.2",
      resolvedThinking: "medium",
      resolvedReasoningMode: "standard",
    });
  });

  test("ignores workspace-by-agent fallback when disabled", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
      },
      useWorkspaceByAgentFallback: false,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "anthropic:claude-opus-4-6",
      resolvedThinking: "off",
      resolvedReasoningMode: "standard",
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
      resolvedReasoningMode: "standard",
    });
  });

  test("guards non-string global default model values", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {
        exec: { modelString: 42 as unknown as string },
      },
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "anthropic:claude-opus-4-6",
      existingThinking: "off",
    });

    expect(result).toEqual({
      resolvedModel: "anthropic:claude-opus-4-6",
      resolvedThinking: "off",
      resolvedReasoningMode: "standard",
    });
  });

  // Per-agent pro-mode restore: explicit switches (useWorkspaceByAgentFallback)
  // must restore the agent's saved reasoningMode alongside model/thinking;
  // background sync inherits the workspace's current mode.
  test("restores the agent's saved pro mode on explicit switches", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "medium", reasoningMode: "pro" },
      },
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "standard",
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("inherits the workspace's current pro mode during background sync", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "medium", reasoningMode: "standard" },
      },
      useWorkspaceByAgentFallback: false,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "pro",
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("defaults legacy per-agent entries without reasoningMode to standard on explicit switches", () => {
    // A workspaceByAgent entry saved before pro mode shipped has no
    // reasoningMode field. Explicitly switching to that agent must not inherit
    // the previous agent's pro mode — absent means "standard" (same semantics
    // as WorkspaceContext seeding).
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "medium" },
      },
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "pro",
    });

    expect(result.resolvedReasoningMode).toBe("standard");
  });

  test("inherits the workspace mode on explicit switches without a per-agent entry", () => {
    // No workspaceByAgent entry at all: nothing saved for this agent, so the
    // workspace's current mode carries over (distinct from the legacy-entry case).
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "pro",
    });

    expect(result.resolvedReasoningMode).toBe("pro");
  });

  test("self-heals a corrupt saved reasoning mode to standard", () => {
    const result = resolveWorkspaceAiSettingsForAgent({
      agentId: "exec",
      agentAiDefaults: {},
      workspaceByAgent: {
        exec: {
          model: "openai:gpt-5.6-sol",
          thinkingLevel: "medium",
          reasoningMode: "ultra" as unknown as OpenAIReasoningMode,
        },
      },
      useWorkspaceByAgentFallback: true,
      fallbackModel: "openai:gpt-5.2-mini",
      existingModel: "openai:gpt-5.6-sol",
      existingThinking: "off",
      existingReasoningMode: "corrupt" as unknown as OpenAIReasoningMode,
    });

    expect(result.resolvedReasoningMode).toBe("standard");
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
      resolvedReasoningMode: "standard",
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
      resolvedReasoningMode: "standard",
    });
  });
});
