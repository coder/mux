import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { appendStagedAttachmentNotice } from "@/browser/features/ChatInput/stagedAttachments";
import type { StagedChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import { installDom } from "../../../../tests/ui/dom";
import { UserMessageContent } from "./UserMessageContent";

const STAGED_ATTACHMENT: StagedChatAttachment = {
  kind: "staged",
  id: "zip-1",
  filename: "archive.zip",
  mediaType: "application/zip",
  sizeBytes: 12_345,
  stagedPath: ".mux/user-attachments/id/archive.zip",
};

describe("UserMessageContent staged attachment rendering", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("hides the model-only staged attachment notice and renders a download chip", () => {
    const downloads: unknown[] = [];
    const content = appendStagedAttachmentNotice("Inspect this archive.", [STAGED_ATTACHMENT]);

    const view = render(
      <UserMessageContent
        content={content}
        variant="sent"
        onDownloadStagedAttachment={(attachment) => downloads.push(attachment)}
      />
    );

    expect(view.queryByText(/<attached-files>/)).toBeNull();
    expect(view.queryByText(/workspace filesystem/)).toBeNull();
    expect(view.getByText("Inspect this archive.")).toBeTruthy();

    const chip = view.getByRole("button", { name: /download archive\.zip/i });
    expect(chip.textContent).toContain("archive.zip");
    expect(chip.textContent).toContain("12.1 KB");

    fireEvent.click(chip);
    expect(downloads).toEqual([
      {
        filename: "archive.zip",
        mediaType: "application/zip",
        sizeLabel: "12.1 KB",
        sizeBytes: 12_390,
        stagedPath: ".mux/user-attachments/id/archive.zip",
      },
    ]);
  });
});
