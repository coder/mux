import { describe, expect, test } from "bun:test";

import { appendStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import { createMuxMessage } from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "./displayedMessageBuilder";

const STAGED_ATTACHMENT = {
  kind: "staged" as const,
  id: "zip-1",
  filename: "archive.zip",
  mediaType: "application/zip",
  sizeBytes: 199,
  stagedPath: ".mux/user-attachments/id/archive.zip",
};

describe("buildDisplayedMessagesForMessage staged attachments", () => {
  test("preserves staged notices in compaction previews for chip rendering", () => {
    const followUpText = appendStagedAttachmentNotice("Continue work", [STAGED_ATTACHMENT]);
    const message = createMuxMessage("msg-1", "user", "/compact", {
      historySequence: 1,
      muxMetadata: {
        type: "compaction-request",
        rawCommand: "/compact",
        parsed: {
          followUpContent: {
            text: followUpText,
            model: "claude-sonnet-4-5",
            agentId: "exec",
          },
        },
      },
    });

    const displayed = buildDisplayedMessagesForMessage({
      message,
      hasActiveStream: false,
      isContextBoundaryMessage: () => false,
    });

    expect(displayed).toHaveLength(1);
    const userMessage = displayed[0];
    expect(userMessage?.type).toBe("user");
    if (userMessage?.type !== "user") return;
    expect(userMessage.content).toContain("Continue work");
    expect(userMessage.content).toContain("<attached-files>");
    expect(userMessage.content).toContain(".mux/user-attachments/id/archive.zip");
  });
});
