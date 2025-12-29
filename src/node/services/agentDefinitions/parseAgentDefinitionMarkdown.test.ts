import { describe, expect, test } from "bun:test";

import {
  AgentDefinitionParseError,
  parseAgentDefinitionMarkdown,
} from "./parseAgentDefinitionMarkdown";

describe("parseAgentDefinitionMarkdown", () => {
  test("parses valid YAML frontmatter and body (ignores unknown keys)", () => {
    const content = `---
name: My Agent
description: Does stuff
color: "#ff00ff"
permissionMode: readOnly
tools: ["Read"]
unknownTopLevel: 123
ui:
  hidden: false
  unknownNested: 456
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
    expect(result.frontmatter.color).toBe("#ff00ff");
    expect(result.frontmatter.permissionMode).toBe("readOnly");
    expect(result.frontmatter.tools).toEqual(["Read"]);
    expect(result.frontmatter.ui?.hidden).toBe(false);
    expect(result.frontmatter.policy?.base).toBe("exec");

    const frontmatterUnknown = result.frontmatter as unknown as Record<string, unknown>;
    expect(frontmatterUnknown.unknownTopLevel).toBeUndefined();

    if (!result.frontmatter.ui) {
      throw new Error("Expected ui to be present");
    }
    const uiUnknown = result.frontmatter.ui as unknown as Record<string, unknown>;
    expect(uiUnknown.unknownNested).toBeUndefined();

    expect(result.body).toContain("# Instructions");
  });

  test("accepts legacy ui.selectable", () => {
    const content = `---
name: Legacy UI
ui:
  selectable: false
policy:
  base: exec
---
Body
`;

    const result = parseAgentDefinitionMarkdown({
      content,
      byteSize: Buffer.byteLength(content, "utf-8"),
    });

    expect(result.frontmatter.ui?.selectable).toBe(false);
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
