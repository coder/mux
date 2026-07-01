import { describe, expect, test } from "bun:test";

import {
  getAttachmentMediaTypeFromExtension,
  getSupportedAttachmentMediaType,
  getSupportedChatAttachmentMediaType,
  getSupportedStagedAttachmentMediaType,
  isSupportedAttachmentMediaType,
  isSupportedChatAttachmentMediaType,
} from "./supportedAttachmentMediaTypes";

describe("supportedAttachmentMediaTypes", () => {
  test("keeps JSON out of provider attachments while mapping its extension", () => {
    expect(isSupportedAttachmentMediaType("application/json")).toBe(false);
    expect(isSupportedAttachmentMediaType("application/json; charset=utf-8")).toBe(false);
    expect(getAttachmentMediaTypeFromExtension("config.json")).toBe("application/json");
  });

  test("supports JSON chat attachments by media type and extension", () => {
    expect(isSupportedChatAttachmentMediaType("application/json")).toBe(true);
    expect(isSupportedChatAttachmentMediaType("application/json; charset=utf-8")).toBe(true);
    expect(getSupportedChatAttachmentMediaType({ mediaType: "", filename: "package.json" })).toBe(
      "application/json"
    );
  });

  test("keeps .json extension fallback scoped to chat attachments", () => {
    expect(getSupportedAttachmentMediaType({ mediaType: "", filename: "package.json" })).toBe(null);
    expect(getSupportedChatAttachmentMediaType({ mediaType: "", filename: "package.json" })).toBe(
      "application/json"
    );
  });

  test("keeps arbitrary text files unsupported", () => {
    expect(
      getSupportedAttachmentMediaType({ mediaType: "text/plain", filename: "notes.txt" })
    ).toBeNull();
  });

  test("classifies zip files as staged attachments without making them provider attachments", () => {
    expect(getSupportedAttachmentMediaType({ mediaType: "", filename: "archive.zip" })).toBeNull();
    expect(getSupportedStagedAttachmentMediaType({ mediaType: "", filename: "archive.zip" })).toBe(
      "application/zip"
    );
    expect(
      getSupportedStagedAttachmentMediaType({
        mediaType: "application/x-zip-compressed",
        filename: "archive",
      })
    ).toBe("application/zip");
  });
});
