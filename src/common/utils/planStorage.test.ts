import { getPlanFilePath, getLegacyPlanFilePath } from "./planStorage";

describe("planStorage", () => {
  describe("getPlanFilePath", () => {
    it("should return path with project name, hash, and workspace name", () => {
      const result = getPlanFilePath("fix-plan-mode", "mux", "/home/user/mux");
      // Hash of "/home/user/mux" is deterministic
      expect(result).toMatch(/^~\/\.mux\/plans\/mux-[a-f0-9]{6}\/fix-plan-mode\.md$/);
    });

    it("should produce different paths for different project paths with same basename", () => {
      const result1 = getPlanFilePath("main", "mux", "/home/user/work/mux");
      const result2 = getPlanFilePath("main", "mux", "/tmp/mux");
      expect(result1).not.toBe(result2);
      // Both should follow the pattern
      expect(result1).toMatch(/^~\/\.mux\/plans\/mux-[a-f0-9]{6}\/main\.md$/);
      expect(result2).toMatch(/^~\/\.mux\/plans\/mux-[a-f0-9]{6}\/main\.md$/);
    });

    it("should produce same path for same inputs", () => {
      const result1 = getPlanFilePath("fix-bug", "myproject", "/path/to/myproject");
      const result2 = getPlanFilePath("fix-bug", "myproject", "/path/to/myproject");
      expect(result1).toBe(result2);
    });
  });

  describe("getLegacyPlanFilePath", () => {
    it("should return path with workspace ID", () => {
      const result = getLegacyPlanFilePath("a1b2c3d4e5");
      expect(result).toBe("~/.mux/plans/a1b2c3d4e5.md");
    });

    it("should handle legacy format IDs", () => {
      const result = getLegacyPlanFilePath("mux-main");
      expect(result).toBe("~/.mux/plans/mux-main.md");
    });
  });
});
