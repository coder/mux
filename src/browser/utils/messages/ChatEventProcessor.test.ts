import { createChatEventProcessor } from "./ChatEventProcessor";

describe("ChatEventProcessor - Reasoning Delta", () => {
  it("should merge consecutive reasoning deltas into a single part", () => {
    const processor = createChatEventProcessor();
    const workspaceId = "ws-1";
    const messageId = "msg-1";

    // Start stream
    processor.handleEvent({
      type: "stream-start",
      workspaceId,
      messageId,
      model: "gpt-4",
      historySequence: 1,
      startTime: Date.now(),
    });

    // Send reasoning deltas
    processor.handleEvent({
      type: "reasoning-delta",
      workspaceId,
      messageId,
      delta: "Thinking",
      tokens: 1,
      timestamp: 1001,
    });

    processor.handleEvent({
      type: "reasoning-delta",
      workspaceId,
      messageId,
      delta: " about",
      tokens: 1,
      timestamp: 1002,
    });

    processor.handleEvent({
      type: "reasoning-delta",
      workspaceId,
      messageId,
      delta: " this...",
      tokens: 1,
      timestamp: 1003,
    });

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
    const workspaceId = "ws-1";
    const messageId = "msg-1";

    // Start stream
    processor.handleEvent({
      type: "stream-start",
      workspaceId,
      messageId,
      model: "gpt-4",
      historySequence: 1,
      startTime: Date.now(),
    });

    // Reasoning 1
    processor.handleEvent({
      type: "reasoning-delta",
      workspaceId,
      messageId,
      delta: "Part 1",
      tokens: 1,
      timestamp: 1001,
    });

    // Text delta (interruption - although usually reasoning comes before text)
    processor.handleEvent({
      type: "stream-delta",
      workspaceId,
      messageId,
      delta: "Some text",
      tokens: 2,
      timestamp: 1002,
    });

    // Reasoning 2
    processor.handleEvent({
      type: "reasoning-delta",
      workspaceId,
      messageId,
      delta: "Part 2",
      tokens: 1,
      timestamp: 1003,
    });

    const messages = processor.getMessages();
    const parts = messages[0].parts;

    // Should have: Reasoning "Part 1", Text "Some text", Reasoning "Part 2"
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: "reasoning", text: "Part 1" });
    expect(parts[1]).toMatchObject({ type: "text", text: "Some text" });
    expect(parts[2]).toMatchObject({ type: "reasoning", text: "Part 2" });
  });
});
