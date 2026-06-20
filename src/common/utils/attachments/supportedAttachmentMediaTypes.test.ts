import { describe, expect, test } from "bun:test";

import {
  getAttachmentMediaTypeFromExtension,
  getSupportedAttachmentMediaType,
  getSupportedStagedAttachmentMediaType,
  isSupportedAttachmentMediaType,
} from "./supportedAttachmentMediaTypes";

describe("supportedAttachmentMediaTypes", () => {
  test("supports JSON attachments by media type and extension", () => {
    expect(isSupportedAttachmentMediaType("application/json")).toBe(true);
    expect(isSupportedAttachmentMediaType("application/json; charset=utf-8")).toBe(true);
    expect(getAttachmentMediaTypeFromExtension("config.json")).toBe("application/json");
  });

  test("falls back to .json extension when MIME type is empty", () => {
    expect(getSupportedAttachmentMediaType({ mediaType: "", filename: "package.json" })).toBe(
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
