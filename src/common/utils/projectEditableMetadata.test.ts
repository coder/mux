import { describe, expect, it } from "@jest/globals";
import { buildProjectUpdateEditableMetadataInput } from "./projectEditableMetadata";

describe("projectEditableMetadata", () => {
  it("sends an explicit empty name when clearing a custom project name", () => {
    expect(
      buildProjectUpdateEditableMetadataInput({
        projectPath: "/tmp/repo",
        projectId: " project-id ",
        draft: {
          name: "   ",
          systemPrompt: "   ",
          workingDirectories: [{ path: " /tmp/repo/apps " }, { path: "   " }],
        },
      })
    ).toEqual({
      projectPath: "/tmp/repo",
      projectId: "project-id",
      name: "",
      systemPrompt: null,
      workingDirectories: [{ path: "/tmp/repo/apps" }],
    });
  });
});
