import { describe, expect, test } from "bun:test";
import { appendStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import type { DisplayedMessage } from "@/common/types/message";
import type { ReviewNoteData } from "@/common/types/review";
import { createPromptHistoryInsertPayload } from "./PromptHistoryTab";
import { getPromptHistoryEntries } from "./promptHistoryEntries";

function userMessage(
  id: string,
  content: string,
  historySequence: number,
  overrides: Partial<Extract<DisplayedMessage, { type: "user" }>> = {}
): Extract<DisplayedMessage, { type: "user" }> {
  return {
    type: "user",
    id,
    historyId: id,
    content,
    historySequence,
    ...overrides,
  };
}

describe("getPromptHistoryEntries", () => {
  test("returns real user prompts sorted from oldest to newest", () => {
    const messages: DisplayedMessage[] = [
      userMessage("newer", "Newer prompt", 3),
      {
        type: "assistant",
        id: "assistant",
        historyId: "assistant",
        content: "Response",
        historySequence: 2,
        isStreaming: false,
        isPartial: false,
        isCompacted: false,
        isIdleCompacted: false,
      },
      userMessage("older", "Older prompt", 1),
    ];

    expect(getPromptHistoryEntries(messages).map((entry) => entry.historyId)).toEqual([
      "older",
      "newer",
    ]);
  });

  test("skips synthetic continuation prompts", () => {
    const messages: DisplayedMessage[] = [
      userMessage("real", "Please continue the work", 1),
      userMessage("auto", "Continue", 2, { isSynthetic: true }),
      userMessage("goal", "Synthetic goal continuation", 3, { isGoalContinuation: true }),
      userMessage("wrap", "Budget wrap-up", 4, { isBudgetLimitWrapup: true }),
    ];

    expect(getPromptHistoryEntries(messages).map((entry) => entry.historyId)).toEqual(["real"]);
  });

  test("skips completed local command output rows", () => {
    const entries = getPromptHistoryEntries([
      userMessage("stdout", "<local-command-stdout>build complete</local-command-stdout>", 1),
      userMessage("prompt", "What changed?", 2),
    ]);

    expect(entries.map((entry) => entry.historyId)).toEqual(["prompt"]);
  });

  test("keeps side-question prompts visible", () => {
    const [entry] = getPromptHistoryEntries([
      userMessage("side", "Can you compare this quickly?", 1, {
        commandPrefix: "/btw",
        isSideQuestion: true,
      }),
    ]);

    expect(entry).toMatchObject({
      historyId: "side",
      commandPrefix: "/btw",
      isSideQuestion: true,
    });
  });

  test("keeps attachment-only user prompts with file parts", () => {
    const fileParts = [
      {
        url: "data:text/plain;base64,SGVsbG8=",
        mediaType: "text/plain",
        filename: "note.txt",
      },
    ];
    const entries = getPromptHistoryEntries([
      userMessage("file-only", "", 1, {
        fileParts,
      }),
    ]);

    expect(entries).toEqual([
      {
        historyId: "file-only",
        content: "",
        historySequence: 1,
        timestamp: undefined,
        commandPrefix: undefined,
        isSideQuestion: false,
        fileCount: 1,
        fileParts,
      },
    ]);
  });

  test("insert payload clears attachments and reviews for text-only history", () => {
    const [entry] = getPromptHistoryEntries([userMessage("text-only", "Reuse this", 1)]);

    if (!entry) throw new Error("expected prompt history entry");
    expect(createPromptHistoryInsertPayload(entry)).toEqual({
      text: "Reuse this",
      mode: "replace",
      fileParts: [],
      reviews: [],
    });
  });

  test("insert payload preserves attached review notes from history", () => {
    const reviews: ReviewNoteData[] = [
      {
        filePath: "src/example.ts",
        lineRange: "+10-12",
        selectedCode: "const marker = '</review>';",
        userNote: "Please revisit this branch.",
      },
    ];
    const serializedReview = `<review>
Re src/example.ts:+10-12
\`\`\`
const marker = '</review>';
\`\`\`
> Please revisit this branch.
</review>`;
    const [entry] = getPromptHistoryEntries([
      userMessage("with-review", `${serializedReview}\n\nReuse review context`, 1, {
        reviews,
      }),
    ]);

    if (!entry) throw new Error("expected prompt history entry");
    expect(entry.content).toBe("Reuse review context");
    expect(entry.reviews).toEqual(reviews);
    expect(createPromptHistoryInsertPayload(entry)).toEqual({
      text: "Reuse review context",
      mode: "replace",
      fileParts: [],
      reviews,
    });
  });

  test("insert payload preserves staged attachments without duplicating review text", () => {
    const reviews: ReviewNoteData[] = [
      {
        filePath: "src/example.ts",
        lineRange: "+10-12",
        selectedCode: "const archived = true;",
        userNote: "Use this with the ZIP.",
      },
    ];
    const serializedReview = `<review>
Re src/example.ts:+10-12
\`\`\`
const archived = true;
\`\`\`
> Use this with the ZIP.
</review>`;
    const stagedAttachment = {
      kind: "staged" as const,
      id: "zip-1",
      filename: "archive.zip",
      mediaType: "application/zip",
      sizeBytes: 128,
      stagedPath: ".mux/user-attachments/id/archive.zip",
    };
    const visibleText = "Inspect the attached archive.";
    const messageContent = appendStagedAttachmentNotice(`${serializedReview}\n\n${visibleText}`, [
      stagedAttachment,
    ]);
    const [entry] = getPromptHistoryEntries([
      userMessage("with-staged", messageContent, 1, {
        reviews,
      }),
    ]);

    if (!entry) throw new Error("expected prompt history entry");
    expect(entry.content).toBe(visibleText);
    expect(entry.fileCount).toBe(1);
    expect(entry.insertContent).toContain("<attached-files>");
    expect(entry.insertContent).not.toContain("<review>");
    expect(createPromptHistoryInsertPayload(entry)).toEqual({
      text: appendStagedAttachmentNotice(visibleText, [stagedAttachment]),
      mode: "replace",
      fileParts: [],
      reviews,
    });
  });

  test("insert payload preserves compaction follow-up payloads", () => {
    const fileParts = [
      {
        url: "data:text/plain;base64,SGVsbG8=",
        mediaType: "text/plain",
        filename: "follow-up.txt",
      },
    ];
    const reviews: ReviewNoteData[] = [
      {
        filePath: "src/follow-up.ts",
        lineRange: "+3-5",
        selectedCode: "const retry = true;",
        userNote: "Keep this context when retrying.",
      },
    ];
    const [entry] = getPromptHistoryEntries([
      userMessage("compact", "/compact\nContinue after compaction", 1, {
        compactionRequest: {
          parsed: {
            followUpContent: {
              text: "Continue after compaction",
              model: "openai:gpt-5",
              agentId: "exec",
              fileParts,
              reviews,
              muxMetadata: {
                type: "agent-skill",
                skillName: "tests",
                scope: "global",
                rawCommand: "/tests run focused tests",
                commandPrefix: "/tests",
              },
            },
          },
        },
      }),
    ]);

    if (!entry) throw new Error("expected prompt history entry");
    expect(entry.fileCount).toBe(1);
    expect(entry.fileParts).toEqual(fileParts);
    expect(entry.reviews).toEqual(reviews);
    expect(entry.muxMetadata).toEqual({
      type: "agent-skill",
      skillName: "tests",
      scope: "global",
      rawCommand: "/tests run focused tests",
      commandPrefix: "/tests",
    });
    expect(createPromptHistoryInsertPayload(entry)).toEqual({
      text: "/compact\nContinue after compaction",
      mode: "replace",
      fileParts,
      reviews,
      muxMetadata: {
        type: "agent-skill",
        skillName: "tests",
        scope: "global",
        rawCommand: "/tests run focused tests",
        commandPrefix: "/tests",
      },
    });
  });
});
