import { describe, expect, it } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { hasStartHerePlanSummary, isStartHerePlanSummaryMessage } from "./startHerePlanSummary";

function createTextMessage(overrides: Partial<MuxMessage>): MuxMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2)}`,
    role: overrides.role ?? "assistant",
    parts: overrides.parts ?? [{ type: "text", text: "hello" }],
    metadata: overrides.metadata,
  };
}

describe("isStartHerePlanSummaryMessage", () => {
  it("returns true for Start Here summary messages", () => {
    const msg = createTextMessage({
      id: "start-here-123",
      role: "assistant",
      metadata: { compacted: "user", agentId: "plan" },
      parts: [
        {
          type: "text",
          text: "# My Plan\n\n---\n\n*Plan file preserved at:* `~/.mux/plans/demo.md`",
        },
      ],
    });

    expect(isStartHerePlanSummaryMessage(msg)).toBe(true);
  });

  it("returns false for other Start Here messages from the plan agent", () => {
    const msg = createTextMessage({
      id: "start-here-123",
      role: "assistant",
      metadata: { compacted: "user", agentId: "plan" },
      parts: [{ type: "text", text: "Some other message" }],
    });

    expect(isStartHerePlanSummaryMessage(msg)).toBe(false);
  });

  it("returns false for normal assistant messages", () => {
    const msg = createTextMessage({
      id: "msg-1",
      role: "assistant",
      metadata: { agentId: "plan" },
      parts: [{ type: "text", text: "# My Plan" }],
    });

    expect(isStartHerePlanSummaryMessage(msg)).toBe(false);
  });
});

describe("hasStartHerePlanSummary", () => {
  it("checks the last assistant message", () => {
    const messages: MuxMessage[] = [
      createTextMessage({
        id: "start-here-123",
        role: "assistant",
        metadata: { compacted: "user", agentId: "plan" },
        parts: [
          {
            type: "text",
            text: "*Plan file preserved at:* `~/.mux/plans/demo.md`",
          },
        ],
      }),
      createTextMessage({
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Implement the plan" }],
      }),
    ];

    expect(hasStartHerePlanSummary(messages)).toBe(true);

    // Once an exec response exists, the last assistant isn't the Start Here summary.
    const withExec = [
      ...messages,
      createTextMessage({ id: "msg-2", role: "assistant", metadata: { agentId: "exec" } }),
    ];
    expect(hasStartHerePlanSummary(withExec)).toBe(false);
  });
});
