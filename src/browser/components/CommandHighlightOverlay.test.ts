import { extractCommandPrefix } from "@/browser/components/CommandHighlightOverlay";

describe("extractCommandPrefix", () => {
  it("returns null for non-command input", () => {
    expect(extractCommandPrefix("hello world")).toBeNull();
    expect(extractCommandPrefix("")).toBeNull();
    expect(extractCommandPrefix("  /command")).toBeNull(); // leading whitespace
  });

  it("returns null for just a slash", () => {
    expect(extractCommandPrefix("/")).toBeNull();
  });

  it("extracts simple command", () => {
    expect(extractCommandPrefix("/compact")).toBe("/compact");
    expect(extractCommandPrefix("/help")).toBe("/help");
  });

  it("extracts command with arguments", () => {
    expect(extractCommandPrefix("/compact -t 5000")).toBe("/compact -t 5000");
    expect(extractCommandPrefix("/model sonnet")).toBe("/model sonnet");
    expect(extractCommandPrefix("/providers set anthropic apiKey")).toBe(
      "/providers set anthropic apiKey"
    );
  });

  it("extracts command up to newline", () => {
    expect(extractCommandPrefix("/compact\nContinue working")).toBe("/compact");
    expect(extractCommandPrefix("/model sonnet\nDo the thing")).toBe("/model sonnet");
  });

  it("preserves trailing spaces on command line", () => {
    // Trailing spaces are part of the first line and should be included
    // so the overlay matches the textarea layout exactly
    expect(extractCommandPrefix("/compact ")).toBe("/compact ");
    expect(extractCommandPrefix("/model sonnet  ")).toBe("/model sonnet  ");
  });
});
