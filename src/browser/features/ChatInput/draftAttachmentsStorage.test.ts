import { describe, expect, test } from "bun:test";

import {
  estimatePersistedChatAttachmentsChars,
  parsePersistedChatAttachments,
} from "./draftAttachmentsStorage";

describe("draftAttachmentsStorage", () => {
  test("parsePersistedChatAttachments returns [] for non-arrays", () => {
    expect(parsePersistedChatAttachments(null)).toEqual([]);
    expect(parsePersistedChatAttachments({})).toEqual([]);
    expect(parsePersistedChatAttachments("nope")).toEqual([]);
  });

  test("parsePersistedChatAttachments returns [] for invalid array items", () => {
    expect(parsePersistedChatAttachments([{}])).toEqual([]);
    expect(
      parsePersistedChatAttachments([{ id: "img", url: 123, mediaType: "image/png" }])
    ).toEqual([]);
  });

  test("parsePersistedChatAttachments returns attachments for valid items", () => {
    expect(
      parsePersistedChatAttachments([
        { id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
      ])
    ).toEqual([
      { kind: "provider", id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
    ]);
  });

  test("parsePersistedChatAttachments preserves legacy provider attachments", () => {
    expect(
      parsePersistedChatAttachments([
        { id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
      ])
    ).toEqual([
      { kind: "provider", id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
    ]);
  });

  test("parsePersistedChatAttachments returns staged zip metadata without base64", () => {
    expect(
      parsePersistedChatAttachments([
        {
          kind: "staged",
          id: "zip-1",
          mediaType: "application/zip",
          filename: "archive.zip",
          sizeBytes: 123,
          stagedPath: ".mux/user-attachments/id/archive.zip",
        },
      ])
    ).toEqual([
      {
        kind: "staged",
        id: "zip-1",
        mediaType: "application/zip",
        filename: "archive.zip",
        sizeBytes: 123,
        stagedPath: ".mux/user-attachments/id/archive.zip",
      },
    ]);
  });

  test("parsePersistedChatAttachments self-heals invalid staged records", () => {
    expect(
      parsePersistedChatAttachments([
        {
          kind: "staged",
          id: "zip-1",
          mediaType: "application/zip",
          filename: "archive.zip",
          sizeBytes: "123",
          stagedPath: ".mux/user-attachments/id/archive.zip",
        },
      ])
    ).toEqual([]);
  });

  test("estimatePersistedChatAttachmentsChars matches JSON length", () => {
    const attachments = [
      {
        kind: "provider" as const,
        id: "img-1",
        url: "data:image/png;base64,AAA",
        mediaType: "image/png",
      },
    ];
    expect(estimatePersistedChatAttachmentsChars(attachments)).toBe(
      JSON.stringify(attachments).length
    );
  });
});
