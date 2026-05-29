import * as path from "path";
import { describe, expect, it, spyOn } from "bun:test";
import { getAtomicWriteTempPath } from "./atomicWriteTempPath";

describe("getAtomicWriteTempPath", () => {
  it("uses distinct temp paths when concurrent writes share a timestamp", () => {
    const nowSpy = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    try {
      const firstPath = getAtomicWriteTempPath("/tmp/file.txt");
      const secondPath = getAtomicWriteTempPath("/tmp/file.txt");

      expect(firstPath).toContain("/tmp/.mux-tmp.");
      expect(firstPath).not.toBe(secondPath);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps temp names short for long target basenames", () => {
    const longPath = `/tmp/${"a".repeat(240)}.txt`;
    const tempPath = getAtomicWriteTempPath(longPath);

    expect(path.dirname(tempPath)).toBe("/tmp");
    expect(path.basename(tempPath)).toMatch(/^\.mux-tmp\./);
    expect(path.basename(tempPath).length).toBeLessThan(48);
    expect(tempPath).not.toContain("a".repeat(240));
  });
});
