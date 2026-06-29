import { describe, expect, test } from "bun:test";

import {
  appendStagedAttachmentNotice,
  buildStagedAttachmentNotice,
  parseStagedAttachmentNotice,
} from "./stagedAttachments";

describe("stagedAttachments", () => {
  test("builds a staged-file notice with filename, type, size, and path", () => {
    const notice = buildStagedAttachmentNotice([
      {
        kind: "staged",
        id: "zip-1",
        filename: "archive.zip",
        mediaType: "application/zip",
        sizeBytes: 12_345,
        stagedPath: ".mux/user-attachments/id/archive.zip",
      },
    ]);

    expect(notice).toContain("<attached-files>");
    expect(notice).toContain("`archive.zip` (`application/zip`, 12.1 KB)");
    expect(notice).toContain("`.mux/user-attachments/id/archive.zip`");
  });

  test("allows zip-only sends by returning the notice as message text", () => {
    const message = appendStagedAttachmentNotice("", [
      {
        kind: "staged",
        id: "zip-1",
        filename: "archive.zip",
        mediaType: "application/zip",
        sizeBytes: 1,
        stagedPath: ".mux/user-attachments/id/archive.zip",
      },
    ]);

    expect(message.trim()).toStartWith("<attached-files>");
  });

  test("parses staged notices into display attachments and visible text", () => {
    const message = appendStagedAttachmentNotice("Inspect this archive.", [
      {
        kind: "staged",
        id: "zip-1",
        filename: "archive.zip",
        mediaType: "application/zip",
        sizeBytes: 12_345,
        stagedPath: ".mux/user-attachments/id/archive.zip",
      },
    ]);

    expect(parseStagedAttachmentNotice(message)).toEqual({
      text: "Inspect this archive.",
      attachments: [
        {
          filename: "archive.zip",
          mediaType: "application/zip",
          sizeLabel: "12.1 KB",
          stagedPath: ".mux/user-attachments/id/archive.zip",
        },
      ],
    });
  });
});
