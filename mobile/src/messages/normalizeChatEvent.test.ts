import { describe, expect, it } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { createChatEventExpander } from "./normalizeChatEvent";
import type { WorkspaceChatEvent } from "../types";

describe("createChatEventExpander", () => {
  it("emits workspace init lifecycle updates", () => {
    const expander = createChatEventExpander();

    const startEvents = expander.expand({
      type: "init-start",
      hookPath: "scripts/init.sh",
      timestamp: 1,
    } as WorkspaceChatEvent);

    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]).toMatchObject({
      type: "workspace-init",
      status: "running",
      lines: [],
    });

    const outputEvents = expander.expand({
      type: "init-output",
      line: "Installing dependencies",
      timestamp: 2,
    } as WorkspaceChatEvent);

    expect(outputEvents).toHaveLength(1);
    expect(outputEvents[0]).toMatchObject({
      type: "workspace-init",
      lines: ["Installing dependencies"],
    });

    const endEvents = expander.expand({
      type: "init-end",
      exitCode: 0,
      timestamp: 3,
    } as WorkspaceChatEvent);

    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]).toMatchObject({
      type: "workspace-init",
      status: "success",
      exitCode: 0,
    });
  });

  it("handles streaming lifecycle events and emits on stream-end", () => {
    const expander = createChatEventExpander();

    // Stream-start creates message but doesn't emit yet
    const startEvents = expander.expand({
      type: "stream-start",
      messageId: "abc",
      historySequence: 1,
      model: "gpt-4",
      timestamp: Date.now(),
    } as WorkspaceChatEvent);

    expect(startEvents).toHaveLength(0);

    // Stream-delta emits a partial chunk for live rendering
    const deltaEvents = expander.expand({
      type: "stream-delta",
      messageId: "abc",
      delta: "Hello",
      tokens: 1,
      timestamp: Date.now(),
    } as WorkspaceChatEvent);

    expect(deltaEvents).toHaveLength(1);
    expect(deltaEvents[0]).toMatchObject({
      type: "assistant",
      content: "Hello",
    });

    // Stream-end emits the accumulated message (non-streaming)
    const endEvents = expander.expand({
      type: "stream-end",
      messageId: "abc",
      metadata: {},
      parts: [],
      timestamp: Date.now(),
    } as WorkspaceChatEvent);

    expect(endEvents.length).toBeGreaterThan(0);
    expect(endEvents[0]).toMatchObject({
      type: "assistant",
      content: "Hello",
    });
  });

  it("surfaces unsupported events as status notifications", () => {
    const expander = createChatEventExpander();

    const events = expander.expand({
      type: "custom-event",
      foo: "bar",
    } as WorkspaceChatEvent);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "status",
    });
  });

  it("emits displayable entries for mux messages replayed from history", () => {
    const expander = createChatEventExpander();

    const userMuxMessage: MuxMessage = {
      id: "user-history-1",
      role: "user",
      parts: [
        {
          type: "text",
          text: "Show me the plan",
        },
      ],
      metadata: {
        historySequence: 3,
        timestamp: 1,
      },
    };

    const assistantMuxMessage: MuxMessage = {
      id: "assistant-history-1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Sure, here is the outline",
        },
      ],
      metadata: {
        historySequence: 4,
        timestamp: 2,
      },
    };

    const userEvents = expander.expand(userMuxMessage as unknown as WorkspaceChatEvent);
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]).toMatchObject({
      type: "user",
      content: "Show me the plan",
      historySequence: 3,
    });

    const assistantEvents = expander.expand(assistantMuxMessage as unknown as WorkspaceChatEvent);
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents[0]).toMatchObject({
      type: "assistant",
      content: "Sure, here is the outline",
      historySequence: 4,
    });
  });
});
