/**
 * Tests to ensure multiline support doesn't break other commands
 */
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { parseCommand } from "./parser";

describe("parser multiline compatibility", () => {
  it("allows /compact with multiline follow-up", () => {
    const result = parseCommand("/compact\nContinue here");
    expect(result).toEqual({
      type: "compact",
      maxOutputTokens: undefined,
      continueMessage: "Continue here",
      model: undefined,
    });
  });

  it("allows /model with newlines", () => {
    const result = parseCommand("/model\nopus");
    expect(result).toEqual({
      type: "model-set",
      modelString: KNOWN_MODELS.OPUS.id,
    });
  });

  it("allows /truncate with newlines", () => {
    const result = parseCommand("/truncate\n50");
    expect(result).toEqual({
      type: "truncate",
      percentage: 0.5,
    });
  });
});
