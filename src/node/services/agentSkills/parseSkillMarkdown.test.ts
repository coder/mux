import { describe, expect, test } from "bun:test";

import { SkillNameSchema } from "@/common/orpc/schemas";
import { AgentSkillParseError, parseSkillMarkdown } from "./parseSkillMarkdown";

describe("parseSkillMarkdown", () => {
  test("parses valid YAML frontmatter and body", () => {
    const content = `---
name: pdf-processing
description: Extract text from PDFs
---
# Instructions
Do the thing.
`;

    const directoryName = SkillNameSchema.parse("pdf-processing");

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName,
    });

    expect(result.frontmatter.name).toBe("pdf-processing");
    expect(result.frontmatter.description).toBe("Extract text from PDFs");
    expect(result.body).toContain("# Instructions");
  });

  test("tolerates unknown frontmatter keys (e.g., allowed-tools)", () => {
    const content = `---
name: foo
description: Hello
allowed-tools: file_read
---
Body
`;

    const directoryName = SkillNameSchema.parse("foo");

    const result = parseSkillMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
      directoryName,
    });

    expect(result.frontmatter.name).toBe("foo");
    expect(result.frontmatter.description).toBe("Hello");
  });

  test("throws on missing frontmatter", () => {
    const content = "# No frontmatter\n";
    expect(() =>
      parseSkillMarkdown({
        content,
        byteSize: Buffer.byteLength(content, "utf-8"),
      })
    ).toThrow(AgentSkillParseError);
  });

  test("throws when frontmatter name does not match directory name", () => {
    const content = `---
name: bar
description: Hello
---
Body
`;

    const directoryName = SkillNameSchema.parse("foo");

    expect(() =>
      parseSkillMarkdown({
        content,
        byteSize: Buffer.byteLength(content, "utf-8"),
        directoryName,
      })
    ).toThrow(AgentSkillParseError);
  });
});
