import { extractModeSection } from "./markdown";

describe("extractModeSection", () => {
  describe("basic extraction", () => {
    it("should extract content under Mode: plan heading", () => {
      const markdown = `
# General Instructions
Some general content

# Mode: Plan
Planning specific content
More planning stuff

# Other Section
Other content
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toBe("Planning specific content\nMore planning stuff");
    });

    it("should return null when mode section doesn't exist", () => {
      const markdown = `
# General Instructions
Some content

# Other Section
Other content
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toBeNull();
    });

    it("should return null for empty markdown", () => {
      expect(extractModeSection("", "plan")).toBeNull();
    });

    it("should return null for empty mode", () => {
      expect(extractModeSection("# Mode: plan\nContent", "")).toBeNull();
    });
  });

  describe("case insensitivity", () => {
    it("should match case-insensitive heading", () => {
      const markdown = "# MODE: PLAN\nContent here";
      const result = extractModeSection(markdown, "plan");
      expect(result).toBe("Content here");
    });

    it("should match mixed case heading", () => {
      const markdown = "# MoDe: PlAn\nContent here";
      const result = extractModeSection(markdown, "plan");
      expect(result).toBe("Content here");
    });

    it("should match with case-insensitive mode parameter", () => {
      const markdown = "# Mode: plan\nContent here";
      const result = extractModeSection(markdown, "PLAN");
      expect(result).toBe("Content here");
    });
  });

  describe("heading levels", () => {
    it("should work with h1 heading", () => {
      const markdown = "# Mode: Plan\nContent";
      expect(extractModeSection(markdown, "plan")).toBe("Content");
    });

    it("should work with h2 heading", () => {
      const markdown = "## Mode: Plan\nContent";
      expect(extractModeSection(markdown, "plan")).toBe("Content");
    });

    it("should work with h3 heading", () => {
      const markdown = "### Mode: Plan\nContent";
      expect(extractModeSection(markdown, "plan")).toBe("Content");
    });

    it("should work with h6 heading", () => {
      const markdown = "###### Mode: Plan\nContent";
      expect(extractModeSection(markdown, "plan")).toBe("Content");
    });
  });

  describe("section boundaries", () => {
    it("should stop at next same-level heading", () => {
      const markdown = `
# Mode: Plan
Planning content

# Next Section
Other content
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toBe("Planning content");
    });

    it("should stop at next higher-level heading", () => {
      const markdown = `
## Mode: Plan
Planning content

# Next Section
Other content
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toBe("Planning content");
    });

    it("should include lower-level headings in section", () => {
      const markdown = `
# Mode: Plan
Planning content

## Subsection
More details

### Deep subsection
Even more

# Next Section
Other content
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toContain("Planning content");
      expect(result).toContain("## Subsection");
      expect(result).toContain("More details");
      expect(result).toContain("### Deep subsection");
      expect(result).toContain("Even more");
      expect(result).not.toContain("# Next Section");
    });

    it("should extract until end of file if no boundary heading", () => {
      const markdown = `
# Mode: Plan
Planning content

## Subsection
More content

Final paragraph
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toContain("Planning content");
      expect(result).toContain("## Subsection");
      expect(result).toContain("More content");
      expect(result).toContain("Final paragraph");
    });
  });

  describe("first match wins", () => {
    it("should return only first matching section", () => {
      const markdown = `
# Mode: Plan
First plan section

# Other Section
Other content

# Mode: Plan
Second plan section (should be ignored)
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toBe("First plan section");
      expect(result).not.toContain("Second plan section");
    });
  });

  describe("different modes", () => {
    it("should extract exec mode section", () => {
      const markdown = `
# Mode: Plan
Plan content

# Mode: Exec
Exec content

# Mode: Review
Review content
`.trim();

      const result = extractModeSection(markdown, "exec");
      expect(result).toBe("Exec content");
    });

    it("should handle custom mode names", () => {
      const markdown = "# Mode: Custom-Mode-Name\nCustom content";
      const result = extractModeSection(markdown, "custom-mode-name");
      expect(result).toBe("Custom content");
    });
  });

  describe("edge cases", () => {
    it("should trim whitespace from extracted content", () => {
      const markdown = `
# Mode: Plan


Planning content with blank lines


# Next Section
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toBe("Planning content with blank lines");
    });

    it("should return null for section with only whitespace", () => {
      const markdown = `
# Mode: Plan


# Next Section
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toBeNull();
    });

    it("should handle sections with code blocks", () => {
      const markdown = `
# Mode: Plan
Use this pattern:

\`\`\`typescript
const x = 1;
\`\`\`

# Next
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toContain("Use this pattern:");
      expect(result).toContain("```typescript");
      expect(result).toContain("const x = 1;");
    });

    it("should handle sections with lists", () => {
      const markdown = `
# Mode: Plan
- Item 1
- Item 2
  - Nested item

# Next
`.trim();

      const result = extractModeSection(markdown, "plan");
      expect(result).toContain("- Item 1");
      expect(result).toContain("- Item 2");
      expect(result).toContain("- Nested item");
    });
  });
});
