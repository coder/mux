import { extractToolSection, stripScopedInstructionSections } from "./markdown";

describe("extractToolSection", () => {
  describe("basic extraction", () => {
    it("should extract content under Tool: bash heading", () => {
      const markdown = `
# General Instructions
Some general content

# Tool: bash
Use bash conservatively
Prefer single commands

# Other Section
Other content
`.trim();

      const result = extractToolSection(markdown, "bash");
      expect(result).toBe("Use bash conservatively\nPrefer single commands");
    });

    it("should return null when tool section doesn't exist", () => {
      const markdown = `
# General Instructions
Some content

# Other Section
Other content
`.trim();

      const result = extractToolSection(markdown, "bash");
      expect(result).toBeNull();
    });

    it("should return null for empty markdown", () => {
      expect(extractToolSection("", "bash")).toBeNull();
    });

    it("should return null for empty tool name", () => {
      expect(extractToolSection("# Tool: bash\nContent", "")).toBeNull();
    });
  });

  describe("case insensitivity", () => {
    it("should match case-insensitive heading", () => {
      const markdown = "# TOOL: BASH\nContent here";
      const result = extractToolSection(markdown, "bash");
      expect(result).toBe("Content here");
    });

    it("should match mixed case heading", () => {
      const markdown = "# ToOl: BaSh\nContent here";
      const result = extractToolSection(markdown, "bash");
      expect(result).toBe("Content here");
    });

    it("should match with case-insensitive tool name parameter", () => {
      const markdown = "# Tool: bash\nContent here";
      const result = extractToolSection(markdown, "BASH");
      expect(result).toBe("Content here");
    });
  });

  describe("multiple tools", () => {
    it("should extract specific tool section", () => {
      const markdown = `
# Tool: bash
Bash instructions

# Tool: file_read
File read instructions

# Tool: propose_plan
Plan instructions
`.trim();

      expect(extractToolSection(markdown, "bash")).toBe("Bash instructions");
      expect(extractToolSection(markdown, "file_read")).toBe("File read instructions");
      expect(extractToolSection(markdown, "propose_plan")).toBe("Plan instructions");
    });

    it("should return only first matching section", () => {
      const markdown = `
# Tool: bash
First bash section

# Other Section
Other content

# Tool: bash
Second bash section (should be ignored)
`.trim();

      const result = extractToolSection(markdown, "bash");
      expect(result).toBe("First bash section");
      expect(result).not.toContain("Second bash section");
    });
  });

  describe("tool names with underscores", () => {
    it("should handle file_read tool", () => {
      const markdown = "# Tool: file_read\nRead instructions";
      expect(extractToolSection(markdown, "file_read")).toBe("Read instructions");
    });

    it("should handle file_edit_replace_string tool", () => {
      const markdown = "# Tool: file_edit_replace_string\nReplace instructions";
      expect(extractToolSection(markdown, "file_edit_replace_string")).toBe("Replace instructions");
    });
  });
});

describe("stripScopedInstructionSections", () => {
  it("should strip Model sections", () => {
    const markdown = `
# General
General content

# Model: gpt-4
Model-specific content

# More General
More general content
`.trim();

    const result = stripScopedInstructionSections(markdown);
    expect(result).toContain("General content");
    expect(result).toContain("More general content");
    expect(result).not.toContain("Model-specific content");
  });

  it("should strip Tool sections", () => {
    const markdown = `
# General
General content

# Tool: bash
Tool-specific content

# More General
More general content
`.trim();

    const result = stripScopedInstructionSections(markdown);
    expect(result).toContain("General content");
    expect(result).toContain("More general content");
    expect(result).not.toContain("Tool-specific content");
  });

  it("should strip Model and Tool sections together", () => {
    const markdown = `
# General
General content

# Model: gpt-4
Model content

# Tool: bash
Tool content

# More General
More general content
`.trim();

    const result = stripScopedInstructionSections(markdown);
    expect(result).toContain("General content");
    expect(result).toContain("More general content");
    expect(result).not.toContain("Model content");
    expect(result).not.toContain("Tool content");
  });

  it("should NOT strip Agent or Mode sections (no longer scoped)", () => {
    const markdown = `
# General
General content

# Agent: foo
Agent content

# Mode: plan
Mode content

# More General
More general content
`.trim();

    const result = stripScopedInstructionSections(markdown);
    expect(result).toContain("General content");
    expect(result).toContain("More general content");
    expect(result).toContain("Agent content");
    expect(result).toContain("Mode content");
  });

  it("should return empty string for markdown with only scoped sections", () => {
    const markdown = `
# Model: gpt-4
Model content

# Tool: bash
Tool content
`.trim();

    const result = stripScopedInstructionSections(markdown);
    expect(result.trim()).toBe("");
  });

  it("should handle empty markdown", () => {
    expect(stripScopedInstructionSections("")).toBe("");
  });
});
