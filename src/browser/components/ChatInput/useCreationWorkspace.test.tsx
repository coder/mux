import type { DraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import { getModeKey, getProjectScopeId, getThinkingLevelKey } from "@/common/constants/storage";
import type { SendMessageError } from "@/common/types/errors";
import type { BranchListResult, IPCApi, SendMessageOptions } from "@/common/types/ipc";
import type { RuntimeMode } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import React from "react";

const readPersistedStateCalls: Array<[string, unknown]> = [];
let persistedPreferences: Record<string, unknown> = {};
const readPersistedStateMock = mock((key: string, defaultValue: unknown) => {
  readPersistedStateCalls.push([key, defaultValue]);
  if (Object.prototype.hasOwnProperty.call(persistedPreferences, key)) {
    return persistedPreferences[key];
  }
  return defaultValue;
});

const updatePersistedStateCalls: Array<[string, unknown]> = [];
const updatePersistedStateMock = mock((key: string, value: unknown) => {
  updatePersistedStateCalls.push([key, value]);
});

void mock.module("@/browser/hooks/usePersistedState", () => ({
  readPersistedState: readPersistedStateMock,
  updatePersistedState: updatePersistedStateMock,
}));

interface DraftSettingsInvocation {
  projectPath: string;
  branches: string[];
  recommendedTrunk: string | null;
}
let draftSettingsInvocations: DraftSettingsInvocation[] = [];
let draftSettingsState: DraftSettingsHarness;
const useDraftWorkspaceSettingsMock = mock(
  (projectPath: string, branches: string[], recommendedTrunk: string | null) => {
    draftSettingsInvocations.push({ projectPath, branches, recommendedTrunk });
    if (!draftSettingsState) {
      throw new Error("Draft settings state not initialized");
    }
    return draftSettingsState.snapshot();
  }
);

void mock.module("@/browser/hooks/useDraftWorkspaceSettings", () => ({
  useDraftWorkspaceSettings: useDraftWorkspaceSettingsMock,
}));

let currentSendOptions: SendMessageOptions;
const useSendMessageOptionsMock = mock(() => currentSendOptions);

type WorkspaceSendMessage = IPCApi["workspace"]["sendMessage"];
type WorkspaceSendMessageParams = Parameters<WorkspaceSendMessage>;
void mock.module("@/browser/hooks/useSendMessageOptions", () => ({
  useSendMessageOptions: useSendMessageOptionsMock,
}));

const TEST_PROJECT_PATH = "/projects/demo";
const TEST_WORKSPACE_ID = "ws-created";
const TEST_METADATA: FrontendWorkspaceMetadata = {
  id: TEST_WORKSPACE_ID,
  name: "demo-branch",
  projectName: "Demo",
  projectPath: TEST_PROJECT_PATH,
  namedWorkspacePath: "/worktrees/demo/demo-branch",
  runtimeConfig: { type: "local", srcBaseDir: "/home/user/.mux/src" },
  createdAt: "2025-01-01T00:00:00.000Z",
};

import { useCreationWorkspace } from "./useCreationWorkspace";

describe("useCreationWorkspace", () => {
  beforeEach(() => {
    persistedPreferences = {};
    readPersistedStateCalls.length = 0;
    updatePersistedStateCalls.length = 0;
    draftSettingsInvocations = [];
    draftSettingsState = createDraftSettingsHarness();
    currentSendOptions = {
      model: "gpt-4",
      thinkingLevel: "medium",
      mode: "exec",
    } satisfies SendMessageOptions;
  });

  afterEach(() => {
    cleanup();
    // Reset global window/document/localStorage between tests
    // @ts-expect-error - test cleanup
    globalThis.window = undefined;
    // @ts-expect-error - test cleanup
    globalThis.document = undefined;
    // @ts-expect-error - test cleanup
    globalThis.localStorage = undefined;
  });

  test("loads branches when projectPath is provided", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main", "dev"],
          recommendedTrunk: "dev",
        })
    );
    const { projectsApi } = setupWindow({ listBranches: listBranchesMock });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
    });

    await waitFor(() => expect(projectsApi.listBranches.mock.calls.length).toBe(1));
    expect(projectsApi.listBranches.mock.calls[0][0]).toBe(TEST_PROJECT_PATH);

    await waitFor(() => expect(getHook().branches).toEqual(["main", "dev"]));
    expect(draftSettingsInvocations[0]).toEqual({
      projectPath: TEST_PROJECT_PATH,
      branches: [],
      recommendedTrunk: null,
    });
    expect(draftSettingsInvocations.at(-1)).toEqual({
      projectPath: TEST_PROJECT_PATH,
      branches: ["main", "dev"],
      recommendedTrunk: "dev",
    });
    expect(getHook().trunkBranch).toBe(draftSettingsState.state.trunkBranch);
  });

  test("does not load branches when projectPath is empty", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    setupWindow({ listBranches: listBranchesMock });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: "",
      onWorkspaceCreated,
    });

    await waitFor(() => expect(draftSettingsInvocations.length).toBeGreaterThan(0));
    expect(listBranchesMock.mock.calls.length).toBe(0);
    expect(getHook().branches).toEqual([]);
  });

  test("handleSend sends message and syncs preferences on success", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    const sendMessageMock = mock<WorkspaceSendMessage>((..._args: WorkspaceSendMessageParams) =>
      Promise.resolve({
        success: true as const,
        workspaceId: TEST_WORKSPACE_ID,
        metadata: TEST_METADATA,
      })
    );
    const { workspaceApi } = setupWindow({
      listBranches: listBranchesMock,
      sendMessage: sendMessageMock,
    });

    persistedPreferences[getModeKey(getProjectScopeId(TEST_PROJECT_PATH))] = "plan";
    persistedPreferences[getThinkingLevelKey(getProjectScopeId(TEST_PROJECT_PATH))] = "high";

    draftSettingsState = createDraftSettingsHarness({
      runtimeMode: "ssh",
      sshHost: "example.com",
      runtimeString: "ssh example.com",
      trunkBranch: "dev",
    });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
    });

    await waitFor(() => expect(getHook().branches).toEqual(["main"]));

    await act(async () => {
      await getHook().handleSend("launch workspace");
    });

    expect(workspaceApi.sendMessage.mock.calls.length).toBe(1);
    const [workspaceId, message, options] = workspaceApi.sendMessage.mock.calls[0];
    expect(workspaceId).toBeNull();
    expect(message).toBe("launch workspace");
    expect(options?.projectPath).toBe(TEST_PROJECT_PATH);
    expect(options?.trunkBranch).toBe("dev");
    expect(options?.model).toBe("gpt-4");
    expect(options?.mode).toBe("exec");
    expect(options?.thinkingLevel).toBe("medium");
    expect(options?.runtimeConfig).toEqual({
      type: "ssh",
      host: "example.com",
      srcBaseDir: "~/mux",
    });

    await waitFor(() => expect(onWorkspaceCreated.mock.calls.length).toBe(1));
    expect(onWorkspaceCreated.mock.calls[0][0]).toEqual(TEST_METADATA);

    const projectModeKey = getModeKey(getProjectScopeId(TEST_PROJECT_PATH));
    const projectThinkingKey = getThinkingLevelKey(getProjectScopeId(TEST_PROJECT_PATH));
    expect(readPersistedStateCalls).toContainEqual([projectModeKey, null]);
    expect(readPersistedStateCalls).toContainEqual([projectThinkingKey, null]);

    const modeKey = getModeKey(TEST_WORKSPACE_ID);
    const thinkingKey = getThinkingLevelKey(TEST_WORKSPACE_ID);
    expect(updatePersistedStateCalls).toContainEqual([modeKey, "plan"]);
    expect(updatePersistedStateCalls).toContainEqual([thinkingKey, "high"]);
  });

  test("handleSend surfaces backend errors and resets state", async () => {
    const sendMessageMock = mock<WorkspaceSendMessage>((..._args: WorkspaceSendMessageParams) =>
      Promise.resolve({
        success: false as const,
        error: { type: "unknown", raw: "backend exploded" } satisfies SendMessageError,
      })
    );
    setupWindow({ sendMessage: sendMessageMock });
    draftSettingsState = createDraftSettingsHarness({ trunkBranch: "dev" });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
    });

    await act(async () => {
      await getHook().handleSend("make workspace");
    });

    expect(sendMessageMock.mock.calls.length).toBe(1);
    expect(onWorkspaceCreated.mock.calls.length).toBe(0);
    await waitFor(() => expect(getHook().toast?.message).toBe("backend exploded"));
    await waitFor(() => expect(getHook().isSending).toBe(false));
    expect(updatePersistedStateCalls).toEqual([]);
  });
});

type DraftSettingsHarness = ReturnType<typeof createDraftSettingsHarness>;

function createDraftSettingsHarness(
  initial?: Partial<{
    runtimeMode: RuntimeMode;
    sshHost: string;
    trunkBranch: string;
    runtimeString?: string | undefined;
  }>
) {
  const state = {
    runtimeMode: initial?.runtimeMode ?? ("local" as RuntimeMode),
    sshHost: initial?.sshHost ?? "",
    trunkBranch: initial?.trunkBranch ?? "main",
    runtimeString: initial?.runtimeString,
  } satisfies {
    runtimeMode: RuntimeMode;
    sshHost: string;
    trunkBranch: string;
    runtimeString: string | undefined;
  };

  const setRuntimeOptions = mock((mode: RuntimeMode, host: string) => {
    state.runtimeMode = mode;
    state.sshHost = host;
    const trimmedHost = host.trim();
    state.runtimeString = mode === "ssh" ? (trimmedHost ? `ssh ${trimmedHost}` : "ssh") : undefined;
  });

  const setTrunkBranch = mock((branch: string) => {
    state.trunkBranch = branch;
  });

  const getRuntimeString = mock(() => state.runtimeString);

  return {
    state,
    setRuntimeOptions,
    setTrunkBranch,
    getRuntimeString,
    snapshot(): {
      settings: DraftWorkspaceSettings;
      setRuntimeOptions: typeof setRuntimeOptions;
      setTrunkBranch: typeof setTrunkBranch;
      getRuntimeString: typeof getRuntimeString;
    } {
      const settings: DraftWorkspaceSettings = {
        model: "gpt-4",
        thinkingLevel: "medium",
        mode: "exec",
        runtimeMode: state.runtimeMode,
        sshHost: state.sshHost,
        trunkBranch: state.trunkBranch,
      };
      return {
        settings,
        setRuntimeOptions,
        setTrunkBranch,
        getRuntimeString,
      };
    },
  };
}

interface SetupWindowOptions {
  listBranches?: ReturnType<typeof mock<(projectPath: string) => Promise<BranchListResult>>>;
  sendMessage?: ReturnType<
    typeof mock<
      (
        workspaceId: string | null,
        message: string,
        options?: Parameters<typeof window.api.workspace.sendMessage>[2]
      ) => ReturnType<typeof window.api.workspace.sendMessage>
    >
  >;
}

function setupWindow(options: SetupWindowOptions = {}) {
  const windowInstance = new GlobalWindow();
  const listBranches =
    options.listBranches ??
    mock((): Promise<BranchListResult> => Promise.resolve({ branches: [], recommendedTrunk: "" }));
  const sendMessage =
    options.sendMessage ??
    mock(
      (
        _workspaceId: string | null,
        _message: string,
        _opts?: Parameters<typeof window.api.workspace.sendMessage>[2]
      ) =>
        Promise.resolve({
          success: true as const,
          workspaceId: TEST_WORKSPACE_ID,
          metadata: TEST_METADATA,
        })
    );

  globalThis.window = windowInstance as unknown as typeof globalThis.window;
  const windowWithApi = globalThis.window as typeof globalThis.window & { api: IPCApi };
  windowWithApi.api = {
    projects: {
      listBranches,
    },
    workspace: {
      sendMessage,
    },
    platform: "test",
    versions: {
      node: "0",
      chrome: "0",
      electron: "0",
    },
  } as unknown as typeof windowWithApi.api;

  globalThis.document = windowWithApi.document;
  globalThis.localStorage = windowWithApi.localStorage;

  return {
    projectsApi: { listBranches },
    workspaceApi: { sendMessage },
  };
}

interface HookOptions {
  projectPath: string;
  onWorkspaceCreated: (metadata: FrontendWorkspaceMetadata) => void;
}

function renderUseCreationWorkspace(options: HookOptions) {
  const resultRef: {
    current: ReturnType<typeof useCreationWorkspace> | null;
  } = { current: null };

  function Harness(props: HookOptions) {
    resultRef.current = useCreationWorkspace(props);
    return null;
  }

  render(<Harness {...options} />);

  return () => {
    if (!resultRef.current) {
      throw new Error("Hook result not initialized");
    }
    return resultRef.current;
  };
}
