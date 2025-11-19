import { createChatEventProcessor } from "./ChatEventProcessor";
import type { WorkspaceChatMessage } from "@/common/types/ipc";

describe("ChatEventProcessor - Reasoning Delta", () => {
  it("should merge consecutive reasoning deltas into a single part", () => {
    const processor = createChatEventProcessor();
    const messageId = "msg-1";

    // Start stream
    processor.handleEvent({
      type: "stream-start",
      workspaceId: "ws-1",
      messageId,
      role: "assistant",
      model: "gpt-4",
      timestamp: 1000,
      historySequence: 1,
    } as WorkspaceChatMessage);

    // Send reasoning deltas
    processor.handleEvent({
      type: "reasoning-delta",
      messageId,
      delta: "Thinking",
      timestamp: 1001,
    } as WorkspaceChatMessage);

    processor.handleEvent({
      type: "reasoning-delta",
      messageId,
      delta: " about",
      timestamp: 1002,
    } as WorkspaceChatMessage);

    processor.handleEvent({
      type: "reasoning-delta",
      messageId,
      delta: " this...",
      timestamp: 1003,
    } as WorkspaceChatMessage);

    const messages = processor.getMessages();
    expect(messages).toHaveLength(1);
    const message = messages[0];

    // Before fix: fails (3 parts)
    // After fix: succeeds (1 part)
    expect(message.parts).toHaveLength(1);
    expect(message.parts[0]).toEqual({
      type: "reasoning",
      text: "Thinking about this...",
      timestamp: 1001, // timestamp of first part
    });
  });

  it("should separate reasoning parts if interrupted by other content (though unlikely in practice)", () => {
    const processor = createChatEventProcessor();
    const messageId = "msg-1";

    // Start stream
    processor.handleEvent({
      type: "stream-start",
      workspaceId: "ws-1",
      messageId,
      role: "assistant",
      model: "gpt-4",
      timestamp: 1000,
      historySequence: 1,
    } as WorkspaceChatMessage);

    // Reasoning 1
    processor.handleEvent({
      type: "reasoning-delta",
      messageId,
      delta: "Part 1",
      timestamp: 1001,
    } as WorkspaceChatMessage);

    // Text delta (interruption - although usually reasoning comes before text)
    processor.handleEvent({
      type: "stream-delta",
      messageId,
      delta: "Some text",
      timestamp: 1002,
    } as WorkspaceChatMessage);

    // Reasoning 2
    processor.handleEvent({
      type: "reasoning-delta",
      messageId,
      delta: "Part 2",
      timestamp: 1003,
    } as WorkspaceChatMessage);

    const messages = processor.getMessages();
    const parts = messages[0].parts;

    // Should have: Reasoning "Part 1", Text "Some text", Reasoning "Part 2"
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: "reasoning", text: "Part 1" });
    expect(parts[1]).toMatchObject({ type: "text", text: "Some text" });
    expect(parts[2]).toMatchObject({ type: "reasoning", text: "Part 2" });
  });
});
