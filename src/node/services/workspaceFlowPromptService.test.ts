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

  test("renamePromptFile rethrows target write failures instead of treating them as missing prompts", async () => {
    const oldMetadata = createMetadata({
      projectPath: "/tmp/projects/repo",
      name: "old-name",
      srcBaseDir: "/tmp/src",
    });
    const newMetadata = createMetadata({
      projectPath: "/tmp/projects/repo",
      name: "new-name",
      srcBaseDir: "/tmp/src",
    });
    const service = new WorkspaceFlowPromptService({
      getSessionDir: () => "/tmp/flow-prompt-session",
    } as unknown as Config);

    const runtime = {
      getWorkspacePath: (_projectPath: string, workspaceName: string) =>
        `/tmp/src/repo/${workspaceName}`,
      readFile: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("Persist this flow prompt"));
            controller.close();
          },
        }),
      writeFile: () =>
        new WritableStream<Uint8Array>({
          write() {
            throw new Error("disk full");
          },
        }),
    } as unknown as Runtime;
    spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue(runtime);

    try {
      await service.renamePromptFile(oldMetadata.id, oldMetadata, newMetadata);
      throw new Error("Expected renamePromptFile to reject");
    } catch (error) {
      expect(String(error)).toContain("disk full");
    }
  });

  test("copyPromptFile rethrows target write failures instead of treating them as missing prompts", async () => {
    const sourceMetadata = createMetadata({
      projectPath: "/tmp/projects/repo",
      name: "source-name",
      srcBaseDir: "/tmp/src",
    });
    const targetMetadata = createMetadata({
      projectPath: "/tmp/projects/repo",
      name: "target-name",
      srcBaseDir: "/tmp/src",
    });
    const service = new WorkspaceFlowPromptService({
      getSessionDir: () => "/tmp/flow-prompt-session",
    } as unknown as Config);

    const runtime = {
      getWorkspacePath: (_projectPath: string, workspaceName: string) =>
        `/tmp/src/repo/${workspaceName}`,
      readFile: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("Persist this flow prompt"));
            controller.close();
          },
        }),
      writeFile: () =>
        new WritableStream<Uint8Array>({
          write() {
            throw new Error("disk full");
          },
        }),
    } as unknown as Runtime;
    spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue(runtime);

    try {
      await service.copyPromptFile(sourceMetadata, targetMetadata);
      throw new Error("Expected copyPromptFile to reject");
    } catch (error) {
      expect(String(error)).toContain("disk full");
    }
  });

  test("ensurePromptFile rethrows transient stat failures instead of overwriting the prompt", async () => {
    const metadata = createMetadata({
      projectPath: "/tmp/projects/repo",
      name: "feature-branch",
      srcBaseDir: "/tmp/src",
    });
    const service = new WorkspaceFlowPromptService({
      getAllWorkspaceMetadata: () => Promise.resolve([metadata]),
      getSessionDir: () => "/tmp/flow-prompt-session",
    } as unknown as Config);

    let wrotePrompt = false;
    const runtime = {
      getWorkspacePath: () => "/tmp/src/repo/feature-branch",
      ensureDir: () => Promise.resolve(),
      stat: () => Promise.reject(new Error("permission denied")),
      writeFile: () => {
        wrotePrompt = true;
        return new WritableStream<Uint8Array>();
      },
    } as unknown as Runtime;
    spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue(runtime);

    try {
      await service.ensurePromptFile(metadata.id);
      throw new Error("Expected ensurePromptFile to reject");
    } catch (error) {
      expect(String(error)).toContain("permission denied");
    }
    expect(wrotePrompt).toBe(false);
  });

  test("getState does not treat BusyBox-style permission errors as missing files", async () => {
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
            controller.error(
              new Error(
                "cat: can't open '/tmp/src/repo/feature-branch/.mux/prompts/feature-branch.md': Permission denied"
              )
            );
          },
        }),
    } as unknown as Runtime;
    spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue(runtime);

    try {
      await service.getState(metadata.id);
      throw new Error("Expected getState to reject");
    } catch (error) {
      expect(String(error)).toContain("Permission denied");
    }
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

test("rememberUpdate prunes superseded queued revisions from memory", () => {
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);
  const workspaceId = "workspace-1";

  const monitors = (
    service as unknown as {
      monitors: Map<string, { pendingFingerprint: string | null }>;
    }
  ).monitors;
  monitors.set(workspaceId, { pendingFingerprint: null });

  service.rememberUpdate(workspaceId, "in-flight", "Persist this accepted revision");
  service.rememberUpdate(workspaceId, "queued-1", "First queued revision");

  const monitor = monitors.get(workspaceId);
  if (!monitor) {
    throw new Error("Expected Flow Prompting monitor to exist");
  }
  monitor.pendingFingerprint = "queued-1";

  service.rememberUpdate(workspaceId, "queued-2", "Latest queued revision");

  const rememberedUpdates = (
    service as unknown as {
      rememberedUpdates: Map<string, Map<string, string>>;
    }
  ).rememberedUpdates;

  expect([...(rememberedUpdates.get(workspaceId)?.entries() ?? [])]).toEqual([
    ["in-flight", "Persist this accepted revision"],
    ["queued-2", "Latest queued revision"],
  ]);
});

test("shouldEmitUpdate skips repeated clear notifications while deletion is pending", () => {
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  const shouldEmitUpdate = (
    service as unknown as {
      shouldEmitUpdate: (
        snapshot: unknown,
        persisted: unknown,
        pendingFingerprint: string | null
      ) => boolean;
    }
  ).shouldEmitUpdate.bind(service);

  expect(
    shouldEmitUpdate(
      {
        workspaceId: "workspace-1",
        path: "/tmp/workspace/.mux/prompts/feature.md",
        exists: false,
        content: "",
        hasNonEmptyContent: false,
        modifiedAtMs: null,
        contentFingerprint: null,
      },
      {
        lastSentContent: "Keep this instruction active.",
        lastSentFingerprint: "previous-fingerprint",
      },
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  ).toBe(false);
});

test("getState waits for an in-flight refresh instead of returning stale state", async () => {
  const workspaceId = "workspace-1";
  const staleState = {
    workspaceId,
    path: "/tmp/workspace/.mux/prompts/feature.md",
    exists: true,
    hasNonEmptyContent: false,
    modifiedAtMs: 1,
    contentFingerprint: "stale-fingerprint",
    lastEnqueuedFingerprint: null,
    isCurrentVersionEnqueued: false,
    hasPendingUpdate: false,
  };
  const freshState = {
    ...staleState,
    hasNonEmptyContent: true,
    modifiedAtMs: 2,
    contentFingerprint: "fresh-fingerprint",
  };
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  const monitors = (
    service as unknown as {
      monitors: Map<
        string,
        {
          timer: null;
          stopped: boolean;
          refreshing: boolean;
          refreshPromise: Promise<typeof freshState> | null;
          pendingFingerprint: string | null;
          lastState: typeof staleState | null;
          activeChatSubscriptions: number;
          lastOpenedAtMs: number | null;
          lastKnownActivityAtMs: number | null;
        }
      >;
    }
  ).monitors;
  monitors.set(workspaceId, {
    timer: null,
    stopped: false,
    refreshing: true,
    refreshPromise: Promise.resolve(freshState),
    pendingFingerprint: null,
    lastState: staleState,
    activeChatSubscriptions: 0,
    lastOpenedAtMs: null,
    lastKnownActivityAtMs: null,
  });

  expect(await service.getState(workspaceId)).toEqual(freshState);
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
