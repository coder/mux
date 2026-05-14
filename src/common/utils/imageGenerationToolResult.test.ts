import { describe, expect, it } from "bun:test";
import { stripImageToolOutputForModel } from "./imageGenerationToolResult";

describe("stripImageToolOutputForModel", () => {
  it("bounds huge binary-looking failed image tool errors without mutating history objects", () => {
    const hugeBinaryText = `${"\u0000\u0001\ufffd".repeat(20_000)}trailing detail`;
    const output = {
      success: false,
      error: `Image editing failed: Invalid JSON response. Text: ${hugeBinaryText}`,
      setupHint: "Check credentials.",
    };

    const stripped = stripImageToolOutputForModel(output);

    expect(output.error).toContain("trailing detail");
    expect(stripped).toMatchObject({
      success: false,
      setupHint: "Check credentials.",
    });
    if (typeof (stripped as { error?: unknown }).error !== "string") {
      throw new Error("Expected stripped image error to remain a string");
    }
    const strippedError = (stripped as { error: string }).error;
    expect(strippedError).toContain("omitted binary image tool error");
    expect(strippedError.length).toBeLessThan(1_000);
  });

  it("keeps short failed image tool errors readable", () => {
    const output = { success: false, error: "Image edit prompt is required." };

    expect(stripImageToolOutputForModel(output)).toEqual(output);
  });
});
