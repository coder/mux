import { describe, expect, test } from "bun:test";
import { appendStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import type {
  CompactionFollowUpRequest,
  DisplayedUserMessage,
  MuxMessageMetadata,
  QueuedMessage,
} from "@/common/types/message";
import {
  buildEditingStateFromCompaction,
  buildEditingStateFromDisplayed,
  buildPendingFromDisplayed,
  buildPendingFromRestoredInput,
  canEditDisplayedUserMessage,
  getRestoredDraftPayloadSignature,
  getRestoredMuxMetadataForCurrentDraft,
  mergeNewAttachedReviewsIntoDraft,
  normalizeQueuedMessage,
} from "./chatEditing";

function userMessage(overrides: Partial<DisplayedUserMessage> = {}): DisplayedUserMessage {
  return {
    type: "user",
    id: "user-message",
    historyId: "user-message",
    content: "hello",
    historySequence: 1,
    ...overrides,
  };
}

const STAGED_ATTACHMENT = {
  kind: "staged" as const,
  id: "zip-1",
  filename: "archive.zip",
  mediaType: "application/zip",
  sizeBytes: 199,
  stagedPath: ".mux/user-attachments/id/archive.zip",
};

const REVIEW_NOTE = {
  filePath: "src/app.ts",
  lineRange: "+1",
  selectedCode: "const value = 1;",
  userNote: "Review this",
};

describe("canEditDisplayedUserMessage", () => {
  test("excludes goal-synthetic messages from all edit paths", () => {
    expect(canEditDisplayedUserMessage(userMessage({ isGoalContinuation: true }))).toBe(false);
    expect(canEditDisplayedUserMessage(userMessage({ isBudgetLimitWrapup: true }))).toBe(false);
  });

  test("excludes local command output messages", () => {
    expect(
      canEditDisplayedUserMessage(
        userMessage({ content: "<local-command-stdout>output</local-command-stdout>" })
      )
    ).toBe(false);
  });

  test("allows messages before the latest context boundary", () => {
    expect(canEditDisplayedUserMessage(userMessage({ isBeforeLatestContextBoundary: true }))).toBe(
      true
    );
  });

  test("marks pre-boundary edits so the send flow can confirm destructive rewind", () => {
    expect(
      buildEditingStateFromDisplayed(userMessage({ isBeforeLatestContextBoundary: true }))
        .isBeforeLatestContextBoundary
    ).toBe(true);
  });

  test("excludes side-question rows from edit paths", () => {
    expect(canEditDisplayedUserMessage(userMessage({ isSideQuestion: true }))).toBe(false);
  });

  test("restores staged ZIPs as attachments when editing sent messages", () => {
    const content = appendStagedAttachmentNotice("Inspect this archive.", [STAGED_ATTACHMENT]);

    const pending = buildPendingFromDisplayed(userMessage({ content, historyId: "history-1" }));

    expect(pending.content).toBe("Inspect this archive.");
    expect(pending.fileParts).toEqual([]);
    expect(pending.stagedAttachments).toEqual([
      {
        ...STAGED_ATTACHMENT,
        id: "edited-history-1-staged-0",
      },
    ]);
  });

  test("restores staged ZIPs as attachments when normalizing queued messages", () => {
    const queued: QueuedMessage = {
      id: "queued-1",
      content: appendStagedAttachmentNotice("Queued archive.", [STAGED_ATTACHMENT]),
    };

    const pending = normalizeQueuedMessage(queued);

    expect(pending.content).toBe("Queued archive.");
    expect(pending.stagedAttachments).toEqual([
      {
        ...STAGED_ATTACHMENT,
        id: "queued-queued-1-staged-0",
      },
    ]);
  });

  test("restores staged ZIPs from restore-to-input payloads with attachments", () => {
    const filePart = {
      url: "data:text/plain;base64,ZGF0YQ==",
      mediaType: "text/plain",
      filename: "context.txt",
    };
    const review = {
      filePath: "src/app.ts",
      lineRange: "+1",
      selectedCode: "const value = 1;",
      userNote: "Review this",
    };

    const pending = buildPendingFromRestoredInput({
      content: appendStagedAttachmentNotice("Restore queued work.", [STAGED_ATTACHMENT]),
      fileParts: [filePart],
      reviews: [review],
      idPrefix: "restored-queue",
    });

    expect(pending).toEqual({
      content: "Restore queued work.",
      fileParts: [filePart],
      stagedAttachments: [
        {
          ...STAGED_ATTACHMENT,
          id: "restored-queue-staged-0",
        },
      ],
      reviews: [review],
    });
  });

  test("keeps restored mux metadata only while the restored draft payload is unchanged", () => {
    const metadata: MuxMessageMetadata = {
      type: "agent-skill",
      rawCommand: "/test-skill investigate",
      commandPrefix: "/test-skill",
      skillName: "test-skill",
      scope: "project",
    };
    const sourceDraft = {
      text: "investigate",
      attachments: [STAGED_ATTACHMENT],
      reviews: [REVIEW_NOTE],
    };
    const sourceSignature = getRestoredDraftPayloadSignature(sourceDraft);

    expect(
      getRestoredMuxMetadataForCurrentDraft({
        currentDraft: sourceDraft,
        sourceSignature,
        muxMetadata: metadata,
      })
    ).toBe(metadata);

    expect(
      getRestoredMuxMetadataForCurrentDraft({
        currentDraft: {
          ...sourceDraft,
          text: "plain follow-up",
        },
        sourceSignature,
        muxMetadata: metadata,
      })
    ).toBeUndefined();

    expect(
      getRestoredMuxMetadataForCurrentDraft({
        currentDraft: {
          ...sourceDraft,
          attachments: [],
        },
        sourceSignature,
        muxMetadata: metadata,
      })
    ).toBeUndefined();

    expect(
      getRestoredMuxMetadataForCurrentDraft({
        currentDraft: {
          ...sourceDraft,
          reviews: [{ ...REVIEW_NOTE, userNote: "Different review" }],
        },
        sourceSignature,
        muxMetadata: metadata,
      })
    ).toBeUndefined();
  });

  test("merges newly attached reviews into restored draft reviews", () => {
    const laterReview = {
      filePath: "src/later.ts",
      lineRange: "+8",
      selectedCode: "const later = true;",
      userNote: "Add this too",
    };

    const result = mergeNewAttachedReviewsIntoDraft({
      draftReviews: [REVIEW_NOTE],
      attachedReviews: [
        {
          id: "existing-parent-review",
          data: REVIEW_NOTE,
          status: "attached",
          createdAt: 1,
        },
        {
          id: "duplicate-parent-review",
          data: REVIEW_NOTE,
          status: "attached",
          createdAt: 2,
        },
        {
          id: "second-duplicate-parent-review",
          data: REVIEW_NOTE,
          status: "attached",
          createdAt: 3,
        },
        {
          id: "new-parent-review",
          data: laterReview,
          status: "attached",
          createdAt: 4,
        },
      ],
      mergedAttachedReviewIds: new Set(["existing-parent-review"]),
    });

    expect(result.reviews).toEqual([REVIEW_NOTE, laterReview]);
    expect(result.mergedReviewIds).toEqual([
      "duplicate-parent-review",
      "second-duplicate-parent-review",
      "new-parent-review",
    ]);
    expect([...result.mergedAttachedReviewIds].sort()).toEqual([
      "duplicate-parent-review",
      "existing-parent-review",
      "new-parent-review",
      "second-duplicate-parent-review",
    ]);
  });

  test("restores staged ZIPs from compaction follow-up content", () => {
    const followUp: CompactionFollowUpRequest = {
      text: appendStagedAttachmentNotice("Continue after compaction.", [STAGED_ATTACHMENT]),
      model: "claude-sonnet-4-5",
      agentId: "exec",
    };

    const editingState = buildEditingStateFromCompaction("compact-message", "/compact", followUp);

    expect(editingState.pending.content).toBe("/compact");
    expect(editingState.pending.stagedAttachments).toEqual([
      {
        ...STAGED_ATTACHMENT,
        id: "compaction-compact-message-staged-0",
      },
    ]);
  });

  test("allows normal user messages", () => {
    expect(canEditDisplayedUserMessage(userMessage())).toBe(true);
  });
});
