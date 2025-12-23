import { describe, expect, test } from "bun:test";

import {
  AgentDefinitionParseError,
  parseAgentDefinitionMarkdown,
} from "./parseAgentDefinitionMarkdown";

describe("parseAgentDefinitionMarkdown", () => {
  test("parses valid YAML frontmatter and body", () => {
    const content = `---
name: My Agent
description: Does stuff
ui:
  selectable: true
policy:
  base: exec
---
# Instructions
Do the thing.
`;

    const result = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
    });

    expect(result.frontmatter.name).toBe("My Agent");
    expect(result.frontmatter.description).toBe("Does stuff");
    expect(result.frontmatter.ui?.selectable).toBe(true);
    expect(result.frontmatter.policy?.base).toBe("exec");
    expect(result.body).toContain("# Instructions");
  });

  test("throws on missing frontmatter", () => {
    expect(() =>
      parseAgentDefinitionMarkdown({
        content: "# No frontmatter\n",
        byteSize: 14,
      })
    ).toThrow(AgentDefinitionParseError);
  });

  test("throws when policy.tools specifies both deny and only", () => {
    const content = `---
name: Bad Agent
policy:
  base: exec
  tools:
    deny: ["file_read"]
    only: ["bash"]
---
Body
`;

    expect(() =>
      parseAgentDefinitionMarkdown({
        content,
        byteSize: Buffer.byteLength(content, "utf-8"),
      })
    ).toThrow(AgentDefinitionParseError);
  });
});
