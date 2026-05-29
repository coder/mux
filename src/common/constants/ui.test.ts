import { describe, expect, it } from "bun:test";

import { DEFAULT_SECTION_COLOR, resolveSectionColor } from "./ui";

describe("resolveSectionColor", () => {
  it("returns default for empty/undefined", () => {
    expect(resolveSectionColor(undefined)).toBe(DEFAULT_SECTION_COLOR);
    expect(resolveSectionColor(null)).toBe(DEFAULT_SECTION_COLOR);
    expect(resolveSectionColor("")).toBe(DEFAULT_SECTION_COLOR);
    expect(resolveSectionColor("   ")).toBe(DEFAULT_SECTION_COLOR);
  });

  it("resolves palette names (case-insensitive)", () => {
    expect(resolveSectionColor("Blue")).toBe("#5a9bd4");
    expect(resolveSectionColor("blue")).toBe("#5a9bd4");
  });

  it("normalizes hex colors", () => {
    expect(resolveSectionColor("#ABC")).toBe("#aabbcc");
    expect(resolveSectionColor("#AABBCC")).toBe("#aabbcc");
    expect(resolveSectionColor("#AABBCCDD")).toBe("#aabbcc");
  });

  it("falls back to default for invalid values", () => {
    expect(resolveSectionColor("not-a-color")).toBe(DEFAULT_SECTION_COLOR);
  });
});
