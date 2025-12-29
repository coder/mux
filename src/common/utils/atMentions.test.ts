import { describe, expect, it } from "bun:test";

import { extractAtMentions, findAtMentionAtCursor } from "./atMentions";

describe("atMentions", () => {
  describe("extractAtMentions", () => {
    it("extracts basic @path mentions", () => {
      expect(extractAtMentions("see @src/foo.ts")).toEqual([
        {
          token: "src/foo.ts",
          path: "src/foo.ts",
        },
      ]);
    });

    it("strips trailing punctuation", () => {
      expect(extractAtMentions("see (@src/foo.ts), and @bar/baz.ts.")).toEqual([
        {
          token: "src/foo.ts",
          path: "src/foo.ts",
        },
        {
          token: "bar/baz.ts",
          path: "bar/baz.ts",
        },
      ]);
    });

    it("parses #L<start>-<end> ranges", () => {
      expect(extractAtMentions("check @src/foo.ts#L1-3")).toEqual([
        {
          token: "src/foo.ts#L1-3",
          path: "src/foo.ts",
          range: { startLine: 1, endLine: 3 },
        },
      ]);
    });

    it("records an error for unsupported fragments", () => {
      const mentions = extractAtMentions("check @src/foo.ts#anchor");
      expect(mentions).toHaveLength(1);
      expect(mentions[0]?.path).toBe("src/foo.ts");
      expect(mentions[0]?.range).toBeUndefined();
      expect(mentions[0]?.rangeError).toContain("expected #L<start>-<end>");
    });

    it("does not match email addresses", () => {
      expect(extractAtMentions("email foo@bar.com and see @src/foo.ts")).toEqual([
        {
          token: "src/foo.ts",
          path: "src/foo.ts",
        },
      ]);
    });
  });

  describe("findAtMentionAtCursor", () => {
    it("finds the active mention at cursor", () => {
      const text = "see @src/fo";
      expect(findAtMentionAtCursor(text, text.length)).toEqual({
        startIndex: 4,
        endIndex: text.length,
        query: "src/fo",
      });
    });

    it("supports leading punctuation before @", () => {
      const text = "(@src/fo";
      expect(findAtMentionAtCursor(text, text.length)).toEqual({
        startIndex: 1,
        endIndex: text.length,
        query: "src/fo",
      });
    });

    it("ignores word@word patterns", () => {
      const text = "foo@bar";
      expect(findAtMentionAtCursor(text, text.length)).toBeNull();
    });

    it("ignores tokens that already contain a fragment (#...)", () => {
      const text = "@src/foo.ts#L1-3";
      expect(findAtMentionAtCursor(text, text.length)).toBeNull();
    });

    it("excludes trailing punctuation from the match", () => {
      const text = "see @src/foo.ts,";
      expect(findAtMentionAtCursor(text, text.length)).toEqual({
        startIndex: 4,
        endIndex: 15,
        query: "src/foo.ts",
      });
    });
  });
});
