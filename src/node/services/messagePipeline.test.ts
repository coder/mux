import { describe, expect, it } from "bun:test";
import type { AssistantModelMessage, ModelMessage } from "ai";

import { transformModelMessages } from "@/browser/utils/messages/modelMessageTransform";
import { createMuxMessage } from "@/common/types/message";
import { prepareMessagesForProvider, sanitizeAssistantModelMessages } from "./messagePipeline";

function isAssistantMessage(message: ModelMessage | undefined): message is AssistantModelMessage {
  return message?.role === "assistant";
}

describe("sanitizeAssistantModelMessages", () => {
  it("preserves whitespace-only separators before later text coalescing", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "## Verdict" },
          { type: "text", text: "\n\n" },
          { type: "text", text: "This is now **strong evidence**." },
        ],
      },
    ];

    const sanitized = sanitizeAssistantModelMessages(messages);
    const transformed = transformModelMessages(sanitized, "openai");

    expect(isAssistantMessage(sanitized[0])).toBe(true);
    if (isAssistantMessage(sanitized[0])) {
      expect(sanitized[0].content).toEqual([
        { type: "text", text: "## Verdict\n\nThis is now **strong evidence**." },
      ]);
    }

    expect(isAssistantMessage(transformed[0])).toBe(true);
    if (isAssistantMessage(transformed[0])) {
      expect(transformed[0].content).toEqual([
        { type: "text", text: "## Verdict\n\nThis is now **strong evidence**." },
      ]);
    }
  });

  it("still filters assistant messages that contain only whitespace text", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "\n" },
          { type: "text", text: "\t " },
        ],
      },
    ];

    expect(sanitizeAssistantModelMessages(messages)).toEqual([]);
  });
});

describe("prepareMessagesForProvider log purity", () => {
  const baseOptions = {
    effectiveAgentId: "exec",
    toolNamesForSentinel: [] as string[],
    providerForMessages: "anthropic",
    effectiveThinkingLevel: "off" as const,
    modelString: "anthropic:claude-sonnet-4-5",
    workspaceId: "test-ws",
  };

  it("rebuilds identical provider messages from the same history rows", async () => {
    // Snapshot + file-change rows are durable history entries; the pipeline must
    // derive the request from them alone (no live disk reads or tracker state),
    // so building twice from the same log yields byte-identical messages.
    const messages = [
      createMuxMessage(
        "file-snapshot-1",
        "user",
        '<mux-file path="src/foo.ts" range="L1-L2">\n```ts\nline1\nline2\n```\n</mux-file>',
        { timestamp: 1000, synthetic: true, fileAtMentionSnapshot: ["src/foo.ts"] }
      ),
      createMuxMessage("user-1", "user", "Please check @src/foo.ts", { timestamp: 1001 }),
      createMuxMessage("assistant-1", "assistant", "Looks fine.", { timestamp: 1002 }),
      createMuxMessage(
        "file-change-1",
        "user",
        "<system-file-update>\nNote: src/foo.ts was modified.\n</system-file-update>",
        { timestamp: 1003, synthetic: true }
      ),
      createMuxMessage("user-2", "user", "Continue", { timestamp: 1004 }),
    ];

    const first = await prepareMessagesForProvider({
      ...baseOptions,
      messagesWithSentinel: messages,
    });
    const second = await prepareMessagesForProvider({
      ...baseOptions,
      messagesWithSentinel: messages,
    });

    expect(second).toEqual(first);

    // The model-visible file content comes from the log rows themselves.
    const serialized = JSON.stringify(first);
    expect(serialized).toContain("<mux-file");
    expect(serialized).toContain("<system-file-update>");
  });

  it("builds old-format histories with un-materialized @mentions as plain text", async () => {
    // Histories written before send-time @mention materialization contain no
    // snapshot rows. There is no request-time fallback that reads live disk, so
    // the mention stays plain text — and the request still builds without error.
    const messages = [
      createMuxMessage("user-1", "user", "Please check @src/foo.ts", { timestamp: 1000 }),
      createMuxMessage("assistant-1", "assistant", "Sure.", { timestamp: 1001 }),
      createMuxMessage("user-2", "user", "Continue", { timestamp: 1002 }),
    ];

    const result = await prepareMessagesForProvider({
      ...baseOptions,
      messagesWithSentinel: messages,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain("@src/foo.ts");
    expect(serialized).not.toContain("<mux-file");
  });
});
