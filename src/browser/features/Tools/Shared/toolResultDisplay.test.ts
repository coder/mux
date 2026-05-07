import { describe, expect, it } from "@jest/globals";
import { redactToolResultAttachmentsForDisplay } from "./toolResultDisplay";

describe("redactToolResultAttachmentsForDisplay", () => {
  it("redacts media payloads", () => {
    const result = redactToolResultAttachmentsForDisplay({
      type: "content",
      value: [
        {
          type: "media",
          mediaType: "image/png",
          filename: "screenshot.png",
          data: "base64-image",
        },
      ],
    });

    expect(result).toEqual({
      type: "content",
      value: [
        {
          type: "media",
          mediaType: "image/png",
          filename: "screenshot.png",
          data: "[attachment data]",
        },
      ],
    });
  });

  it("redacts display-only file payloads", () => {
    const result = redactToolResultAttachmentsForDisplay({
      type: "content",
      value: [
        {
          type: "display_file",
          mediaType: "video/webm",
          filename: "clip.webm",
          data: "base64-video",
          providerOptions: { mux: { displayOnly: true, size: 12 } },
        },
      ],
    });

    expect(result).toEqual({
      type: "content",
      value: [
        {
          type: "display_file",
          mediaType: "video/webm",
          filename: "clip.webm",
          data: "[display-only file data]",
          providerOptions: { mux: { displayOnly: true, size: 12 } },
        },
      ],
    });
  });

  it("passes through non-attachment content", () => {
    const input = {
      type: "content",
      value: [{ type: "text", text: "hello" }, { success: true }],
    };

    expect(redactToolResultAttachmentsForDisplay(input)).toEqual(input);
  });
});
