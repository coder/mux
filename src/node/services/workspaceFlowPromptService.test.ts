import { afterEach, describe, expect, it, mock, spyOn, test } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { Runtime, FileStat, ExecStream } from "@/node/runtime/Runtime";
import type { Config } from "@/node/config";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import * as runtimeHelpers from "@/node/runtime/runtimeHelpers";

import {
  buildFlowPromptAttachMessage,
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

  test("ensurePromptFile repairs prompt-path directories into empty files", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "flow-prompt-dir-repair-"));
    const sessionsDir = path.join(tempDir, "sessions");
    const srcBaseDir = path.join(tempDir, "src");
    const metadata = createMetadata({
      projectPath: path.join(tempDir, "projects", "repo"),
      name: "feature-branch",
      srcBaseDir,
    });
    const workspacePath = path.join(srcBaseDir, "repo", metadata.name);
    const promptPath = path.join(workspacePath, ".mux/prompts/feature-branch.md");

    await fsPromises.mkdir(promptPath, { recursive: true });

    const service = new WorkspaceFlowPromptService({
      getAllWorkspaceMetadata: () => Promise.resolve([metadata]),
      getSessionDir: () => path.join(sessionsDir, metadata.id),
    } as unknown as Config);

    try {
      const state = await service.ensurePromptFile(metadata.id);
      expect(state.exists).toBe(true);
      expect(await fsPromises.readFile(promptPath, "utf8")).toBe("");
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
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

describe("WorkspaceFlowPromptService workspace context caching", () => {
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

  test("reuses cached workspace context instead of rescanning all metadata on every refresh", async () => {
    const metadata = createMetadata({
      projectPath: "/tmp/projects/repo",
      name: "feature-branch",
      srcBaseDir: "/tmp/src",
    });
    const getAllWorkspaceMetadata = mock(() => Promise.resolve([metadata]));
    const service = new WorkspaceFlowPromptService({
      getAllWorkspaceMetadata,
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
            controller.enqueue(new TextEncoder().encode("Persist this flow prompt"));
            controller.close();
          },
        }),
    } as unknown as Runtime;
    spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockReturnValue(runtime);

    await service.getState(metadata.id);
    await service.getState(metadata.id);

    expect(getAllWorkspaceMetadata).toHaveBeenCalledTimes(1);
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
        persisted: {
          lastSentContent: string | null;
          lastSentFingerprint: string | null;
          autoSendMode: "off" | "end-of-turn";
        },
        pendingFingerprint: string | null,
        inFlightFingerprint: string | null,
        currentFingerprint: string
      ) => boolean;
    }
  ).shouldEmitUpdate.bind(service);

  expect(
    shouldEmitUpdate(
      {
        lastSentContent: "Keep this instruction active.",
        lastSentFingerprint: "previous-fingerprint",
        autoSendMode: "end-of-turn",
      },
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      null,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  ).toBe(false);
});

test("shouldEmitUpdate respects auto-send being off", () => {
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  const shouldEmitUpdate = (
    service as unknown as {
      shouldEmitUpdate: (
        persisted: {
          lastSentContent: string | null;
          lastSentFingerprint: string | null;
          autoSendMode: "off" | "end-of-turn";
        },
        pendingFingerprint: string | null,
        inFlightFingerprint: string | null,
        currentFingerprint: string
      ) => boolean;
    }
  ).shouldEmitUpdate.bind(service);

  expect(
    shouldEmitUpdate(
      {
        lastSentContent: "Keep this instruction active.",
        lastSentFingerprint: "previous-fingerprint",
        autoSendMode: "off",
      },
      null,
      null,
      "new-fingerprint"
    )
  ).toBe(false);
});

test("shouldEmitUpdate suppresses flow prompt revisions that are already in flight", () => {
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  const shouldEmitUpdate = (
    service as unknown as {
      shouldEmitUpdate: (
        persisted: {
          lastSentContent: string | null;
          lastSentFingerprint: string | null;
          autoSendMode: "off" | "end-of-turn";
        },
        pendingFingerprint: string | null,
        inFlightFingerprint: string | null,
        currentFingerprint: string
      ) => boolean;
    }
  ).shouldEmitUpdate.bind(service);

  expect(
    shouldEmitUpdate(
      {
        lastSentContent: "Keep this instruction active.",
        lastSentFingerprint: "previous-fingerprint",
        autoSendMode: "end-of-turn",
      },
      null,
      "new-fingerprint",
      "new-fingerprint"
    )
  ).toBe(false);
});

test("shouldEmitUpdate suppresses flow prompt revisions that most recently failed to send", () => {
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  const shouldEmitUpdate = (
    service as unknown as {
      shouldEmitUpdate: (
        persisted: {
          lastSentContent: string | null;
          lastSentFingerprint: string | null;
          autoSendMode: "off" | "end-of-turn";
        },
        pendingFingerprint: string | null,
        inFlightFingerprint: string | null,
        failedFingerprint: string | null,
        currentFingerprint: string
      ) => boolean;
    }
  ).shouldEmitUpdate.bind(service);

  expect(
    shouldEmitUpdate(
      {
        lastSentContent: "Keep this instruction active.",
        lastSentFingerprint: "previous-fingerprint",
        autoSendMode: "end-of-turn",
      },
      null,
      null,
      "failed-fingerprint",
      "failed-fingerprint"
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
    autoSendMode: "off" as const,
    nextHeadingContent: null,
    updatePreviewText: null,
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
          queuedRefresh: boolean;
          queuedRefreshEmitEvents: boolean;
          pendingFingerprint: string | null;
          inFlightFingerprint: string | null;
          failedFingerprint: string | null;
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
    queuedRefresh: false,
    queuedRefreshEmitEvents: false,
    pendingFingerprint: null,
    inFlightFingerprint: null,
    failedFingerprint: null,
    lastState: staleState,
    activeChatSubscriptions: 0,
    lastOpenedAtMs: null,
    lastKnownActivityAtMs: null,
  });

  expect(await service.getState(workspaceId)).toEqual(freshState);
});

test("refreshMonitor reruns once when a save lands during an in-flight refresh", async () => {
  const workspaceId = "workspace-1";
  const previousContent = Array.from(
    { length: 40 },
    (_, index) => `Context line ${index + 1}`
  ).join("\n");
  const nextContent = previousContent.replace("Context line 20", "Updated context line 20");
  const staleSnapshot = {
    workspaceId,
    path: "/tmp/workspace/.mux/prompts/feature.md",
    exists: true,
    content: previousContent,
    hasNonEmptyContent: true,
    modifiedAtMs: 1,
    contentFingerprint: "2b025ee42d57e6eaf463f4ed6d7ee0ec2a58d5a1f501ef50b57462d4be4ca0b1",
  };
  const freshSnapshot = {
    ...staleSnapshot,
    content: nextContent,
    modifiedAtMs: 2,
    contentFingerprint: "94326d87717f640c44b44234d652ce38a34c79f5d6cbe2f1bb2ed9042f692e91",
  };
  const staleState = {
    workspaceId,
    path: staleSnapshot.path,
    exists: true,
    hasNonEmptyContent: true,
    modifiedAtMs: staleSnapshot.modifiedAtMs,
    contentFingerprint: staleSnapshot.contentFingerprint,
    lastEnqueuedFingerprint: staleSnapshot.contentFingerprint,
    isCurrentVersionEnqueued: true,
    hasPendingUpdate: false,
    autoSendMode: "off" as const,
    nextHeadingContent: null,
    updatePreviewText: null,
  };
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  let snapshotReads = 0;
  const firstSnapshotGate: {
    resolve: ((snapshot: typeof staleSnapshot) => void) | null;
  } = {
    resolve: null,
  };
  spyOn(
    service as unknown as {
      readPromptSnapshot: (workspaceId: string) => Promise<typeof staleSnapshot>;
    },
    "readPromptSnapshot"
  ).mockImplementation(async () => {
    snapshotReads += 1;
    if (snapshotReads === 1) {
      return await new Promise<typeof staleSnapshot>((resolve) => {
        firstSnapshotGate.resolve = resolve;
      });
    }
    return freshSnapshot;
  });
  spyOn(
    service as unknown as {
      readPersistedState: (workspaceId: string) => Promise<{
        lastSentContent: string | null;
        lastSentFingerprint: string | null;
        autoSendMode: "off" | "end-of-turn";
      }>;
    },
    "readPersistedState"
  ).mockResolvedValue({
    lastSentContent: previousContent,
    lastSentFingerprint: staleSnapshot.contentFingerprint,
    autoSendMode: "off",
  });

  const monitors = (
    service as unknown as {
      monitors: Map<
        string,
        {
          timer: null;
          stopped: boolean;
          refreshing: boolean;
          refreshPromise: Promise<{
            contentFingerprint: string | null;
            updatePreviewText: string | null;
          }> | null;
          queuedRefresh: boolean;
          queuedRefreshEmitEvents: boolean;
          pendingFingerprint: string | null;
          inFlightFingerprint: string | null;
          failedFingerprint: string | null;
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
    refreshing: false,
    refreshPromise: null,
    queuedRefresh: false,
    queuedRefreshEmitEvents: false,
    pendingFingerprint: null,
    inFlightFingerprint: null,
    failedFingerprint: null,
    lastState: staleState,
    activeChatSubscriptions: 0,
    lastOpenedAtMs: null,
    lastKnownActivityAtMs: null,
  });

  const refreshMonitor = (
    service as unknown as {
      refreshMonitor: (
        workspaceId: string,
        emitEvents: boolean
      ) => Promise<{
        contentFingerprint: string | null;
        updatePreviewText: string | null;
      }>;
    }
  ).refreshMonitor.bind(service);

  // Saving while the initial refresh is still reading the file should rerun once so the
  // first saved diff shows up immediately instead of after a second save.
  const firstRefreshPromise = refreshMonitor(workspaceId, true);
  await Promise.resolve();
  const queuedRefreshPromise = refreshMonitor(workspaceId, true);
  if (!firstSnapshotGate.resolve) {
    throw new Error("Expected the first snapshot read to be waiting");
  }
  firstSnapshotGate.resolve(staleSnapshot);

  const refreshedState = await firstRefreshPromise;
  expect(await queuedRefreshPromise).toEqual(refreshedState);
  expect(snapshotReads).toBe(2);
  expect(refreshedState.contentFingerprint).toBe(freshSnapshot.contentFingerprint);
  expect(refreshedState.updatePreviewText).toContain("Latest flow prompt changes:");
  expect(refreshedState.updatePreviewText).toContain("Updated context line 20");
});

test("refreshMonitor keeps a queued clear update pending until the clear is accepted", async () => {
  const workspaceId = "workspace-clear-pending";
  const emptyFingerprint = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  spyOn(
    service as unknown as {
      readPromptSnapshot: (workspaceId: string) => Promise<{
        workspaceId: string;
        path: string;
        exists: boolean;
        content: string;
        hasNonEmptyContent: boolean;
        modifiedAtMs: number | null;
        contentFingerprint: string | null;
      }>;
    },
    "readPromptSnapshot"
  ).mockResolvedValue({
    workspaceId,
    path: "/tmp/workspace/.mux/prompts/feature.md",
    exists: false,
    content: "",
    hasNonEmptyContent: false,
    modifiedAtMs: null,
    contentFingerprint: null,
  });
  spyOn(
    service as unknown as {
      readPersistedState: (workspaceId: string) => Promise<{
        lastSentContent: string | null;
        lastSentFingerprint: string | null;
        autoSendMode: "off" | "end-of-turn";
      }>;
    },
    "readPersistedState"
  ).mockResolvedValue({
    lastSentContent: "Keep following the original flow prompt",
    lastSentFingerprint: "previous-fingerprint",
    autoSendMode: "end-of-turn",
  });

  const monitors = (
    service as unknown as {
      monitors: Map<
        string,
        {
          timer: null;
          stopped: boolean;
          refreshing: boolean;
          refreshPromise: Promise<unknown> | null;
          queuedRefresh: boolean;
          queuedRefreshEmitEvents: boolean;
          pendingFingerprint: string | null;
          inFlightFingerprint: string | null;
          failedFingerprint: string | null;
          lastState: null;
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
    refreshing: false,
    refreshPromise: null,
    queuedRefresh: false,
    queuedRefreshEmitEvents: false,
    pendingFingerprint: emptyFingerprint,
    inFlightFingerprint: null,
    failedFingerprint: null,
    lastState: null,
    activeChatSubscriptions: 0,
    lastOpenedAtMs: null,
    lastKnownActivityAtMs: null,
  });

  const refreshMonitor = (
    service as unknown as {
      refreshMonitor: (
        workspaceId: string,
        emitEvents: boolean
      ) => Promise<{
        hasPendingUpdate: boolean;
        updatePreviewText: string | null;
      }>;
    }
  ).refreshMonitor.bind(service);

  const state = await refreshMonitor(workspaceId, true);

  expect(state.hasPendingUpdate).toBe(true);
  expect(state.updatePreviewText).toContain("flow prompt file is now empty");
  expect(monitors.get(workspaceId)?.pendingFingerprint).toBe(emptyFingerprint);
});

it("includes the queued preview text in state while a flow prompt update is pending", () => {
  const workspaceId = "workspace-1";
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  const buildState = (
    service as unknown as {
      buildState: (
        snapshot: {
          workspaceId: string;
          path: string;
          exists: boolean;
          content: string;
          hasNonEmptyContent: boolean;
          modifiedAtMs: number | null;
          contentFingerprint: string | null;
        },
        persisted: {
          lastSentContent: string | null;
          lastSentFingerprint: string | null;
          autoSendMode: "off" | "end-of-turn";
        },
        pendingFingerprint: string | null
      ) => {
        hasPendingUpdate: boolean;
        updatePreviewText: string | null;
      };
    }
  ).buildState.bind(service);

  const previousContent = Array.from(
    { length: 40 },
    (_, index) => `Context line ${index + 1}`
  ).join("\n");
  const nextContent = previousContent.replace("Context line 20", "Updated context line 20");

  const state = buildState(
    {
      workspaceId,
      path: "/tmp/workspace/.mux/prompts/feature.md",
      exists: true,
      content: nextContent,
      hasNonEmptyContent: true,
      modifiedAtMs: 1,
      contentFingerprint: "94326d87717f640c44b44234d652ce38a34c79f5d6cbe2f1bb2ed9042f692e91",
    },
    {
      lastSentContent: previousContent,
      lastSentFingerprint: "2b025ee42d57e6eaf463f4ed6d7ee0ec2a58d5a1f501ef50b57462d4be4ca0b1",
      autoSendMode: "end-of-turn",
    },
    "94326d87717f640c44b44234d652ce38a34c79f5d6cbe2f1bb2ed9042f692e91"
  );

  expect(state.hasPendingUpdate).toBe(true);
  expect(state.updatePreviewText).toContain("Latest flow prompt changes:");
  expect(state.updatePreviewText).toContain("Updated context line 20");
});

it("keeps the live diff visible even when auto-send is off", () => {
  const workspaceId = "workspace-1";
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  const buildState = (
    service as unknown as {
      buildState: (
        snapshot: {
          workspaceId: string;
          path: string;
          exists: boolean;
          content: string;
          hasNonEmptyContent: boolean;
          modifiedAtMs: number | null;
          contentFingerprint: string | null;
        },
        persisted: {
          lastSentContent: string | null;
          lastSentFingerprint: string | null;
          autoSendMode: "off" | "end-of-turn";
        },
        pendingFingerprint: string | null
      ) => {
        hasPendingUpdate: boolean;
        autoSendMode: "off" | "end-of-turn";
        nextHeadingContent: string | null;
        updatePreviewText: string | null;
      };
    }
  ).buildState.bind(service);

  const previousContent = "Keep edits scoped and explain why they matter.";
  const nextContent = "Keep edits tightly scoped and explain why they matter.";

  const state = buildState(
    {
      workspaceId,
      path: "/tmp/workspace/.mux/prompts/feature.md",
      exists: true,
      content: nextContent,
      hasNonEmptyContent: true,
      modifiedAtMs: 1,
      contentFingerprint: "4ed3f20f59f6f19039e3b9ca1e7e9040cd026b8d55cfab262503324fa419fe00",
    },
    {
      lastSentContent: previousContent,
      lastSentFingerprint: "ef45d76e44c5ac31c43c08bf9fcf76a151867766f3bfa75e95b0098e59ff65fd",
      autoSendMode: "off",
    },
    null
  );

  expect(state.hasPendingUpdate).toBe(false);
  expect(state.autoSendMode).toBe("off");
  expect(state.updatePreviewText).toContain("Current flow prompt contents:");
  expect(state.updatePreviewText).toContain("Keep edits tightly scoped");
});

it("surfaces the parsed Next heading in state", () => {
  const workspaceId = "workspace-next-heading";
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  const buildState = (
    service as unknown as {
      buildState: (
        snapshot: {
          workspaceId: string;
          path: string;
          exists: boolean;
          content: string;
          hasNonEmptyContent: boolean;
          modifiedAtMs: number | null;
          contentFingerprint: string | null;
        },
        persisted: {
          lastSentContent: string | null;
          lastSentFingerprint: string | null;
          autoSendMode: "off" | "end-of-turn";
        },
        pendingFingerprint: string | null
      ) => {
        nextHeadingContent: string | null;
      };
    }
  ).buildState.bind(service);

  const state = buildState(
    {
      workspaceId,
      path: "/tmp/workspace/.mux/prompts/feature.md",
      exists: true,
      content:
        "# Context\nKeep edits tightly scoped.\n\n## Next\nOnly work on the failing flow prompt tests.\n\n## Later\nPolish the docs after the tests pass.",
      hasNonEmptyContent: true,
      modifiedAtMs: 1,
      contentFingerprint: "4ed3f20f59f6f19039e3b9ca1e7e9040cd026b8d55cfab262503324fa419fe00",
    },
    {
      lastSentContent: "# Context\nKeep edits tightly scoped.",
      lastSentFingerprint: "ef45d76e44c5ac31c43c08bf9fcf76a151867766f3bfa75e95b0098e59ff65fd",
      autoSendMode: "off",
    },
    null
  );

  expect(state.nextHeadingContent).toBe("Only work on the failing flow prompt tests.");
});

it("keeps the queued preview visible when deleting the flow prompt file is still pending", () => {
  const workspaceId = "workspace-1";
  const service = new WorkspaceFlowPromptService({
    getSessionDir: () => "/tmp/flow-prompt-session",
  } as unknown as Config);

  const buildState = (
    service as unknown as {
      buildState: (
        snapshot: {
          workspaceId: string;
          path: string;
          exists: boolean;
          content: string;
          hasNonEmptyContent: boolean;
          modifiedAtMs: number | null;
          contentFingerprint: string | null;
        },
        persisted: {
          lastSentContent: string | null;
          lastSentFingerprint: string | null;
          autoSendMode: "off" | "end-of-turn";
        },
        pendingFingerprint: string | null
      ) => {
        hasPendingUpdate: boolean;
        updatePreviewText: string | null;
      };
    }
  ).buildState.bind(service);

  const state = buildState(
    {
      workspaceId,
      path: "/tmp/workspace/.mux/prompts/feature.md",
      exists: false,
      content: "",
      hasNonEmptyContent: false,
      modifiedAtMs: null,
      contentFingerprint: null,
    },
    {
      lastSentContent: "Keep following the original flow prompt",
      lastSentFingerprint: "80b54f769f33b541a90900ac3fe33625bf2ec3ca3e9ec1415c2ab7ab6df554ef",
      autoSendMode: "end-of-turn",
    },
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );

  expect(state.hasPendingUpdate).toBe(true);
  expect(state.updatePreviewText).toContain("flow prompt file is now empty");
});

describe("buildFlowPromptAttachMessage", () => {
  const flowPromptPath = "/tmp/workspace/.mux/prompts/feature-branch.md";

  it("keeps fresh prompts lightweight by referencing the live prompt path", () => {
    const message = buildFlowPromptAttachMessage({
      path: flowPromptPath,
      previousContent: "",
      nextContent: "Implement the UI and keep tests green.",
    });

    expect(message).toBe(`Re the live prompt in ${flowPromptPath}:\n`);
  });

  it("includes a diff when a prior prompt already existed", () => {
    const previousContent = Array.from(
      { length: 40 },
      (_, index) => `Context line ${index + 1}`
    ).join("\n");
    const nextContent = previousContent.replace("Context line 20", "Updated context line 20");
    const message = buildFlowPromptAttachMessage({
      path: flowPromptPath,
      previousContent,
      nextContent,
    });

    expect(message).toContain(`Re the live prompt in ${flowPromptPath}:`);
    expect(message).toContain("Latest flow prompt changes:");
    expect(message).toContain("```diff");
    expect(message).toContain("Updated context line 20");
  });

  it("allows attaching a cleared prompt so the next turn drops old instructions", () => {
    const message = buildFlowPromptAttachMessage({
      path: flowPromptPath,
      previousContent: "Keep working on the refactor.",
      nextContent: "   ",
    });

    expect(message).toContain(`Re the live prompt in ${flowPromptPath}:`);
    expect(message).toContain("flow prompt file is now empty");
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

  it("includes the current Next heading when present", () => {
    const message = buildFlowPromptUpdateMessage({
      path: flowPromptPath,
      previousContent: "",
      nextContent: "Implement the UI and keep tests green.",
      nextHeadingContent: "Only work on the test coverage and do not edit later plan stages.",
    });

    expect(message).toContain("Current Next heading:");
    expect(message).toContain("Only work on the test coverage");
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
