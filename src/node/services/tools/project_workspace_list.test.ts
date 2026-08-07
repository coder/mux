import { describe, expect, it, mock } from "bun:test";

import type { TaskService } from "@/node/services/taskService";
import { createTestToolConfig, mockToolCallOptions, TestTempDir } from "./testHelpers";
import { createProjectWorkspaceListTool } from "./project_workspace_list";
import { ProjectWorkspaceListToolArgsSchema } from "@/common/utils/tools/toolDefinitions";
import { Ok } from "@/common/types/result";

describe("project_workspace_list tool", () => {
  it("returns canonical same-project workspace summaries in one service call", async () => {
    using tempDir = new TestTempDir("project-workspace-list-tool");
    const listProjectWorkspaces = mock(() =>
      Promise.resolve(
        Ok({
          projectPath: "/project",
          availableProjects: [
            { projectPath: "/project", displayName: "Project", kind: "parent" as const },
            {
              projectPath: "/project/packages/web",
              displayName: "Web",
              kind: "sub_project" as const,
            },
          ],
          workspaces: [
            {
              workspaceId: "canonical-workspace-id",
              name: "feature",
              projectPath: "/project/packages/web",
              projectDisplayName: "Web",
              subProjectPath: "/project/packages/web",
              archived: false,
              createdAt: "2026-08-05T00:00:00.000Z",
              lastActivityAt: "2026-08-06T01:00:00.000Z",
              updatedAt: "2026-08-06T01:00:00.000Z",
              runtimeConfig: { type: "local" as const },
              execAiSettings: {
                model: "openai:gpt-5.6-sol",
                thinkingLevel: "high" as const,
                reasoningMode: "pro" as const,
              },
              workspaceTurn: {
                taskId: "wst_turn",
                status: "running" as const,
                prompt: "Continue implementation",
                createdAt: "2026-08-06T00:00:00.000Z",
                updatedAt: "2026-08-06T00:30:00.000Z",
              },
            },
          ],
        })
      )
    );
    const taskService = { listProjectWorkspaces } as unknown as TaskService;
    const workspaceId = "project-session_aaaaaaaaaa";
    const listTool = createProjectWorkspaceListTool({
      ...createTestToolConfig(tempDir.path, { workspaceId }),
      projectChat: true,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      listTool.execute!(
        { include_archived: true, project_path: "/project/packages/web" },
        mockToolCallOptions
      )
    );

    expect(listProjectWorkspaces).toHaveBeenCalledWith(workspaceId, {
      includeArchived: true,
      projectPath: "/project/packages/web",
    });
    expect(result).toEqual({
      projectPath: "/project",
      availableProjects: [
        { projectPath: "/project", displayName: "Project", kind: "parent" },
        { projectPath: "/project/packages/web", displayName: "Web", kind: "sub_project" },
      ],
      workspaces: [
        {
          workspaceId: "canonical-workspace-id",
          name: "feature",
          projectPath: "/project/packages/web",
          projectDisplayName: "Web",
          subProjectPath: "/project/packages/web",
          archived: false,
          createdAt: "2026-08-05T00:00:00.000Z",
          lastActivityAt: "2026-08-06T01:00:00.000Z",
          updatedAt: "2026-08-06T01:00:00.000Z",
          runtimeConfig: { type: "local" },
          execAiSettings: {
            model: "openai:gpt-5.6-sol",
            thinkingLevel: "high",
            reasoningMode: "pro",
          },
          workspaceTurn: {
            taskId: "wst_turn",
            status: "running",
            prompt: "Continue implementation",
            createdAt: "2026-08-06T00:00:00.000Z",
            updatedAt: "2026-08-06T00:30:00.000Z",
          },
        },
      ],
    });
  });

  it("treats strict-provider null as the documented include-archived default", async () => {
    using tempDir = new TestTempDir("project-workspace-list-null-default");
    const listProjectWorkspaces = mock(() =>
      Promise.resolve(
        Ok({
          projectPath: "/project",
          availableProjects: [
            { projectPath: "/project", displayName: "project", kind: "parent" as const },
          ],
          workspaces: [],
        })
      )
    );
    const workspaceId = "project-session_aaaaaaaaaa";
    const listTool = createProjectWorkspaceListTool({
      ...createTestToolConfig(tempDir.path, { workspaceId }),
      projectChat: true,
      taskService: { listProjectWorkspaces } as unknown as TaskService,
    });

    expect(ProjectWorkspaceListToolArgsSchema.safeParse({ include_archived: null }).success).toBe(
      true
    );
    await Promise.resolve(listTool.execute!({ include_archived: null }, mockToolCallOptions));

    expect(listProjectWorkspaces).toHaveBeenCalledWith(workspaceId, { includeArchived: true });
  });

  it("rejects non-Project-Chat callers", async () => {
    using tempDir = new TestTempDir("project-workspace-list-scope");
    const listTool = createProjectWorkspaceListTool(createTestToolConfig(tempDir.path));

    try {
      await listTool.execute!({}, mockToolCallOptions);
      throw new Error("Expected project_workspace_list to reject a non-Project-Chat caller");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "project_workspace_list is only available in Project Chat"
      );
    }
  });
});
