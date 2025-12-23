import { describe, test, expect } from "bun:test";
import type { DisplayedMessage } from "@/common/types/message";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";

type ToolMessage = Extract<DisplayedMessage, { type: "tool" }>;

function isAgentReportToolMessage(msg: DisplayedMessage, toolCallId: string): msg is ToolMessage {
  return msg.type === "tool" && msg.toolCallId === toolCallId && msg.toolName === "agent_report";
}

describe("StreamingMessageAggregator - agent_report tool-call-delta preview", () => {
  test("materializes agent_report tool part from tool-call-delta and updates it", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);

    const workspaceId = "test-workspace";
    const messageId = "msg-1";
    const toolCallId = "tool-1";
    const baseTs = 1000;

    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId,
      messageId,
      historySequence: 1,
      model: "test-model",
      startTime: baseTs,
    });

    // tool-call-delta arrives before tool-call-start.
    aggregator.handleToolCallDelta({
      type: "tool-call-delta",
      workspaceId,
      messageId,
      toolCallId,
      toolName: "agent_report",
      delta: '{"reportMarkdown":"Hello\\nWor',
      tokens: 5,
      timestamp: baseTs + 1,
    });

    let displayed = aggregator.getDisplayedMessages();
    let toolMsgs = displayed.filter((m): m is ToolMessage =>
      isAgentReportToolMessage(m, toolCallId)
    );
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].status).toBe("executing");
    expect(toolMsgs[0].args).toEqual({ reportMarkdown: "Hello\nWor" });

    // Subsequent deltas should patch the in-flight tool args.
    aggregator.handleToolCallDelta({
      type: "tool-call-delta",
      workspaceId,
      messageId,
      toolCallId,
      toolName: "agent_report",
      delta: 'ld","title":"Result"}',
      tokens: 5,
      timestamp: baseTs + 2,
    });

    displayed = aggregator.getDisplayedMessages();
    toolMsgs = displayed.filter((m): m is ToolMessage => isAgentReportToolMessage(m, toolCallId));
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].status).toBe("executing");
    expect(toolMsgs[0].args).toEqual({ reportMarkdown: "Hello\nWorld", title: "Result" });

    // When tool-call-start arrives later, it should update the existing part instead of creating a duplicate.
    aggregator.handleToolCallStart({
      type: "tool-call-start",
      workspaceId,
      messageId,
      toolCallId,
      toolName: "agent_report",
      args: { reportMarkdown: "Hello\nWorld", title: "Result" },
      tokens: 10,
      timestamp: baseTs + 3,
    });

    displayed = aggregator.getDisplayedMessages();
    toolMsgs = displayed.filter((m): m is ToolMessage => isAgentReportToolMessage(m, toolCallId));
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].args).toEqual({ reportMarkdown: "Hello\nWorld", title: "Result" });
  });
});
