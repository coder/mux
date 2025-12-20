import { describe, it, expect } from "@jest/globals";
import {
  sortProjectsByOrder,
  reorderProjects,
  normalizeOrder,
  equalOrders,
} from "./projectOrdering";
import type { ProjectConfig } from "@/node/config";

describe("projectOrdering", () => {
  const createProjects = (paths: string[]): Map<string, ProjectConfig> => {
    const map = new Map<string, ProjectConfig>();
    for (const p of paths) {
      map.set(p, { workspaces: [] });
    }
    return map;
  };

  describe("sortProjectsByOrder", () => {
    it("returns lexical order when order array is empty", () => {
      const projects = createProjects(["/a", "/c", "/b"]);
      const result = sortProjectsByOrder(projects, []);
      expect(result.map(([p]) => p)).toEqual(["/a", "/b", "/c"]);
    });

    it("sorts projects according to order array", () => {
      const projects = createProjects(["/a", "/b", "/c"]);
      const result = sortProjectsByOrder(projects, ["/c", "/a", "/b"]);
      expect(result.map(([p]) => p)).toEqual(["/c", "/a", "/b"]);
    });

    it("puts unknown projects at the end in natural order", () => {
      const projects = createProjects(["/a", "/b", "/c", "/d"]);
      const result = sortProjectsByOrder(projects, ["/c", "/a"]);
      // /c and /a are ordered, /b and /d are unknown and should appear in natural order
      expect(result.map(([p]) => p)).toEqual(["/c", "/a", "/b", "/d"]);
    });
  });

  describe("reorderProjects", () => {
    it("moves dragged project to target position", () => {
      const projects = createProjects(["/a", "/b", "/c", "/d"]);
      const currentOrder = ["/a", "/b", "/c", "/d"];
      // Drag /d onto /b (move /d to position 1)
      const result = reorderProjects(currentOrder, projects, "/d", "/b");
      expect(result).toEqual(["/a", "/d", "/b", "/c"]);
    });

    it("returns current order if dragged or target not found", () => {
      const projects = createProjects(["/a", "/b", "/c"]);
      const currentOrder = ["/a", "/b", "/c"];
      const result = reorderProjects(currentOrder, projects, "/x", "/b");
      expect(result).toEqual(["/a", "/b", "/c"]);
    });

    it("returns current order if dragged === target", () => {
      const projects = createProjects(["/a", "/b", "/c"]);
      const currentOrder = ["/a", "/b", "/c"];
      const result = reorderProjects(currentOrder, projects, "/b", "/b");
      expect(result).toEqual(["/a", "/b", "/c"]);
    });
  });

  describe("normalizeOrder", () => {
    it("removes paths that no longer exist", () => {
      const projects = createProjects(["/a", "/b"]);
      const order = ["/a", "/b", "/c", "/d"];
      const result = normalizeOrder(order, projects);
      expect(result).toEqual(["/a", "/b"]);
    });

    it("prepends new projects to the front in lexical order", () => {
      const projects = createProjects(["/a", "/b", "/c", "/d"]);
      const order = ["/b", "/a"];
      const result = normalizeOrder(order, projects);
      // /c and /d are missing from order, prepended in lexical order
      expect(result).toEqual(["/c", "/d", "/b", "/a"]);
    });

    it("sorts missing projects lexically for deterministic order", () => {
      // Even if Map iteration order is non-lexical, missing projects should be sorted
      const projects = new Map<string, ProjectConfig>([
        ["/z-project", { workspaces: [] }],
        ["/a-project", { workspaces: [] }],
        ["/m-project", { workspaces: [] }],
      ]);
      const order: string[] = []; // empty order, all projects are "missing"
      const result = normalizeOrder(order, projects);
      // Should be lexically sorted regardless of Map insertion order
      expect(result).toEqual(["/a-project", "/m-project", "/z-project"]);
    });

    it("preserves order of existing projects", () => {
      const projects = createProjects(["/a", "/b", "/c"]);
      const order = ["/c", "/a", "/b"];
      const result = normalizeOrder(order, projects);
      expect(result).toEqual(["/c", "/a", "/b"]);
    });
  });

  describe("equalOrders", () => {
    it("returns true for identical arrays", () => {
      const a = ["/a", "/b", "/c"];
      const b = ["/a", "/b", "/c"];
      expect(equalOrders(a, b)).toBe(true);
    });

    it("returns false for arrays with different lengths", () => {
      const a = ["/a", "/b"];
      const b = ["/a", "/b", "/c"];
      expect(equalOrders(a, b)).toBe(false);
    });

    it("returns false for arrays with different order", () => {
      const a = ["/a", "/b", "/c"];
      const b = ["/a", "/c", "/b"];
      expect(equalOrders(a, b)).toBe(false);
    });

    it("returns true for same reference", () => {
      const a = ["/a", "/b", "/c"];
      expect(equalOrders(a, a)).toBe(true);
    });
  });

  describe("Bug fix: empty projects Map on initial load", () => {
    it("returns empty array when projects Map is empty", () => {
      // This documents the bug scenario:
      // 1. localStorage has projectOrder = ["/a", "/b", "/c"]
      // 2. Projects haven't loaded yet, so projects = new Map()
      // 3. If normalization runs, it would clear the order
      const emptyProjects = createProjects([]);
      const order = ["/a", "/b", "/c"];
      const result = normalizeOrder(order, emptyProjects);

      // normalizeOrder returns [] when projects is empty
      expect(result).toEqual([]);

      // Fix: ProjectSidebar.tsx skips normalization when projects.size === 0
      // This prevents clearing the order during initial component mount
    });

    it("normalizes correctly after projects load", () => {
      // After projects load, normalization should work normally:
      // 1. projectOrder is still ["/a", "/b", "/c"] from localStorage
      // 2. Projects are now loaded with an additional project ["/d"]
      // 3. Normalization should treat the new project as "most recent" and put it first
      const projectOrder = ["/a", "/b", "/c"];
      const loadedProjects = createProjects(["/a", "/b", "/c", "/d"]);

      const result = normalizeOrder(projectOrder, loadedProjects);

      expect(result).toEqual(["/d", "/a", "/b", "/c"]);
    });
  });
});
