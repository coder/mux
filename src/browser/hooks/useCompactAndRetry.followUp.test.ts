import { describe, expect, test } from "bun:test";
import { buildFollowUpFromSource } from "./useCompactAndRetry";
import type { DisplayedUserMessage } from "@/common/types/message";

function userMessage(overrides: Partial<DisplayedUserMessage>): DisplayedUserMessage {
  return {
    type: "user",
    id: "user-1",
    historyId: "user-1",
    content: "Fix the bug",
    historySequence: 1,
    ...overrides,
  };
}

describe("buildFollowUpFromSource", () => {
  test("rebuilds the transformed invocation text for a slash MCP prompt turn", () => {
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: "/mcp__coder__review src security",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "slash",
            arguments: { path: "src", focus: "security" },
          },
        ],
      })
    );

    expect(followUp.text).toBe("Using MCP prompt coder/review: src security");
    expect(followUp.muxMetadata?.mcpPromptRefs).toHaveLength(1);
  });

  test("keeps plain user content unchanged", () => {
    const followUp = buildFollowUpFromSource(userMessage({ content: "Fix the bug" }));
    expect(followUp.text).toBe("Fix the bug");
    expect(followUp.muxMetadata).toBeUndefined();
  });

  test("keeps inline-only MCP prompt turns unchanged", () => {
    const followUp = buildFollowUpFromSource(
      userMessage({
        content: "Check $mcp__coder__review please",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "inline",
          },
        ],
      })
    );
    expect(followUp.text).toBe("Check $mcp__coder__review please");
    expect(followUp.muxMetadata?.mcpPromptRefs).toHaveLength(1);
  });
});
