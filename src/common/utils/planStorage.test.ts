import { getPlanFilePath, getLegacyPlanFilePath } from "./planStorage";

describe("planStorage", () => {
  // Plan paths use tilde prefix for portability across local/remote runtimes
  const expectedShuxHome = "~/.shux";

  describe("getPlanFilePath", () => {
    it("should return path with project name and workspace name", () => {
      const result = getPlanFilePath("fix-plan-a1b2", "shux");
      expect(result).toBe(`${expectedShuxHome}/plans/shux/fix-plan-a1b2.md`);
    });

    it("should produce same path for same inputs", () => {
      const result1 = getPlanFilePath("fix-bug-x1y2", "myproject");
      const result2 = getPlanFilePath("fix-bug-x1y2", "myproject");
      expect(result1).toBe(result2);
    });

    it("should organize plans by project folder", () => {
      const result1 = getPlanFilePath("sidebar-a1b2", "shux");
      const result2 = getPlanFilePath("auth-c3d4", "other-project");
      expect(result1).toBe(`${expectedShuxHome}/plans/shux/sidebar-a1b2.md`);
      expect(result2).toBe(`${expectedShuxHome}/plans/other-project/auth-c3d4.md`);
    });

    it("should use custom shuxHome when provided (Docker uses /var/mux)", () => {
      const result = getPlanFilePath("fix-plan-a1b2", "shux", "/var/mux");
      expect(result).toBe("/var/mux/plans/shux/fix-plan-a1b2.md");
    });

    it("should default to ~/.shux when shuxHome not provided", () => {
      const withDefault = getPlanFilePath("workspace", "project");
      const withExplicit = getPlanFilePath("workspace", "project", "~/.shux");
      expect(withDefault).toBe(withExplicit);
    });
  });

  describe("getLegacyPlanFilePath", () => {
    it("should return local canonical path rooted in ~/.shux", () => {
      const result = getLegacyPlanFilePath("a1b2c3d4e5", expectedShuxHome);
      expect(result).toBe(`${expectedShuxHome}/plans/a1b2c3d4e5.md`);
    });

    it("should handle legacy format IDs under the local canonical home", () => {
      const result = getLegacyPlanFilePath("mux-main", expectedShuxHome);
      expect(result).toBe(`${expectedShuxHome}/plans/mux-main.md`);
    });

    it("should root SSH legacy lookup in ~/.mux, not ~/.shux", () => {
      const result = getLegacyPlanFilePath("a1b2c3d4e5", "~/.mux");
      expect(result).toBe("~/.mux/plans/a1b2c3d4e5.md");
      expect(result).not.toContain("~/.shux");
    });

    it("should root Docker legacy lookup in /var/mux, not ~/.shux", () => {
      const result = getLegacyPlanFilePath("a1b2c3d4e5", "/var/mux");
      expect(result).toBe("/var/mux/plans/a1b2c3d4e5.md");
      expect(result).not.toContain("~/.shux");
    });
  });
});
