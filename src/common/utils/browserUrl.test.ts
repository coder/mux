import { describe, expect, test } from "bun:test";
import { BROWSER_URL_MAX_LENGTH, normalizeBrowserUrl } from "./browserUrl";

describe("normalizeBrowserUrl", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeBrowserUrl("  https://example.com/docs?q=1#hash  ")).toEqual({
      ok: true,
      normalizedUrl: "https://example.com/docs?q=1#hash",
    });
  });

  test("normalizes https URLs via URL.href", () => {
    expect(normalizeBrowserUrl("https://example.com")).toEqual({
      ok: true,
      normalizedUrl: "https://example.com/",
    });
  });

  test("normalizes http localhost URLs via URL.href", () => {
    expect(normalizeBrowserUrl("http://localhost:4177")).toEqual({
      ok: true,
      normalizedUrl: "http://localhost:4177/",
    });
  });

  test("prefixes scheme-less URLs with https", () => {
    expect(normalizeBrowserUrl("example.com")).toEqual({
      ok: true,
      normalizedUrl: "https://example.com/",
    });
  });

  test("rejects about:blank", () => {
    expect(normalizeBrowserUrl("about:blank")).toEqual({
      ok: false,
      error: "Cannot navigate to about:blank",
    });
  });

  test("rejects empty input", () => {
    expect(normalizeBrowserUrl("   ")).toEqual({ ok: false, error: "URL is required" });
  });

  test("rejects javascript URLs", () => {
    expect(normalizeBrowserUrl("javascript:alert(1)")).toEqual({
      ok: false,
      error: "Unsupported URL protocol. Only http:// and https:// URLs are allowed.",
    });
  });

  test("rejects data URLs", () => {
    expect(normalizeBrowserUrl("data:text/html,hello")).toEqual({
      ok: false,
      error: "Unsupported URL protocol. Only http:// and https:// URLs are allowed.",
    });
  });

  test("rejects file URLs", () => {
    expect(normalizeBrowserUrl("file:///etc/passwd")).toEqual({
      ok: false,
      error: "Unsupported URL protocol. Only http:// and https:// URLs are allowed.",
    });
  });

  test("rejects vbscript URLs", () => {
    expect(normalizeBrowserUrl("vbscript:msgbox(1)")).toEqual({
      ok: false,
      error: "Unsupported URL protocol. Only http:// and https:// URLs are allowed.",
    });
  });

  test("rejects overlong normalized URLs", () => {
    const overlongUrl = `https://example.com/${"a".repeat(BROWSER_URL_MAX_LENGTH)}`;

    expect(normalizeBrowserUrl(overlongUrl)).toEqual({
      ok: false,
      error: `URL must be ${BROWSER_URL_MAX_LENGTH} characters or fewer`,
    });
  });

  test("rejects malformed URLs after normalization", () => {
    expect(normalizeBrowserUrl("https://")).toEqual({ ok: false, error: "Invalid URL" });
  });
});
