import { describe, expect, it } from "bun:test";
import { WORKSPACE_NAME_MAX_LENGTH } from "@/constants/workspaceNaming";
import { buildWorkspaceNameWithSuffix } from "./workspaceNaming";

describe("workspaceNaming", () => {
  it("should append suffix without truncation when base fits", () => {
    expect(buildWorkspaceNameWithSuffix("short-name", 2)).toBe("short-name-2");
  });

  it("should truncate base to respect maximum length", () => {
    const base = "a".repeat(WORKSPACE_NAME_MAX_LENGTH);
    const result = buildWorkspaceNameWithSuffix(base, 2);
    expect(result.length).toBe(WORKSPACE_NAME_MAX_LENGTH);
    expect(result.endsWith("-2")).toBe(true);
  });
});
