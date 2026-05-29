import { parseCommand } from "./parser";

describe("/fork command", () => {
  it("should parse /fork without arguments (seamless fork)", () => {
    const result = parseCommand("/fork");
    expect(result).toEqual({
      type: "fork",
    });
  });

  it("should parse /fork with start message", () => {
    const result = parseCommand("/fork Continue with feature X");
    expect(result).toEqual({
      type: "fork",
      startMessage: "Continue with feature X",
    });
  });

  it("should treat all text after /fork as start message", () => {
    const result = parseCommand("/fork new-workspace same line content");
    expect(result).toEqual({
      type: "fork",
      startMessage: "new-workspace same line content",
    });
  });

  it("should handle /fork with trailing whitespace", () => {
    const result = parseCommand("/fork   ");
    expect(result).toEqual({
      type: "fork",
    });
  });
});
