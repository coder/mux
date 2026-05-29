import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import * as APIModule from "@/browser/contexts/API";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { HeartbeatFormSettings } from "./useWorkspaceHeartbeat";

interface HeartbeatApi {
  workspace: {
    heartbeat: {
      get: (input: { workspaceId: string }) => Promise<HeartbeatFormSettings | null>;
      set: (input: { workspaceId: string } & HeartbeatFormSettings) => Promise<{
        success: boolean;
        error?: string;
      }>;
    };
  };
  config: {
    getConfig: () => Promise<{
      heartbeatDefaultIntervalMs?: number;
      heartbeatDefaultPrompt?: string;
    }>;
  };
}

const TEST_WORKSPACE_ID = "workspace-1";

type WorkspaceMetadataMap = Map<string, FrontendWorkspaceMetadata>;
type WorkspaceMetadataUpdater = (prev: WorkspaceMetadataMap) => WorkspaceMetadataMap;

let apiMock: HeartbeatApi | null = null;
let capturedWorkspaceMetadataUpdate: WorkspaceMetadataUpdater | null = null;
const setWorkspaceMetadataMock = mock((update: WorkspaceMetadataUpdater) => {
  capturedWorkspaceMetadataUpdate = update;
});

const actualAPIModule = { ...APIModule };
const actualWorkspaceContextModule = { ...WorkspaceContextModule };

// Keep module mocks inside test hooks: Bun loads test files before afterAll runs, so
// file-scope mock.module() calls can pollute unrelated files during collection.
async function installWorkspaceHeartbeatModuleMocks() {
  await mock.module("@/browser/contexts/API", () => ({
    ...actualAPIModule,
    useAPI: () => ({ api: apiMock }),
  }));
  await mock.module("@/browser/contexts/WorkspaceContext", () => ({
    ...actualWorkspaceContextModule,
    useWorkspaceActions: () => ({
      setWorkspaceMetadata: setWorkspaceMetadataMock,
    }),
  }));
}

async function restoreWorkspaceHeartbeatModuleMocks() {
  // Bun 1.3.6's mock.module() has no disposer, and mock.restore() does not undo
  // module mocks. Restore the real exports so these stubs do not leak into later files.
  await mock.module("@/browser/contexts/API", () => actualAPIModule);
  await mock.module("@/browser/contexts/WorkspaceContext", () => actualWorkspaceContextModule);
}

import { useWorkspaceHeartbeat } from "./useWorkspaceHeartbeat";

function createMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: TEST_WORKSPACE_ID,
    name: "workspace-1",
    title: "Workspace 1",
    projectName: "Project",
    projectPath: "/tmp/project",
    namedWorkspacePath: "/tmp/project/workspace-1",
    runtimeConfig: { type: "local" },
    createdAt: "2026-04-09T00:00:00.000Z",
    ...overrides,
  };
}

function applyCapturedMetadataUpdate(
  metadata: FrontendWorkspaceMetadata
): FrontendWorkspaceMetadata {
  const update = capturedWorkspaceMetadataUpdate;
  if (!update) {
    throw new Error("Expected workspace metadata update to be captured");
  }

  const nextMap = update(new Map([[metadata.id, metadata]]));
  const nextMetadata = nextMap.get(metadata.id);
  if (!nextMetadata) {
    throw new Error("Expected updated workspace metadata to exist");
  }

  return nextMetadata;
}

describe("useWorkspaceHeartbeat", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  afterAll(async () => {
    await restoreWorkspaceHeartbeatModuleMocks();
  });

  beforeEach(async () => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    await installWorkspaceHeartbeatModuleMocks();
    capturedWorkspaceMetadataUpdate = null;
    setWorkspaceMetadataMock.mockClear();
  });

  afterEach(async () => {
    cleanup();
    await restoreWorkspaceHeartbeatModuleMocks();
    mock.restore();
    apiMock = null;
    capturedWorkspaceMetadataUpdate = null;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("optimistically enables heartbeat metadata after a successful save", async () => {
    const saveHeartbeat = mock(() => Promise.resolve({ success: true }));
    apiMock = {
      workspace: {
        heartbeat: {
          get: () => Promise.resolve(null),
          set: saveHeartbeat,
        },
      },
      config: {
        getConfig: () => Promise.resolve({}),
      },
    };

    const { result } = renderHook(() => useWorkspaceHeartbeat({ workspaceId: TEST_WORKSPACE_ID }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const nextSettings: HeartbeatFormSettings = {
      enabled: true,
      intervalMs: 120000,
      contextMode: "normal",
      message: "Status update",
    };

    let saveSucceeded = false;
    await act(async () => {
      saveSucceeded = await result.current.save(nextSettings);
    });

    expect(saveSucceeded).toBe(true);
    expect(saveHeartbeat).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      ...nextSettings,
    });
    expect(setWorkspaceMetadataMock).toHaveBeenCalledTimes(1);

    const updatedMetadata = applyCapturedMetadataUpdate(
      createMetadata({
        heartbeat: {
          enabled: false,
          intervalMs: 60000,
          contextMode: "normal",
        },
      })
    );

    expect(updatedMetadata.heartbeat).toEqual(nextSettings);
  });

  test("optimistically disables heartbeat metadata after a successful save", async () => {
    const initialSettings: HeartbeatFormSettings = {
      enabled: true,
      intervalMs: 120000,
      contextMode: "compact",
      message: "Keep watching",
    };
    apiMock = {
      workspace: {
        heartbeat: {
          get: () => Promise.resolve(initialSettings),
          set: () => Promise.resolve({ success: true }),
        },
      },
      config: {
        getConfig: () => Promise.resolve({}),
      },
    };

    const { result } = renderHook(() => useWorkspaceHeartbeat({ workspaceId: TEST_WORKSPACE_ID }));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const nextSettings: HeartbeatFormSettings = {
      enabled: false,
      intervalMs: initialSettings.intervalMs,
      contextMode: initialSettings.contextMode,
      message: initialSettings.message,
    };

    let saveSucceeded = false;
    await act(async () => {
      saveSucceeded = await result.current.save(nextSettings);
    });

    expect(saveSucceeded).toBe(true);
    expect(setWorkspaceMetadataMock).toHaveBeenCalledTimes(1);

    const updatedMetadata = applyCapturedMetadataUpdate(
      createMetadata({
        heartbeat: initialSettings,
      })
    );

    expect(updatedMetadata.heartbeat?.enabled).toBe(false);
    expect(updatedMetadata.heartbeat?.intervalMs).toBe(initialSettings.intervalMs);
    expect(updatedMetadata.heartbeat?.contextMode).toBe(initialSettings.contextMode);
    expect(updatedMetadata.heartbeat?.message).toBe(initialSettings.message);
  });
});
