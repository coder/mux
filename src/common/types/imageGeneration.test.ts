import { describe, expect, test } from "bun:test";

import { normalizeImageGenerationConfig } from "./imageGeneration";

describe("normalizeImageGenerationConfig", () => {
  test("defaults image upload consent off and preserves explicit consent", () => {
    expect(normalizeImageGenerationConfig(undefined).allowImageUploadsForEditing).toBe(false);
    expect(
      normalizeImageGenerationConfig({ allowImageUploadsForEditing: true })
        .allowImageUploadsForEditing
    ).toBe(true);
  });
});
