import { describe, expect, it } from "bun:test";

import { ProjectRefSchema, WorkspaceMetadataSchema } from "@/common/orpc/schemas/workspace";
import type { WorkspaceMetadata } from "@/common/types/workspace";

import { getProjects, isMultiProject } from "./multiProject";

function makeMetadata(overrides: Partial<WorkspaceMetadata> = {}): WorkspaceMetadata {
  return WorkspaceMetadataSchema.parse({
    id: "workspace-1",
    name: "feature-branch",
    projectPath: "/tmp/project",
    projectName: "project",
    runtimeConfig: { type: "local" },
    ...overrides,
  });
}

describe("multiProject helpers", () => {
  describe("isMultiProject", () => {
    it("returns false when projects is undefined", () => {
      expect(isMultiProject(makeMetadata())).toBe(false);
    });

    it("returns false when projects contains one project", () => {
      expect(
        isMultiProject(
          makeMetadata({
            projects: [{ projectPath: "/tmp/project", projectName: "project" }],
          })
        )
      ).toBe(false);
    });

    it("returns true when projects contains two projects", () => {
      expect(
        isMultiProject(
          makeMetadata({
            projects: [
              { projectPath: "/tmp/project-a", projectName: "project-a" },
              { projectPath: "/tmp/project-b", projectName: "project-b" },
            ],
          })
        )
      ).toBe(true);
    });
  });

  describe("getProjects", () => {
    it("returns primary project as singleton when projects is undefined", () => {
      expect(getProjects(makeMetadata())).toEqual([
        { projectPath: "/tmp/project", projectName: "project" },
      ]);
    });

    it("returns projects array when projects is set", () => {
      const projects = [
        { projectPath: "/tmp/project-a", projectName: "project-a" },
        { projectPath: "/tmp/project-b", projectName: "project-b" },
      ];

      expect(getProjects(makeMetadata({ projects }))).toEqual(projects);
    });
  });

  describe("ProjectRefSchema", () => {
    it("accepts a valid project ref", () => {
      expect(
        ProjectRefSchema.safeParse({
          projectPath: "/tmp/project",
          projectName: "project",
        }).success
      ).toBe(true);
    });

    it("rejects a project ref missing projectPath", () => {
      expect(
        ProjectRefSchema.safeParse({
          projectName: "project",
        }).success
      ).toBe(false);
    });
  });

  describe("WorkspaceMetadataSchema", () => {
    it("accepts metadata without projects for backward compatibility", () => {
      expect(WorkspaceMetadataSchema.safeParse(makeMetadata()).success).toBe(true);
    });

    it("accepts metadata with projects", () => {
      expect(
        WorkspaceMetadataSchema.safeParse(
          makeMetadata({
            projects: [
              { projectPath: "/tmp/project-a", projectName: "project-a" },
              { projectPath: "/tmp/project-b", projectName: "project-b" },
            ],
          })
        ).success
      ).toBe(true);
    });
  });
});
