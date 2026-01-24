import { describe, expect, test } from "bun:test";

import type { DebugLlmRequestSnapshot } from "./debugLlmRequest";

describe("DebugLlmRequestSnapshot", () => {
  test("is JSON + structured-clone safe", () => {
    const snapshot: DebugLlmRequestSnapshot = {
      capturedAt: Date.now(),
      workspaceId: "workspace-1",
      messageId: "assistant-1",
      model: "anthropic:claude-3-5-sonnet",
      providerName: "anthropic",
      thinkingLevel: "off",
      mode: "exec",
      agentId: "exec",
      maxOutputTokens: 1234,
      systemMessage: "System message",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ],
      response: {
        capturedAt: Date.now(),
        metadata: {
          model: "anthropic:claude-3-5-sonnet",
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            totalTokens: 3,
          },
        },
        parts: [{ type: "text", text: "done" }],
      },
    };

    expect(() => JSON.stringify(snapshot)).not.toThrow();

    if (typeof structuredClone === "function") {
      expect(() => structuredClone(snapshot)).not.toThrow();
    }
  });
});
