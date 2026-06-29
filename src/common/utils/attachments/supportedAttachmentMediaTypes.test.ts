import { describe, expect, test } from "bun:test";

import {
  getSupportedAttachmentMediaType,
  getSupportedStagedAttachmentMediaType,
} from "./supportedAttachmentMediaTypes";

describe("supportedAttachmentMediaTypes", () => {
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
