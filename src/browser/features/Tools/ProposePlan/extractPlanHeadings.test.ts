import { describe, expect, test } from "bun:test";
import { extractPlanHeadings } from "./extractPlanHeadings";

describe("extractPlanHeadings", () => {
  test("returns empty array for empty input", () => {
    expect(extractPlanHeadings("")).toEqual([]);
  });

  test("extracts ATX headings with correct level + text", () => {
    const md = `# Title\n\nintro\n\n## Section A\n\nbody\n\n### Subsection\n\nmore`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Title" },
      { renderIndex: 1, level: 2, text: "Section A" },
      { renderIndex: 2, level: 3, text: "Subsection" },
    ]);
  });

  test("accepts trailing closing # markers on ATX headings", () => {
    const md = `# Title #\n## With trailing ##`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Title" },
      { renderIndex: 1, level: 2, text: "With trailing" },
    ]);
  });

  test("strips inline formatting in heading text", () => {
    const md = `# **Bold** and _italic_\n## With \`code\` inline\n### [Linked](https://example.com) heading\n#### ~~strike~~ through`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Bold and italic" },
      { renderIndex: 1, level: 2, text: "With code inline" },
      { renderIndex: 2, level: 3, text: "Linked heading" },
      { renderIndex: 3, level: 4, text: "strike through" },
    ]);
  });

  test("ignores hashtags without space after the markers", () => {
    const md = `#nothashtag\n# Real heading`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 1, text: "Real heading" }]);
  });

  test("skips ATX-looking lines inside fenced code blocks", () => {
    const md = `# Real heading\n\n\`\`\`markdown\n# Not a heading\n## Also not\n\`\`\`\n\n## After code`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Real heading" },
      { renderIndex: 1, level: 2, text: "After code" },
    ]);
  });

  test("handles tilde-fenced code blocks too", () => {
    const md = `# Outer\n\n~~~\n# Not a heading\n~~~\n\n## After`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Outer" },
      { renderIndex: 1, level: 2, text: "After" },
    ]);
  });

  test("does not treat tilde fence as closing a backtick fence", () => {
    // The tilde line is content inside the backtick fence, not a closer.
    const md = `\`\`\`\n# Hidden\n~~~\n# Still hidden\n\`\`\`\n\n# Visible`;
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 1, text: "Visible" }]);
  });

  test("recognizes setext h1 and h2 underlines", () => {
    const md = `Title One\n=========\n\nbody\n\nTitle Two\n---------\n\nmore`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Title One" },
      { renderIndex: 1, level: 2, text: "Title Two" },
    ]);
  });

  test("does not confuse thematic breaks with setext underlines", () => {
    const md = `Some intro paragraph.\n\n---\n\n# Heading`;
    // The `---` here is preceded by a blank line, so it's a thematic break, not
    // a setext underline. The TOC should only contain the ATX heading.
    expect(extractPlanHeadings(md)).toEqual([{ renderIndex: 0, level: 1, text: "Heading" }]);
  });

  test("counts raw HTML headings so renderIndex stays aligned", () => {
    const md = `# Markdown one\n\n<h2>Inline HTML two</h2>\n\n### Markdown three`;
    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "Markdown one" },
      { renderIndex: 1, level: 2, text: "Inline HTML two" },
      { renderIndex: 2, level: 3, text: "Markdown three" },
    ]);
  });

  test("preserves stable render indices across mixed content", () => {
    const md = [
      "# A",
      "",
      "para",
      "",
      "## B",
      "",
      "```",
      "# inside-fence",
      "```",
      "",
      "### C",
      "",
      "<h4>D</h4>",
      "",
      "##### E",
    ].join("\n");

    expect(extractPlanHeadings(md)).toEqual([
      { renderIndex: 0, level: 1, text: "A" },
      { renderIndex: 1, level: 2, text: "B" },
      { renderIndex: 2, level: 3, text: "C" },
      { renderIndex: 3, level: 4, text: "D" },
      { renderIndex: 4, level: 5, text: "E" },
    ]);
  });
});
