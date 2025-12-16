import { describe, expect, test } from "bun:test";

import {
  estimatePersistedImageAttachmentsChars,
  parsePersistedImageAttachments,
} from "./draftImagesStorage";

describe("draftImagesStorage", () => {
  test("parsePersistedImageAttachments returns [] for non-arrays", () => {
    expect(parsePersistedImageAttachments(null)).toEqual([]);
    expect(parsePersistedImageAttachments({})).toEqual([]);
    expect(parsePersistedImageAttachments("nope")).toEqual([]);
  });

  test("parsePersistedImageAttachments returns [] for invalid array items", () => {
    expect(parsePersistedImageAttachments([{}])).toEqual([]);
    expect(
      parsePersistedImageAttachments([{ id: "img", url: 123, mediaType: "image/png" }])
    ).toEqual([]);
  });

  test("parsePersistedImageAttachments returns attachments for valid items", () => {
    expect(
      parsePersistedImageAttachments([
        { id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" },
      ])
    ).toEqual([{ id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" }]);
  });

  test("estimatePersistedImageAttachmentsChars matches JSON length", () => {
    const images = [{ id: "img-1", url: "data:image/png;base64,AAA", mediaType: "image/png" }];
    expect(estimatePersistedImageAttachmentsChars(images)).toBe(JSON.stringify(images).length);
  });
});
