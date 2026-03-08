import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { Config } from "@/node/config";
import type { WorkspaceMetadata } from "@/common/types/workspace";

import {
  buildFlowPromptUpdateMessage,
  getFlowPromptPollIntervalMs,
  WorkspaceFlowPromptService,
} from "./workspaceFlowPromptService";

describe("getFlowPromptPollIntervalMs", () => {
  const nowMs = new Date("2026-03-08T00:00:00.000Z").getTime();

  it("polls the selected workspace every second", () => {
    expect(
      getFlowPromptPollIntervalMs({
        hasActiveChatSubscription: true,
        lastRelevantUsageAtMs: null,
        nowMs,
      })
    ).toBe(1_000);
  });

  it("polls recently used background workspaces every 10 seconds", () => {
    expect(
      getFlowPromptPollIntervalMs({
        hasActiveChatSubscription: false,
        lastRelevantUsageAtMs: nowMs - 6 * 60 * 60 * 1_000,
        nowMs,
      })
    ).toBe(10_000);
  });

  it("stops polling background workspaces after 24 hours of inactivity", () => {
    expect(
      getFlowPromptPollIntervalMs({
        hasActiveChatSubscription: false,
        lastRelevantUsageAtMs: nowMs - 24 * 60 * 60 * 1_000 - 1,
        nowMs,
      })
    ).toBeNull();
  });
});

describe("WorkspaceFlowPromptService.renamePromptFile", () => {
  function createMetadata(params: {
    projectPath: string;
    name: string;
    srcBaseDir: string;
    projectName?: string;
  }): WorkspaceMetadata {
    return {
      id: "workspace-1",
      name: params.name,
      projectName: params.projectName ?? path.basename(params.projectPath),
      projectPath: params.projectPath,
      runtimeConfig: {
        type: "worktree",
        srcBaseDir: params.srcBaseDir,
      },
    };
  }

  test("moves an existing prompt from the renamed workspace directory to the new filename", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "flow-prompt-rename-"));
    const sessionsDir = path.join(tempDir, "sessions");
    const srcBaseDir = path.join(tempDir, "src");
    const projectPath = path.join(tempDir, "projects", "repo");
    const oldMetadata = createMetadata({ projectPath, name: "old-name", srcBaseDir });
    const newMetadata = createMetadata({ projectPath, name: "new-name", srcBaseDir });
    const newWorkspacePath = path.join(srcBaseDir, "repo", "new-name");
    const oldPromptPathAfterWorkspaceRename = path.join(
      newWorkspacePath,
      ".mux/prompts/old-name.md"
    );
    const newPromptPath = path.join(newWorkspacePath, ".mux/prompts/new-name.md");

    await fsPromises.mkdir(path.dirname(oldPromptPathAfterWorkspaceRename), { recursive: true });
    await fsPromises.writeFile(
      oldPromptPathAfterWorkspaceRename,
      "Persist flow prompt across rename",
      "utf8"
    );

    const mockConfig = {
      getAllWorkspaceMetadata: () => Promise.resolve([newMetadata]),
      getSessionDir: () => path.join(sessionsDir, oldMetadata.id),
    } as unknown as Config;

    const service = new WorkspaceFlowPromptService(mockConfig);

    try {
      await service.renamePromptFile(oldMetadata.id, oldMetadata, newMetadata);

      expect(await fsPromises.readFile(newPromptPath, "utf8")).toBe(
        "Persist flow prompt across rename"
      );
      await expect(fsPromises.access(oldPromptPathAfterWorkspaceRename)).rejects.toThrow();
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildFlowPromptUpdateMessage", () => {
  const flowPromptPath = "/tmp/workspace/.mux/prompts/feature-branch.md";

  it("sends a full prompt snapshot for newly populated prompts", () => {
    const message = buildFlowPromptUpdateMessage({
      path: flowPromptPath,
      previousContent: "",
      nextContent: "Implement the UI and keep tests green.",
    });

    expect(message).toContain("Flow prompt file path:");
    expect(message).toContain("Current flow prompt contents:");
    expect(message).toContain("Implement the UI and keep tests green.");
  });

  it("sends a diff when a prior prompt already existed", () => {
    const previousContent = Array.from(
      { length: 40 },
      (_, index) => `Context line ${index + 1}`
    ).join("\n");
    const nextContent = previousContent.replace("Context line 20", "Updated context line 20");
    const message = buildFlowPromptUpdateMessage({
      path: flowPromptPath,
      previousContent,
      nextContent,
    });

    expect(message).toContain("Latest flow prompt changes:");
    expect(message).toContain("```diff");
    expect(message).toContain("Updated context line 20");
  });

  it("tells the model when the prompt file is cleared", () => {
    const message = buildFlowPromptUpdateMessage({
      path: flowPromptPath,
      previousContent: "Keep working on the refactor.",
      nextContent: "   ",
    });

    expect(message).toContain("flow prompt file is now empty");
    expect(message).toContain(flowPromptPath);
  });
});
