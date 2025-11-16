import { parseCommand } from "./parser";

describe("/fork command", () => {
  it("should parse /fork without arguments to show help", () => {
    const result = parseCommand("/fork");
    expect(result).toEqual({
      type: "fork-help",
    });
  });

  it("should parse /fork with new name", () => {
    const result = parseCommand("/fork new-workspace");
    expect(result).toEqual({
      type: "fork",
      newName: "new-workspace",
      startMessage: undefined,
    });
  });

  it("should parse /fork with name and start message on same line", () => {
    const result = parseCommand("/fork new-workspace Continue with feature X");
    expect(result).toEqual({
      type: "fork",
      newName: "new-workspace",
      startMessage: "Continue with feature X",
    });
  });

  it("should parse /fork with name and multiline start message", () => {
    const result = parseCommand("/fork new-workspace\nContinue with feature X");
    expect(result).toEqual({
      type: "fork",
      newName: "new-workspace",
      startMessage: "Continue with feature X",
    });
  });

  it("should prefer multiline content over same-line tokens", () => {
    const result = parseCommand("/fork new-workspace same line\nMultiline content");
    expect(result).toEqual({
      type: "fork",
      newName: "new-workspace",
      startMessage: "Multiline content",
    });
  });

  it("should handle quoted workspace names", () => {
    const result = parseCommand('/fork "my workspace"');
    expect(result).toEqual({
      type: "fork",
      newName: "my workspace",
      startMessage: undefined,
    });
  });

  it("should handle multiline messages with multiple lines", () => {
    const result = parseCommand("/fork new-workspace\nLine 1\nLine 2\nLine 3");
    expect(result).toEqual({
      type: "fork",
      newName: "new-workspace",
      startMessage: "Line 1\nLine 2\nLine 3",
    });
  });
});
