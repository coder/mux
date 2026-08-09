import { describe, expect, it } from "bun:test";
import { dataUrlToBlob, getImageDownloadFilename } from "./imageActions";

describe("dataUrlToBlob", () => {
  it("decodes a valid base64 data URL into a typed blob", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,SGVsbG8=");

    expect(blob).not.toBeNull();
    expect(blob?.type).toBe("image/png");
    expect(await blob?.text()).toBe("Hello");
  });

  it("strips media type parameters", () => {
    const blob = dataUrlToBlob("data:IMAGE/PNG;base64,SGVsbG8=");
    expect(blob?.type).toBe("image/png");
  });

  it("returns null for non-data URLs and non-base64 payloads", () => {
    expect(dataUrlToBlob("https://example.com/image.png")).toBeNull();
    expect(dataUrlToBlob("data:image/png,rawpayload")).toBeNull();
    expect(dataUrlToBlob("data:image/png;base64,not valid base64!!")).toBeNull();
  });
});

describe("getImageDownloadFilename", () => {
  it("prefers the attachment's own filename", () => {
    expect(getImageDownloadFilename("screenshot.png", "image/png")).toBe("screenshot.png");
  });

  it("derives an extension from the media type when no filename exists", () => {
    expect(getImageDownloadFilename(undefined, "image/png")).toBe("image.png");
    expect(getImageDownloadFilename(undefined, "image/webp")).toBe("image.webp");
  });

  it("maps subtypes whose extension differs from the MIME subtype", () => {
    expect(getImageDownloadFilename(undefined, "image/jpeg")).toBe("image.jpg");
    expect(getImageDownloadFilename(undefined, "image/svg+xml")).toBe("image.svg");
  });

  it("normalizes media type casing and parameters", () => {
    expect(getImageDownloadFilename(undefined, "IMAGE/PNG; charset=binary")).toBe("image.png");
  });

  it("falls back to a bare name when no extension can be derived", () => {
    expect(getImageDownloadFilename(undefined, "image")).toBe("image");
    expect(getImageDownloadFilename("", "image/png")).toBe("image.png");
  });
});
