import { describe, expect, it } from "bun:test";
import {
  COPILOT_MODEL_PREFIXES,
  isCopilotModelAccessible,
  isCopilotRoutableModel,
  selectCopilotApiMode,
} from "./modelRouting";

describe("COPILOT_MODEL_PREFIXES", () => {
  it("exports the shared Copilot model family filters", () => {
    expect(COPILOT_MODEL_PREFIXES).toEqual(["gpt-5", "claude-", "gemini-3", "grok-code"]);
  });
});

describe("isCopilotRoutableModel", () => {
  it("keeps non-Codex models routable through Copilot", () => {
    expect(isCopilotRoutableModel("gpt-5.4")).toBe(true);
    expect(isCopilotRoutableModel("claude-opus-4-6")).toBe(true);
  });

  it("rejects Codex-family models from Copilot routing", () => {
    expect(isCopilotRoutableModel("gpt-5.3-codex")).toBe(false);
    expect(isCopilotRoutableModel("gpt-5.1-codex-mini")).toBe(false);
  });
});

describe("selectCopilotApiMode", () => {
  it("routes Codex-family models to chat completions", () => {
    expect(selectCopilotApiMode("gpt-5.3-codex")).toBe("chatCompletions");
    expect(selectCopilotApiMode("gpt-5.1-codex-mini")).toBe("chatCompletions");
  });

  it("routes GPT-5 and other Copilot families to chat completions", () => {
    expect(selectCopilotApiMode("gpt-5.4")).toBe("chatCompletions");
    expect(selectCopilotApiMode("gpt-5.4-pro")).toBe("chatCompletions");
    expect(selectCopilotApiMode("claude-opus-4-6")).toBe("chatCompletions");
    expect(selectCopilotApiMode("claude-sonnet-4-6")).toBe("chatCompletions");
    expect(selectCopilotApiMode("gemini-3.1-pro-preview")).toBe("chatCompletions");
    expect(selectCopilotApiMode("grok-code-fast-1")).toBe("chatCompletions");
  });

  it("falls back to chat completions for unknown or empty model ids", () => {
    expect(selectCopilotApiMode("")).toBe("chatCompletions");
    expect(selectCopilotApiMode("custom-preview-model")).toBe("chatCompletions");
  });

  it("keeps lookalike model ids on chat completions too", () => {
    expect(selectCopilotApiMode("claude")).toBe("chatCompletions");
    expect(selectCopilotApiMode("gemini-30-experimental")).toBe("chatCompletions");
    expect(selectCopilotApiMode("grok-codec-preview")).toBe("chatCompletions");
  });
});

describe("isCopilotModelAccessible", () => {
  it("returns true when the model is present in the fetched Copilot list", () => {
    expect(isCopilotModelAccessible("gpt-5.4", ["gpt-5.4", "claude-sonnet-4-6"])).toBe(true);
  });

  it("returns false when the model is absent from a non-empty Copilot list", () => {
    expect(isCopilotModelAccessible("gpt-5.4-pro", ["gpt-5.4", "claude-sonnet-4-6"])).toBe(false);
  });

  it("returns true when no Copilot model list has been persisted yet", () => {
    expect(isCopilotModelAccessible("gpt-5.4", [])).toBe(true);
  });

  it("uses exact string matching instead of prefix matching", () => {
    expect(isCopilotModelAccessible("gpt-5.4", ["gpt-5"])).toBe(false);
    expect(isCopilotModelAccessible("", ["gpt-5.4"])).toBe(false);
  });
});
