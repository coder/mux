import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import { contentBlocksToText, muxChatMessageToSessionUpdate } from "./acpUtils";

describe("contentBlocksToText", () => {
  test("joins text blocks", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];

    expect(contentBlocksToText(blocks)).toBe("hello\n\nworld");
  });

  test("includes resource links", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "see" },
      {
        type: "resource_link",
        name: "file",
        uri: "file:///tmp/a.txt",
        title: "a.txt",
      },
    ];

    expect(contentBlocksToText(blocks)).toBe("see\n\n[resource] file:///tmp/a.txt (a.txt)");
  });
});

describe("muxChatMessageToSessionUpdate", () => {
  test("maps stream deltas to agent_message_chunk", () => {
    const msg: WorkspaceChatMessage = {
      type: "stream-delta",
      workspaceId: "w",
      messageId: "m",
      delta: "hi",
      tokens: 1,
      timestamp: 0,
    };

    expect(muxChatMessageToSessionUpdate(msg)).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "hi",
      },
    });
  });

  test("maps reasoning deltas to agent_thought_chunk", () => {
    const msg: WorkspaceChatMessage = {
      type: "reasoning-delta",
      workspaceId: "w",
      messageId: "m",
      delta: "thinking",
      tokens: 1,
      timestamp: 0,
    };

    expect(muxChatMessageToSessionUpdate(msg)).toEqual({
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: "thinking",
      },
    });
  });

  test("returns null for unhandled message types", () => {
    const msg: WorkspaceChatMessage = {
      type: "caught-up",
    };

    expect(muxChatMessageToSessionUpdate(msg)).toBeNull();
  });
});
