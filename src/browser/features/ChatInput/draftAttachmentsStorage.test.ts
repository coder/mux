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
    ).toEqual([{ id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" }]);
  });

  test("estimatePersistedChatAttachmentsChars matches JSON length", () => {
    const attachments = [{ id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" }];
    expect(estimatePersistedChatAttachmentsChars(attachments)).toBe(
      JSON.stringify(attachments).length
    );
  });
});
