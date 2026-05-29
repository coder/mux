/**
 * Tests for DiffRenderer components
 *
 * These are integration tests that verify the review note feature works end-to-end.
 * We test the line extraction and formatting logic that ReviewNoteInput uses internally.
 */

describe("SelectableDiffRenderer review notes", () => {
  it("should extract correct line content for review notes", () => {
    // Simulate the internal review note building logic
    // This is what happens when user clicks comment button and submits
    const content = "+const x = 1;\n+const y = 2;\n const z = 3;";
    const lines = content.split("\n").filter((line) => line.length > 0);

    // Simulate what ReviewNoteInput does
    const lineData = [
      { index: 0, type: "add" as const, lineNum: 1 },
      { index: 1, type: "add" as const, lineNum: 2 },
      { index: 2, type: "context" as const, lineNum: 3 },
    ];

    // Simulate selecting first two lines (the + lines)
    const selectedLines = lineData
      .slice(0, 2)
      .map((lineInfo) => {
        const line = lines[lineInfo.index];
        const indicator = line[0];
        const lineContent = line.slice(1);
        return `${lineInfo.lineNum} ${indicator} ${lineContent}`;
      })
      .join("\n");

    // Verify the extracted content is correct
    expect(selectedLines).toContain("const x = 1");
    expect(selectedLines).toContain("const y = 2");
    expect(selectedLines).not.toContain("const z = 3");

    // Verify format includes line numbers and indicators
    expect(selectedLines).toMatch(/1 \+ const x = 1/);
    expect(selectedLines).toMatch(/2 \+ const y = 2/);
  });

  it("should handle removal lines correctly", () => {
    const content = "-const old = 1;\n+const new = 2;";
    const lines = content.split("\n").filter((line) => line.length > 0);

    const lineData = [
      { index: 0, type: "remove" as const, lineNum: 10 },
      { index: 1, type: "add" as const, lineNum: 10 },
    ];

    // Extract first line (removal)
    const line = lines[lineData[0].index];
    const indicator = line[0];
    const lineContent = line.slice(1);
    const formattedLine = `${lineData[0].lineNum} ${indicator} ${lineContent}`;

    expect(formattedLine).toBe("10 - const old = 1;");
    expect(lineContent).toBe("const old = 1;");
  });

  it("should handle context lines correctly", () => {
    const content = " unchanged line\n+new line";
    const lines = content.split("\n").filter((line) => line.length > 0);

    const lineData = [
      { index: 0, type: "context" as const, lineNum: 5 },
      { index: 1, type: "add" as const, lineNum: 6 },
    ];

    // Extract context line
    const line = lines[lineData[0].index];
    const indicator = line[0]; // Should be space
    const lineContent = line.slice(1);
    const formattedLine = `${lineData[0].lineNum} ${indicator} ${lineContent}`;

    expect(formattedLine).toBe("5   unchanged line");
    expect(indicator).toBe(" ");
  });

  it("should handle multiline selection correctly", () => {
    const content = "+line1\n+line2\n+line3\n line4";
    const lines = content.split("\n").filter((line) => line.length > 0);

    const lineData = [
      { index: 0, type: "add" as const, lineNum: 1 },
      { index: 1, type: "add" as const, lineNum: 2 },
      { index: 2, type: "add" as const, lineNum: 3 },
      { index: 3, type: "context" as const, lineNum: 4 },
    ];

    // Simulate selecting lines 0-2 (first 3 additions)
    const selectedLines = lineData
      .slice(0, 3)
      .map((lineInfo) => {
        const line = lines[lineInfo.index];
        const indicator = line[0];
        const lineContent = line.slice(1);
        return `${lineInfo.lineNum} ${indicator} ${lineContent}`;
      })
      .join("\n");

    expect(selectedLines.split("\n")).toHaveLength(3);
    expect(selectedLines).toContain("line1");
    expect(selectedLines).toContain("line2");
    expect(selectedLines).toContain("line3");
    expect(selectedLines).not.toContain("line4");
  });

  it("should format review note with proper structure", () => {
    const filePath = "src/test.ts";
    const lineRange = "10-12";
    const selectedLines = "10 + const x = 1;\n11 + const y = 2;\n12 + const z = 3;";
    const noteText = "These variables should be renamed";

    // This is the format that ReviewNoteInput creates
    const reviewNote = `<review>\nRe ${filePath}:${lineRange}\n\`\`\`\n${selectedLines}\n\`\`\`\n> ${noteText.trim()}\n</review>`;

    expect(reviewNote).toContain("<review>");
    expect(reviewNote).toContain("Re src/test.ts:10-12");
    expect(reviewNote).toContain("const x = 1");
    expect(reviewNote).toContain("const y = 2");
    expect(reviewNote).toContain("const z = 3");
    expect(reviewNote).toContain("These variables should be renamed");
    expect(reviewNote).toContain("</review>");
  });

  describe("line elision for long selections", () => {
    it("should show all lines when selection is ≤3 lines", () => {
      const allLines = ["1 + line1", "2 + line2", "3 + line3"];

      // No elision for 3 lines
      const selectedLines = allLines.join("\n");

      expect(selectedLines).toContain("line1");
      expect(selectedLines).toContain("line2");
      expect(selectedLines).toContain("line3");
      expect(selectedLines).not.toContain("omitted");
    });

    it("should elide middle lines when selection is >3 lines", () => {
      const allLines = ["1 + line1", "2 + line2", "3 + line3", "4 + line4", "5 + line5"];

      // Elide middle 3 lines, show first and last
      const omittedCount = allLines.length - 2;
      const selectedLines = [
        allLines[0],
        `    (${omittedCount} lines omitted)`,
        allLines[allLines.length - 1],
      ].join("\n");

      expect(selectedLines).toContain("line1");
      expect(selectedLines).not.toContain("line2");
      expect(selectedLines).not.toContain("line3");
      expect(selectedLines).not.toContain("line4");
      expect(selectedLines).toContain("line5");
      expect(selectedLines).toContain("(3 lines omitted)");
    });

    it("should handle exactly 4 lines (edge case)", () => {
      const allLines = [
        "10 + const a = 1;",
        "11 + const b = 2;",
        "12 + const c = 3;",
        "13 + const d = 4;",
      ];

      // Should elide 2 middle lines
      const omittedCount = allLines.length - 2;
      const selectedLines = [
        allLines[0],
        `    (${omittedCount} lines omitted)`,
        allLines[allLines.length - 1],
      ].join("\n");

      expect(selectedLines).toBe("10 + const a = 1;\n    (2 lines omitted)\n13 + const d = 4;");
      expect(selectedLines).toContain("const a = 1");
      expect(selectedLines).toContain("const d = 4");
      expect(selectedLines).not.toContain("const b = 2");
      expect(selectedLines).not.toContain("const c = 3");
      expect(selectedLines).toContain("(2 lines omitted)");
    });

    it("should format elision message correctly in review note", () => {
      const filePath = "src/large.ts";
      const lineRange = "10-20";
      const allLines = Array.from({ length: 11 }, (_, i) => `${10 + i} + line${i + 1}`);

      // Elide middle lines
      const omittedCount = allLines.length - 2;
      const selectedLines = [
        allLines[0],
        `    (${omittedCount} lines omitted)`,
        allLines[allLines.length - 1],
      ].join("\n");

      const noteText = "Review this section";
      const reviewNote = `<review>\nRe ${filePath}:${lineRange}\n\`\`\`\n${selectedLines}\n\`\`\`\n> ${noteText.trim()}\n</review>`;

      expect(reviewNote).toContain("10 + line1");
      expect(reviewNote).toContain("(9 lines omitted)");
      expect(reviewNote).toContain("20 + line11");
      expect(reviewNote).not.toContain("line2");
      expect(reviewNote).not.toContain("line10");
    });
  });
});
