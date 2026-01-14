import { describe, it, expect } from "bun:test";
import { extractUrls, categorizeUrl, deduplicateLinks, type DetectedLink } from "./links";

describe("extractUrls", () => {
  it("extracts URLs from plain text", () => {
    const text = "Check out https://example.com and https://github.com/repo";
    expect(extractUrls(text)).toEqual(["https://example.com", "https://github.com/repo"]);
  });

  it("handles markdown links", () => {
    const text = "See [the PR](https://github.com/owner/repo/pull/123) for details";
    expect(extractUrls(text)).toEqual(["https://github.com/owner/repo/pull/123"]);
  });

  it("strips trailing punctuation", () => {
    const text = "Visit https://example.com. Or https://other.com!";
    expect(extractUrls(text)).toEqual(["https://example.com", "https://other.com"]);
  });

  it("handles URLs in code blocks", () => {
    const text = "```\nhttps://example.com/api\n```";
    expect(extractUrls(text)).toEqual(["https://example.com/api"]);
  });

  it("returns empty array for text without URLs", () => {
    expect(extractUrls("No links here")).toEqual([]);
  });

  it("handles complex URLs with paths and query strings", () => {
    const text = "API: https://api.example.com/v1/users?page=1&limit=10";
    expect(extractUrls(text)).toEqual(["https://api.example.com/v1/users?page=1&limit=10"]);
  });

  it("handles terminal output with tabs and column separators", () => {
    // This is typical gh CLI output format
    const text =
      "Build / Linux\tpending\t0\thttps://github.com/owner/repo/actions/runs/123/job/456\t\nBuild / macOS\tpass\t8s\thttps://github.com/owner/repo/actions/runs/123/job/789\t";
    expect(extractUrls(text)).toEqual([
      "https://github.com/owner/repo/actions/runs/123/job/456",
      "https://github.com/owner/repo/actions/runs/123/job/789",
    ]);
  });

  it("handles URLs with backslash escapes from terminal", () => {
    const text = "See https://github.com/owner/repo\\nMore text";
    expect(extractUrls(text)).toEqual(["https://github.com/owner/repo"]);
  });

  it("handles URLs ending with literal backslash-t", () => {
    // This pattern appears in gh pr checks output
    const text = "Mintlify Deployment\\tskipping\\t0\\thttps://mintlify.com\\t";
    expect(extractUrls(text)).toEqual(["https://mintlify.com"]);
  });

  it("handles mixed tab formats", () => {
    // Mix of actual tabs and literal \t sequences
    const text = "Check\thttps://example.com\\t\\nNext";
    expect(extractUrls(text)).toEqual(["https://example.com"]);
  });
});

describe("categorizeUrl", () => {
  it("creates generic links with metadata", () => {
    const result = categorizeUrl("https://example.com/page");
    expect(result.type).toBe("generic");
    expect(result.url).toBe("https://example.com/page");
    // Should have metadata initialized
    expect(result.detectedAt).toBeGreaterThan(0);
    expect(result.occurrenceCount).toBe(1);
  });

  it("accepts custom timestamp", () => {
    const timestamp = 1234567890;
    const result = categorizeUrl("https://example.com", timestamp);
    expect(result.detectedAt).toBe(timestamp);
  });
});

describe("deduplicateLinks", () => {
  const now = Date.now();

  it("removes duplicate links by URL", () => {
    const links: DetectedLink[] = [
      { type: "generic", url: "https://a.com", detectedAt: now, occurrenceCount: 1 },
      { type: "generic", url: "https://b.com", detectedAt: now, occurrenceCount: 1 },
      { type: "generic", url: "https://a.com", detectedAt: now, occurrenceCount: 1 },
    ];
    const result = deduplicateLinks(links);
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe("https://a.com");
    expect(result[1].url).toBe("https://b.com");
  });

  it("keeps first occurrence of duplicate", () => {
    const links: DetectedLink[] = [
      {
        type: "generic",
        url: "https://a.com",
        title: "First",
        detectedAt: now,
        occurrenceCount: 1,
      },
      {
        type: "generic",
        url: "https://a.com",
        title: "Second",
        detectedAt: now,
        occurrenceCount: 1,
      },
    ];
    const result = deduplicateLinks(links);
    expect(result).toHaveLength(1);
    expect((result[0] as { title?: string }).title).toBe("First");
  });
});
