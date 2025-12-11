import { getPlanFilePath, getLegacyPlanFilePath } from "./planStorage";

describe("planStorage", () => {
  // Plan paths use tilde prefix for portability across local/remote runtimes
  const expectedMuxHome = "~/.mux";

  describe("getPlanFilePath", () => {
    it("should return path with project name and workspace name", () => {
      const result = getPlanFilePath("fix-plan-a1b2", "mux");
      expect(result).toBe(`${expectedMuxHome}/plans/mux/fix-plan-a1b2.md`);
    });

    it("should produce same path for same inputs", () => {
      const result1 = getPlanFilePath("fix-bug-x1y2", "myproject");
      const result2 = getPlanFilePath("fix-bug-x1y2", "myproject");
      expect(result1).toBe(result2);
    });

    it("should organize plans by project folder", () => {
      const result1 = getPlanFilePath("sidebar-a1b2", "mux");
      const result2 = getPlanFilePath("auth-c3d4", "other-project");
      expect(result1).toBe(`${expectedMuxHome}/plans/mux/sidebar-a1b2.md`);
      expect(result2).toBe(`${expectedMuxHome}/plans/other-project/auth-c3d4.md`);
    });
  });

  describe("getLegacyPlanFilePath", () => {
    it("should return path with workspace ID", () => {
      const result = getLegacyPlanFilePath("a1b2c3d4e5");
      expect(result).toBe(`${expectedMuxHome}/plans/a1b2c3d4e5.md`);
    });

    it("should handle legacy format IDs", () => {
      const result = getLegacyPlanFilePath("mux-main");
      expect(result).toBe(`${expectedMuxHome}/plans/mux-main.md`);
    });
  });
});
