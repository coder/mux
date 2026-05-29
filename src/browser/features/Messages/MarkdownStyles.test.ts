import { describe, expect, test } from "bun:test";
import { normalizeMarkdown, normalizeReasoningMarkdown } from "./MarkdownStyles";

describe("normalizeMarkdown", () => {
  test("normalizes newline variants to LF", () => {
    expect(normalizeMarkdown("a\r\nb\rc\u2028d\u2029e\u0085f")).toBe("a\nb\nc\nd\ne\nf");
  });

  test("collapses 3+ consecutive newlines to exactly 2", () => {
    expect(normalizeMarkdown("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("normalizeReasoningMarkdown", () => {
  test("inserts a newline before bold section headers that follow punctuation", () => {
    expect(normalizeReasoningMarkdown("Done!**Heading**\n\nNext")).toBe(
      "Done!\n**Heading**\n\nNext"
    );
  });

  test("also handles a space before the header", () => {
    expect(normalizeReasoningMarkdown("Done! **Heading**\n\nNext")).toBe(
      "Done!\n**Heading**\n\nNext"
    );
  });

  test("does not modify already-separated headers", () => {
    expect(normalizeReasoningMarkdown("Done!\n**Heading**\n\nNext")).toBe(
      "Done!\n**Heading**\n\nNext"
    );
  });

  test("does not modify inline bold emphasis", () => {
    expect(normalizeReasoningMarkdown("This is **important**\n\nNext")).toBe(
      "This is **important**\n\nNext"
    );
  });
});
