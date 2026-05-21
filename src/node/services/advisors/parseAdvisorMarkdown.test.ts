import { describe, expect, test } from "bun:test";

import { AdvisorNameSchema } from "@/common/orpc/schemas";
import { AdvisorParseError, parseAdvisorMarkdown } from "./parseAdvisorMarkdown";

const VALID_MODEL = "anthropic:claude-opus-4-5";

function byteSize(content: string): number {
  return Buffer.byteLength(content, "utf-8");
}

describe("parseAdvisorMarkdown", () => {
  test("parses valid frontmatter and body", () => {
    const content = `---
description: Use for ML problems.
model: ${VALID_MODEL}
thinking: high
max_uses_per_turn: 2
agents: [exec, plan]
---
You are reviewing problems from an ML engineer.
`;

    const directoryName = AdvisorNameSchema.parse("ml-fellow");
    const result = parseAdvisorMarkdown({
      content,
      byteSize: byteSize(content),
      directoryName,
    });

    expect(result.frontmatter.description).toBe("Use for ML problems.");
    expect(result.frontmatter.model).toBe(VALID_MODEL);
    expect(result.frontmatter.thinking).toBe("high");
    expect(result.frontmatter.max_uses_per_turn).toBe(2);
    expect(result.frontmatter.agents).toEqual(["exec", "plan"]);
    expect(result.body).toContain("ML engineer");
  });

  test("accepts an empty body (advisor uses base prompt only)", () => {
    const content = `---
description: Default advisor.
model: ${VALID_MODEL}
---
`;
    const result = parseAdvisorMarkdown({ content, byteSize: byteSize(content) });
    expect(result.frontmatter.description).toBe("Default advisor.");
    expect(result.body.trim()).toBe("");
  });

  test("rejects content without frontmatter", () => {
    const content = `Just a body, no frontmatter.\n`;
    expect(() => parseAdvisorMarkdown({ content, byteSize: byteSize(content) })).toThrow(
      AdvisorParseError
    );
  });

  test("rejects unclosed frontmatter", () => {
    const content = `---\ndescription: Hello.\nmodel: ${VALID_MODEL}\nbody but no closing fence\n`;
    expect(() => parseAdvisorMarkdown({ content, byteSize: byteSize(content) })).toThrow(
      AdvisorParseError
    );
  });

  test("rejects missing required `model` field", () => {
    const content = `---\ndescription: Missing model.\n---\nbody\n`;
    try {
      parseAdvisorMarkdown({ content, byteSize: byteSize(content) });
      throw new Error("expected parse to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdvisorParseError);
      expect((err as Error).message).toMatch(/model/i);
    }
  });

  test("rejects malformed thinking level", () => {
    const content = `---\ndescription: Bad thinking.\nmodel: ${VALID_MODEL}\nthinking: maximum-overdrive\n---\n`;
    expect(() => parseAdvisorMarkdown({ content, byteSize: byteSize(content) })).toThrow(
      AdvisorParseError
    );
  });

  test("accepts max_uses_per_turn: null as the unlimited sentinel", () => {
    const content = `---\ndescription: Unlimited.\nmodel: ${VALID_MODEL}\nmax_uses_per_turn: null\n---\n`;
    const result = parseAdvisorMarkdown({ content, byteSize: byteSize(content) });
    expect(result.frontmatter.max_uses_per_turn).toBeNull();
  });

  test("rejects max_uses_per_turn = 0 (positive integer required)", () => {
    const content = `---\ndescription: Bad cap.\nmodel: ${VALID_MODEL}\nmax_uses_per_turn: 0\n---\n`;
    expect(() => parseAdvisorMarkdown({ content, byteSize: byteSize(content) })).toThrow(
      AdvisorParseError
    );
  });

  test("normalizes CRLF line endings before parsing", () => {
    const content = `---\r\ndescription: CRLF advisor.\r\nmodel: ${VALID_MODEL}\r\n---\r\nbody\r\n`;
    const result = parseAdvisorMarkdown({ content, byteSize: byteSize(content) });
    expect(result.frontmatter.description).toBe("CRLF advisor.");
    expect(result.body).toContain("body");
  });

  test("strips UTF-8 BOM before parsing", () => {
    const content = `\uFEFF---\ndescription: BOM advisor.\nmodel: ${VALID_MODEL}\n---\n`;
    const result = parseAdvisorMarkdown({ content, byteSize: byteSize(content) });
    expect(result.frontmatter.description).toBe("BOM advisor.");
  });
});
