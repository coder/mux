import { parseCommand } from "./parser";

describe("/new command", () => {
  it("should return undefined workspaceName when no arguments provided (opens modal)", () => {
    const result = parseCommand("/new");
    expect(result).toEqual({
      type: "new",
      workspaceName: undefined,
      trunkBranch: undefined,
      startMessage: undefined,
    });
  });

  it("should parse /new with workspace name", () => {
    const result = parseCommand("/new feature-branch");
    expect(result).toEqual({
      type: "new",
      workspaceName: "feature-branch",
      trunkBranch: undefined,
      startMessage: undefined,
    });
  });

  it("should parse /new with workspace name and trunk via -t flag", () => {
    const result = parseCommand("/new feature-branch -t main");
    expect(result).toEqual({
      type: "new",
      workspaceName: "feature-branch",
      trunkBranch: "main",
      startMessage: undefined,
    });
  });

  it("should parse /new with workspace name and start message", () => {
    const result = parseCommand("/new feature-branch\nStart implementing feature X");
    expect(result).toEqual({
      type: "new",
      workspaceName: "feature-branch",
      trunkBranch: undefined,
      startMessage: "Start implementing feature X",
    });
  });

  it("should parse /new with workspace name, trunk via -t, and start message", () => {
    const result = parseCommand("/new feature-branch -t main\nStart implementing feature X");
    expect(result).toEqual({
      type: "new",
      workspaceName: "feature-branch",
      trunkBranch: "main",
      startMessage: "Start implementing feature X",
    });
  });

  it("should handle multiline start messages", () => {
    const result = parseCommand("/new feature-branch\nLine 1\nLine 2\nLine 3");
    expect(result).toEqual({
      type: "new",
      workspaceName: "feature-branch",
      trunkBranch: undefined,
      startMessage: "Line 1\nLine 2\nLine 3",
    });
  });

  it("should return undefined workspaceName for extra positional arguments (opens modal)", () => {
    const result = parseCommand("/new feature-branch extra");
    expect(result).toEqual({
      type: "new",
      workspaceName: undefined,
      trunkBranch: undefined,
      startMessage: undefined,
    });
  });

  it("should handle quoted workspace names", () => {
    const result = parseCommand('/new "my feature"');
    expect(result).toEqual({
      type: "new",
      workspaceName: "my feature",
      trunkBranch: undefined,
      startMessage: undefined,
    });
  });

  it("should return undefined workspaceName for unknown flags (opens modal)", () => {
    const result = parseCommand("/new feature-branch -x invalid");
    expect(result).toEqual({
      type: "new",
      workspaceName: undefined,
      trunkBranch: undefined,
      startMessage: undefined,
    });
  });

  it("should handle -t flag with quoted branch name", () => {
    const result = parseCommand('/new feature-branch -t "release/v1.0"');
    expect(result).toEqual({
      type: "new",
      workspaceName: "feature-branch",
      trunkBranch: "release/v1.0",
      startMessage: undefined,
    });
  });

  it("should handle -t flag before workspace name", () => {
    const result = parseCommand("/new -t main feature-branch");
    expect(result).toEqual({
      type: "new",
      workspaceName: "feature-branch",
      trunkBranch: "main",
      startMessage: undefined,
    });
  });
});
