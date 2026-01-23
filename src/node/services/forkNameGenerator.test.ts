import { describe, expect, it } from "bun:test";
import {
  parseWorkspaceName,
  parseWorkspaceTitle,
  generateForkName,
  generateForkTitle,
  generateForkIdentity,
} from "./forkNameGenerator";

describe("forkNameGenerator", () => {
  describe("parseWorkspaceName", () => {
    it("should return base name with suffix 0 for non-forked names", () => {
      expect(parseWorkspaceName("bugs-asd23")).toEqual({ base: "bugs-asd23", suffix: 0 });
      expect(parseWorkspaceName("sidebar")).toEqual({ base: "sidebar", suffix: 0 });
      expect(parseWorkspaceName("auth-k3m9")).toEqual({ base: "auth-k3m9", suffix: 0 });
    });

    it("should extract suffix >= 2 as fork numbers", () => {
      expect(parseWorkspaceName("bugs-asd23-2")).toEqual({ base: "bugs-asd23", suffix: 2 });
      expect(parseWorkspaceName("bugs-asd23-3")).toEqual({ base: "bugs-asd23", suffix: 3 });
      expect(parseWorkspaceName("bugs-asd23-10")).toEqual({ base: "bugs-asd23", suffix: 10 });
    });

    it("should not treat suffix 1 as a fork number (could be part of original name)", () => {
      expect(parseWorkspaceName("feature-1")).toEqual({ base: "feature-1", suffix: 0 });
    });

    it("should handle names with multiple hyphens", () => {
      expect(parseWorkspaceName("fix-plan-mode-a1b2")).toEqual({
        base: "fix-plan-mode-a1b2",
        suffix: 0,
      });
      expect(parseWorkspaceName("fix-plan-mode-a1b2-5")).toEqual({
        base: "fix-plan-mode-a1b2",
        suffix: 5,
      });
    });
  });

  describe("parseWorkspaceTitle", () => {
    it("should return base title with suffix 0 for non-forked titles", () => {
      expect(parseWorkspaceTitle("Fixing bugs")).toEqual({ base: "Fixing bugs", suffix: 0 });
      expect(parseWorkspaceTitle("Add user auth")).toEqual({ base: "Add user auth", suffix: 0 });
    });

    it("should extract suffix >= 2 as fork numbers", () => {
      expect(parseWorkspaceTitle("Fixing bugs 2")).toEqual({ base: "Fixing bugs", suffix: 2 });
      expect(parseWorkspaceTitle("Fixing bugs 3")).toEqual({ base: "Fixing bugs", suffix: 3 });
      expect(parseWorkspaceTitle("Fixing bugs 10")).toEqual({ base: "Fixing bugs", suffix: 10 });
    });

    it("should not treat suffix 1 as a fork number", () => {
      expect(parseWorkspaceTitle("Version 1")).toEqual({ base: "Version 1", suffix: 0 });
    });

    it("should handle titles with multiple words", () => {
      expect(parseWorkspaceTitle("Fix plan mode over SSH")).toEqual({
        base: "Fix plan mode over SSH",
        suffix: 0,
      });
      expect(parseWorkspaceTitle("Fix plan mode over SSH 5")).toEqual({
        base: "Fix plan mode over SSH",
        suffix: 5,
      });
    });
  });

  describe("generateForkName", () => {
    it("should append -2 for first fork", () => {
      expect(generateForkName("bugs-asd23")).toBe("bugs-asd23-2");
      expect(generateForkName("sidebar")).toBe("sidebar-2");
    });

    it("should increment suffix for subsequent forks", () => {
      expect(generateForkName("bugs-asd23-2")).toBe("bugs-asd23-3");
      expect(generateForkName("bugs-asd23-3")).toBe("bugs-asd23-4");
      expect(generateForkName("bugs-asd23-10")).toBe("bugs-asd23-11");
    });
  });

  describe("generateForkTitle", () => {
    it("should append 2 for first fork", () => {
      expect(generateForkTitle("Fixing bugs")).toBe("Fixing bugs 2");
      expect(generateForkTitle("Add user auth")).toBe("Add user auth 2");
    });

    it("should increment suffix for subsequent forks", () => {
      expect(generateForkTitle("Fixing bugs 2")).toBe("Fixing bugs 3");
      expect(generateForkTitle("Fixing bugs 3")).toBe("Fixing bugs 4");
      expect(generateForkTitle("Fixing bugs 10")).toBe("Fixing bugs 11");
    });
  });

  describe("generateForkIdentity", () => {
    it("should generate both name and title", () => {
      const result = generateForkIdentity("bugs-asd23", "Fixing bugs");
      expect(result).toEqual({
        name: "bugs-asd23-2",
        title: "Fixing bugs 2",
      });
    });

    it("should handle undefined title", () => {
      const result = generateForkIdentity("bugs-asd23", undefined);
      expect(result).toEqual({
        name: "bugs-asd23-2",
        title: undefined,
      });
    });

    it("should increment both correctly for existing forks", () => {
      const result = generateForkIdentity("bugs-asd23-2", "Fixing bugs 2");
      expect(result).toEqual({
        name: "bugs-asd23-3",
        title: "Fixing bugs 3",
      });
    });
  });
});
