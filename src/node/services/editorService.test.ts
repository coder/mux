import { describe, expect, test } from "bun:test";
import type { Config } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { EditorService } from "./editorService";

describe("EditorService", () => {
  test("rejects non-custom editors (renderer must use deep links)", async () => {
    const editorService = new EditorService({} as Config);

    const result = await editorService.openInEditor("ws1", "/tmp", {
      editor: "vscode",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("deep links");
    }
  });

  test("validates custom editor executable exists before spawning", async () => {
    const workspace: FrontendWorkspaceMetadata = {
      id: "ws1",
      name: "ws1",
      projectName: "proj",
      projectPath: "/tmp/proj",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
      namedWorkspacePath: "/tmp/src/proj/ws1",
    };

    const mockConfig: Pick<Config, "getAllWorkspaceMetadata"> = {
      getAllWorkspaceMetadata: () => Promise.resolve([workspace]),
    } as unknown as Pick<Config, "getAllWorkspaceMetadata">;

    const editorService = new EditorService(mockConfig as Config);

    const result = await editorService.openInEditor("ws1", "/tmp", {
      editor: "custom",
      customCommand: "definitely-not-a-command",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Editor command not found");
    }
  });

  test("errors on invalid custom editor command quoting", async () => {
    const workspace: FrontendWorkspaceMetadata = {
      id: "ws1",
      name: "ws1",
      projectName: "proj",
      projectPath: "/tmp/proj",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
      namedWorkspacePath: "/tmp/src/proj/ws1",
    };

    const mockConfig: Pick<Config, "getAllWorkspaceMetadata"> = {
      getAllWorkspaceMetadata: () => Promise.resolve([workspace]),
    } as unknown as Pick<Config, "getAllWorkspaceMetadata">;

    const editorService = new EditorService(mockConfig as Config);

    const result = await editorService.openInEditor("ws1", "/tmp", {
      editor: "custom",
      customCommand: '"unterminated',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid custom editor command");
    }
  });
});
