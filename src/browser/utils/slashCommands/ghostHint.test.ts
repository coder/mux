import { describe, expect, it } from "bun:test";
import { SLASH_COMMAND_HINTS } from "@/common/constants/slashCommandHints";
import { getCommandGhostHint } from "./registry";

describe("getCommandGhostHint", () => {
  it("returns inputHint for a command with trailing space and no args", () => {
    expect(getCommandGhostHint("/compact ", false)).toBe(SLASH_COMMAND_HINTS.compact);
  });

  it("returns null once arguments are present", () => {
    expect(getCommandGhostHint("/compact -t 100", false)).toBeNull();
  });

  it("returns null for partial commands", () => {
    expect(getCommandGhostHint("/comp", false)).toBeNull();
  });

  it("returns null for commands without an input hint", () => {
    expect(getCommandGhostHint("/clear ", false)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(getCommandGhostHint("", false)).toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(getCommandGhostHint("/nonexistent ", false)).toBeNull();
  });

  it("returns null while command suggestions are visible", () => {
    expect(getCommandGhostHint("/compact ", true)).toBeNull();
  });
});
