import { describe, test, expect } from "bun:test";
import { ProjectConfigSchema } from "./project";

describe("ProjectConfigSchema - trusted field", () => {
  test("parses trusted: true", () => {
    const result = ProjectConfigSchema.parse({
      workspaces: [],
      trusted: true,
    });
    expect(result.trusted).toBe(true);
  });

  test("parses trusted: false", () => {
    const result = ProjectConfigSchema.parse({
      workspaces: [],
      trusted: false,
    });
    expect(result.trusted).toBe(false);
  });

  test("trusted defaults to undefined when omitted", () => {
    const result = ProjectConfigSchema.parse({
      workspaces: [],
    });
    expect(result.trusted).toBeUndefined();
  });
});

describe("ProjectConfigSchema - project entity fields", () => {
  test("parses project identity, prompt, and working directories", () => {
    const result = ProjectConfigSchema.parse({
      projectId: "proj_123",
      name: "Mux Project",
      systemPrompt: "Stay concise",
      workingDirectories: [
        {
          id: "wd_backend",
          path: "/tmp/mux/backend",
        },
      ],
      workspaces: [
        {
          path: "/tmp/mux/.worktrees/task-a1b2",
          workingDirectoryIds: ["wd_backend"],
        },
      ],
    });

    expect(result.projectId).toBe("proj_123");
    expect(result.name).toBe("Mux Project");
    expect(result.systemPrompt).toBe("Stay concise");
    expect(result.workingDirectories).toEqual([
      {
        id: "wd_backend",
        path: "/tmp/mux/backend",
      },
    ]);
    expect(result.workspaces[0]?.workingDirectoryIds).toEqual(["wd_backend"]);
  });

  test("keeps legacy project configs valid when fields are omitted", () => {
    const result = ProjectConfigSchema.parse({
      workspaces: [
        {
          path: "/tmp/mux/.worktrees/task-a1b2",
        },
      ],
    });

    expect(result.projectId).toBeUndefined();
    expect(result.name).toBeUndefined();
    expect(result.systemPrompt).toBeUndefined();
    expect(result.workingDirectories).toBeUndefined();
    expect(result.workspaces[0]?.workingDirectoryIds).toBeUndefined();
  });
});
