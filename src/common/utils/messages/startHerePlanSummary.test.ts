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
  it("returns true for Start Here summary messages that include plan content", () => {
    const msg = createTextMessage({
      id: "start-here-123",
      role: "assistant",
      metadata: { compacted: "user", agentId: "plan" },
      parts: [
        {
          type: "text",
          text: "# My Plan\n\n## Step\n- Do the thing\n\n---\n\n*Plan file preserved at:* `~/.mux/plans/demo.md`",
        },
      ],
    });

    expect(isStartHerePlanSummaryMessage(msg)).toBe(true);
  });

  it("returns false for Start Here summaries that only include the placeholder", () => {
    const msg = createTextMessage({
      id: "start-here-123",
      role: "assistant",
      metadata: { compacted: "user", agentId: "plan" },
      parts: [
        {
          type: "text",
          text: [
            "# My Plan",
            "",
            "*Plan saved to /tmp/demo.md*",
            "",
            "Note: This chat already contains the full plan; no need to re-open the plan file.",
            "",
            "---",
            "",
            "*Plan file preserved at:* `/tmp/demo.md`",
          ].join("\n"),
        },
      ],
    });

    expect(isStartHerePlanSummaryMessage(msg)).toBe(false);
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
  it("returns true when a Start Here plan summary exists anywhere in history", () => {
    const messages: MuxMessage[] = [
      createTextMessage({
        id: "start-here-123",
        role: "assistant",
        metadata: { compacted: "user", agentId: "plan" },
        parts: [
          {
            type: "text",
            text: "# My Plan\n\n## Step\n- Do the thing\n\n---\n\n*Plan file preserved at:* `~/.mux/plans/demo.md`",
          },
        ],
      }),
      createTextMessage({
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Implement the plan" }],
      }),
      createTextMessage({ id: "msg-2", role: "assistant", metadata: { agentId: "exec" } }),
    ];

    expect(hasStartHerePlanSummary(messages)).toBe(true);
  });
});
