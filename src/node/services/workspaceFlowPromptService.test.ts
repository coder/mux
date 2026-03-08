import { afterEach, describe, expect, it, mock, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { Runtime, FileStat, ExecStream } from "@/node/runtime/Runtime";
import type { Config } from "@/node/config";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import * as runtimeHelpers from "@/node/runtime/runtimeHelpers";

import {
  buildFlowPromptUpdateMessage,
  getFlowPromptPollIntervalMs,
  WorkspaceFlowPromptService,
} from "./workspaceFlowPromptService";

afterEach(() => {
  mock.restore();
});

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

      let accessError: unknown = null;
      try {
        await fsPromises.access(oldPromptPathAfterWorkspaceRename);
      } catch (error) {
        accessError = error;
      }
      expect(accessError).toBeTruthy();
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("WorkspaceFlowPromptService runtime error handling", () => {
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

  function createCompletedExecStream(): ExecStream {
    return {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stdin: new WritableStream<Uint8Array>(),
      exitCode: Promise.resolve(0),
      duration: Promise.resolve(0),
    };
  }

  test("deleteFile resolves remote prompt paths before shelling out", async () => {
    const service = new WorkspaceFlowPromptService({
      getSessionDir: () => "/tmp/flow-prompt-session",
    } as unknown as Config);

    let executedCommand = "";
    const runtime = {
      resolvePath: (filePath: string) => Promise.resolve(filePath.replace(/^~\//, "/home/test/")),
      exec: (command: string) => {
        executedCommand = command;
        return Promise.resolve(createCompletedExecStream());
      },
    } as unknown as Runtime;

    const deleteFile = (
      service as unknown as {
        deleteFile: (
          runtime: Runtime,
          runtimeConfig: unknown,
          workspacePath: string,
          filePath: string
        ) => Promise<void>;
      }
    ).deleteFile.bind(service);

    await deleteFile(
      runtime,
      { type: "ssh" },
      "/tmp/workspace",
      "~/.mux/src/repo/.mux/prompts/feature.md"
    );

    expect(executedCommand).toContain("/home/test/.mux/src/repo/.mux/prompts/feature.md");
    expect(executedCommand).not.toContain("~/.mux/src/repo/.mux/prompts/feature.md");
  });

  test("getState rethrows transient prompt read failures instead of treating them as deletion", async () => {
    const metadata = createMetadata({
      projectPath: "/tmp/projects/repo",
      name: "feature-branch",
      srcBaseDir: "/tmp/src",
    });
    const service = new WorkspaceFlowPromptService({
      getAllWorkspaceMetadata: () => Promise.resolve([metadata]),
      getSessionDir: () => "/tmp/flow-prompt-session",
    } as unknown as Config);

    const runtime = {
      getWorkspacePath: () => "/tmp/src/repo/feature-branch",
      stat: (): Promise<FileStat> =>
        Promise.resolve({
          size: 64,
          modifiedTime: new Date("2026-03-08T00:00:00.000Z"),
          isDirectory: false,
        }),
      readFile: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("transient SSH read failure"));
          },
        }),
    } as unknown as Runtime;
    spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue(runtime);

    try {
      await service.getState(metadata.id);
      throw new Error("Expected getState to reject");
    } catch (error) {
      expect(String(error)).toContain("transient SSH read failure");
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
