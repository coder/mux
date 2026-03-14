import {
  FLOW_PROMPTS_DIR,
  getFlowPromptPathMarkerLine,
  getFlowPromptRelativePath,
} from "./flowPrompting";

describe("flowPrompting constants", () => {
  it("builds the repo-local flow prompt path from the workspace name", () => {
    expect(getFlowPromptRelativePath("feature-branch")).toBe(
      `${FLOW_PROMPTS_DIR}/feature-branch.md`
    );
  });

  it("preserves slash-delimited workspace names so branch segments stay unique", () => {
    expect(getFlowPromptRelativePath("feature/foo")).toBe(`${FLOW_PROMPTS_DIR}/feature/foo.md`);
  });

  it("uses the basename for in-place workspace names that look like absolute POSIX paths", () => {
    expect(getFlowPromptRelativePath("/tmp/projects/repo")).toBe(`${FLOW_PROMPTS_DIR}/repo.md`);
  });

  it("uses the basename for in-place workspace names that look like Windows paths", () => {
    expect(getFlowPromptRelativePath("C:\\Users\\dev\\repo")).toBe(`${FLOW_PROMPTS_DIR}/repo.md`);
  });

  it("includes the exact path marker wording for tool calls", () => {
    const marker = getFlowPromptPathMarkerLine("/tmp/workspace/.mux/prompts/feature-branch.md");

    expect(marker).toContain("Flow prompt file path:");
    expect(marker).toContain("/tmp/workspace/.mux/prompts/feature-branch.md");
    expect(marker).toContain("MUST use this exact path string");
  });
});
