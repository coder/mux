import type { APIClient } from "@/browser/contexts/API";
import type { DraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import {
  getInputKey,
  getInputImagesKey,
  getModelKey,
  getModeKey,
  getPendingScopeId,
  getProjectScopeId,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import type { SendMessageError as _SendMessageError } from "@/common/types/errors";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { RuntimeMode } from "@/common/types/runtime";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { useCreationWorkspace } from "./useCreationWorkspace";

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

let currentORPCClient: MockOrpcClient | null = null;
void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => {
    if (!currentORPCClient) {
      return { api: null, status: "connecting" as const, error: null };
    }
    return {
      api: currentORPCClient as APIClient,
      status: "connected" as const,
      error: null,
    };
  },
}));

const TEST_PROJECT_PATH = "/projects/demo";
const FALLBACK_BRANCH = "main";
const TEST_WORKSPACE_ID = "ws-created";
type BranchListResult = Awaited<ReturnType<APIClient["projects"]["listBranches"]>>;
type ListBranchesArgs = Parameters<APIClient["projects"]["listBranches"]>[0];
type WorkspaceSendMessageArgs = Parameters<APIClient["workspace"]["sendMessage"]>[0];
type WorkspaceSendMessageResult = Awaited<ReturnType<APIClient["workspace"]["sendMessage"]>>;
type WorkspaceCreateArgs = Parameters<APIClient["workspace"]["create"]>[0];
type WorkspaceUpdateAISettingsArgs = Parameters<APIClient["workspace"]["updateAISettings"]>[0];
type WorkspaceUpdateAISettingsResult = Awaited<
  ReturnType<APIClient["workspace"]["updateAISettings"]>
>;
type WorkspaceCreateResult = Awaited<ReturnType<APIClient["workspace"]["create"]>>;
type NameGenerationArgs = Parameters<APIClient["nameGeneration"]["generate"]>[0];
type NameGenerationResult = Awaited<ReturnType<APIClient["nameGeneration"]["generate"]>>;
type MockOrpcProjectsClient = Pick<APIClient["projects"], "listBranches">;
type MockOrpcWorkspaceClient = Pick<
  APIClient["workspace"],
  "sendMessage" | "create" | "updateAISettings"
>;
type MockOrpcNameGenerationClient = Pick<APIClient["nameGeneration"], "generate">;
type WindowWithApi = Window & typeof globalThis;
type WindowApi = WindowWithApi["api"];

function rejectNotImplemented(method: string) {
  return (..._args: unknown[]): Promise<never> =>
    Promise.reject(new Error(`${method} is not implemented in useCreationWorkspace tests`));
}

function throwNotImplemented(method: string) {
  return (..._args: unknown[]): never => {
    throw new Error(`${method} is not implemented in useCreationWorkspace tests`);
  };
}

const noopUnsubscribe = () => () => undefined;
interface MockOrpcClient {
  projects: MockOrpcProjectsClient;
  workspace: MockOrpcWorkspaceClient;
  nameGeneration: MockOrpcNameGenerationClient;
}
interface SetupWindowOptions {
  listBranches?: ReturnType<typeof mock<(args: ListBranchesArgs) => Promise<BranchListResult>>>;
  sendMessage?: ReturnType<
    typeof mock<(args: WorkspaceSendMessageArgs) => Promise<WorkspaceSendMessageResult>>
  >;
  updateAISettings?: ReturnType<
    typeof mock<(args: WorkspaceUpdateAISettingsArgs) => Promise<WorkspaceUpdateAISettingsResult>>
  >;
  create?: ReturnType<typeof mock<(args: WorkspaceCreateArgs) => Promise<WorkspaceCreateResult>>>;
  nameGeneration?: ReturnType<
    typeof mock<(args: NameGenerationArgs) => Promise<NameGenerationResult>>
  >;
}

const setupWindow = ({
  listBranches,
  sendMessage,
  create,
  updateAISettings,
  nameGeneration,
}: SetupWindowOptions = {}) => {
  const listBranchesMock =
    listBranches ??
    mock<(args: ListBranchesArgs) => Promise<BranchListResult>>(({ projectPath }) => {
      if (!projectPath) {
        throw new Error("listBranches mock requires projectPath");
      }
      return Promise.resolve({
        branches: [FALLBACK_BRANCH],
        recommendedTrunk: FALLBACK_BRANCH,
      });
    });

  const sendMessageMock =
    sendMessage ??
    mock<(args: WorkspaceSendMessageArgs) => Promise<WorkspaceSendMessageResult>>(() => {
      const result: WorkspaceSendMessageResult = {
        success: true,
        data: {},
      };
      return Promise.resolve(result);
    });

  const createMock =
    create ??
    mock<(args: WorkspaceCreateArgs) => Promise<WorkspaceCreateResult>>(() => {
      return Promise.resolve({
        success: true,
        metadata: TEST_METADATA,
      } as WorkspaceCreateResult);
    });

  const updateAISettingsMock =
    updateAISettings ??
    mock<(args: WorkspaceUpdateAISettingsArgs) => Promise<WorkspaceUpdateAISettingsResult>>(() => {
      return Promise.resolve({
        success: true,
        data: undefined,
      } as WorkspaceUpdateAISettingsResult);
    });

  const nameGenerationMock =
    nameGeneration ??
    mock<(args: NameGenerationArgs) => Promise<NameGenerationResult>>(() => {
      return Promise.resolve({
        success: true,
        data: {
          name: "test-workspace",
          modelUsed: "anthropic:claude-haiku-4-5",
        },
      } as NameGenerationResult);
    });

  currentORPCClient = {
    projects: {
      listBranches: (input: ListBranchesArgs) => listBranchesMock(input),
    },
    workspace: {
      sendMessage: (input: WorkspaceSendMessageArgs) => sendMessageMock(input),
      create: (input: WorkspaceCreateArgs) => createMock(input),
      updateAISettings: (input: WorkspaceUpdateAISettingsArgs) => updateAISettingsMock(input),
    },
    nameGeneration: {
      generate: (input: NameGenerationArgs) => nameGenerationMock(input),
    },
  };

  const windowInstance = new GlobalWindow();
  globalThis.window = windowInstance as unknown as WindowWithApi;
  const windowWithApi = globalThis.window as WindowWithApi;

  const apiMock: WindowApi = {
    tokenizer: {
      countTokens: rejectNotImplemented("tokenizer.countTokens"),
      countTokensBatch: rejectNotImplemented("tokenizer.countTokensBatch"),
      calculateStats: rejectNotImplemented("tokenizer.calculateStats"),
    },
    providers: {
      setProviderConfig: rejectNotImplemented("providers.setProviderConfig"),
      list: rejectNotImplemented("providers.list"),
    },
    projects: {
      create: rejectNotImplemented("projects.create"),
      pickDirectory: rejectNotImplemented("projects.pickDirectory"),
      remove: rejectNotImplemented("projects.remove"),
      list: rejectNotImplemented("projects.list"),
      listBranches: (projectPath: string) => listBranchesMock({ projectPath }),
      secrets: {
        get: rejectNotImplemented("projects.secrets.get"),
        update: rejectNotImplemented("projects.secrets.update"),
      },
    },
    nameGeneration: {
      generate: (args: NameGenerationArgs) => nameGenerationMock(args),
    },
    workspace: {
      list: rejectNotImplemented("workspace.list"),
      create: (args: WorkspaceCreateArgs) => createMock(args),
      updateAISettings: (args: WorkspaceUpdateAISettingsArgs) => updateAISettingsMock(args),
      remove: rejectNotImplemented("workspace.remove"),
      rename: rejectNotImplemented("workspace.rename"),
      fork: rejectNotImplemented("workspace.fork"),
      sendMessage: (
        workspaceId: WorkspaceSendMessageArgs["workspaceId"],
        message: WorkspaceSendMessageArgs["message"],
        options?: WorkspaceSendMessageArgs["options"]
      ) => sendMessageMock({ workspaceId, message, options }),
      resumeStream: rejectNotImplemented("workspace.resumeStream"),
      interruptStream: rejectNotImplemented("workspace.interruptStream"),
      clearQueue: rejectNotImplemented("workspace.clearQueue"),
      truncateHistory: rejectNotImplemented("workspace.truncateHistory"),
      replaceChatHistory: rejectNotImplemented("workspace.replaceChatHistory"),
      getInfo: rejectNotImplemented("workspace.getInfo"),
      executeBash: rejectNotImplemented("workspace.executeBash"),
      openTerminal: rejectNotImplemented("workspace.openTerminal"),
      onChat: (_workspaceId: string, _callback: (data: WorkspaceChatMessage) => void) =>
        noopUnsubscribe(),
      onMetadata: (
        _callback: (data: { workspaceId: string; metadata: FrontendWorkspaceMetadata }) => void
      ) => noopUnsubscribe(),
      activity: {
        list: rejectNotImplemented("workspace.activity.list"),
        subscribe: (
          _callback: (payload: {
            workspaceId: string;
            activity: WorkspaceActivitySnapshot | null;
          }) => void
        ) => noopUnsubscribe(),
      },
    },
    window: {
      setTitle: rejectNotImplemented("window.setTitle"),
    },
    terminal: {
      create: rejectNotImplemented("terminal.create"),
      close: rejectNotImplemented("terminal.close"),
      resize: rejectNotImplemented("terminal.resize"),
      sendInput: throwNotImplemented("terminal.sendInput"),
      onOutput: () => noopUnsubscribe(),
      onExit: () => noopUnsubscribe(),
      openWindow: rejectNotImplemented("terminal.openWindow"),
      closeWindow: rejectNotImplemented("terminal.closeWindow"),
    },
    update: {
      check: rejectNotImplemented("update.check"),
      download: rejectNotImplemented("update.download"),
      install: throwNotImplemented("update.install"),
      onStatus: () => noopUnsubscribe(),
    },
    platform: "linux",
    versions: {
      node: "0",
      chrome: "0",
      electron: "0",
    },
  };

  windowWithApi.api = apiMock;

  globalThis.document = windowInstance.document as unknown as Document;
  globalThis.localStorage = windowInstance.localStorage as unknown as Storage;

  return {
    projectsApi: { listBranches: listBranchesMock },
    workspaceApi: {
      sendMessage: sendMessageMock,
      create: createMock,
      updateAISettings: updateAISettingsMock,
    },
    nameGenerationApi: { generate: nameGenerationMock },
  };
};
const TEST_METADATA: FrontendWorkspaceMetadata = {
  id: TEST_WORKSPACE_ID,
  name: "demo-branch",
  projectName: "Demo",
  projectPath: TEST_PROJECT_PATH,
  namedWorkspacePath: "/worktrees/demo/demo-branch",
  runtimeConfig: { type: "local", srcBaseDir: "/home/user/.mux/src" },
  createdAt: "2025-01-01T00:00:00.000Z",
};

describe("useCreationWorkspace", () => {
  beforeEach(() => {
    persistedPreferences = {};
    readPersistedStateCalls.length = 0;
    updatePersistedStateCalls.length = 0;
    draftSettingsInvocations = [];
    draftSettingsState = createDraftSettingsHarness();
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
    // ORPC uses object argument
    expect(projectsApi.listBranches.mock.calls[0][0]).toEqual({ projectPath: TEST_PROJECT_PATH });

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

  test("handleSend creates workspace and sends message on success", async () => {
    const listBranchesMock = mock(
      (): Promise<BranchListResult> =>
        Promise.resolve({
          branches: ["main"],
          recommendedTrunk: "main",
        })
    );
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
        Promise.resolve({
          success: true as const,
          data: {},
        })
    );
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: true,
          metadata: TEST_METADATA,
        } as WorkspaceCreateResult)
    );
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "generated-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    const { workspaceApi, nameGenerationApi } = setupWindow({
      listBranches: listBranchesMock,
      sendMessage: sendMessageMock,
      create: createMock,
      nameGeneration: nameGenerationMock,
    });

    persistedPreferences[getModeKey(getProjectScopeId(TEST_PROJECT_PATH))] = "plan";
    // Set model preference for the project scope (read by getSendOptionsFromStorage)
    persistedPreferences[getModelKey(getProjectScopeId(TEST_PROJECT_PATH))] = "gpt-4";

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
      message: "launch workspace",
    });

    await waitFor(() => expect(getHook().branches).toEqual(["main"]));

    // Wait for name generation to trigger (happens on debounce)
    await waitFor(() => expect(nameGenerationApi.generate.mock.calls.length).toBe(1));

    await act(async () => {
      await getHook().handleSend("launch workspace");
    });

    // workspace.create should be called with the generated name
    expect(workspaceApi.create.mock.calls.length).toBe(1);
    const createCall = workspaceApi.create.mock.calls[0];
    if (!createCall) {
      throw new Error("Expected workspace.create to be called at least once");
    }
    const [createRequest] = createCall;
    expect(createRequest?.branchName).toBe("generated-name");
    expect(createRequest?.trunkBranch).toBe("dev");
    expect(createRequest?.runtimeConfig).toEqual({
      type: "ssh",
      host: "example.com",
      srcBaseDir: "~/mux",
    });

    // workspace.sendMessage should be called with the created workspace ID
    expect(workspaceApi.sendMessage.mock.calls.length).toBe(1);
    const sendCall = workspaceApi.sendMessage.mock.calls[0];
    if (!sendCall) {
      throw new Error("Expected workspace.sendMessage to be called at least once");
    }
    const [sendRequest] = sendCall;
    expect(sendRequest?.workspaceId).toBe(TEST_WORKSPACE_ID);
    expect(sendRequest?.message).toBe("launch workspace");

    await waitFor(() => expect(onWorkspaceCreated.mock.calls.length).toBe(1));
    expect(onWorkspaceCreated.mock.calls[0][0]).toEqual(TEST_METADATA);

    const projectModeKey = getModeKey(getProjectScopeId(TEST_PROJECT_PATH));
    expect(readPersistedStateCalls).toContainEqual([projectModeKey, null]);

    const modeKey = getModeKey(TEST_WORKSPACE_ID);
    const pendingScopeId = getPendingScopeId(TEST_PROJECT_PATH);
    const pendingInputKey = getInputKey(pendingScopeId);
    const pendingImagesKey = getInputImagesKey(pendingScopeId);
    expect(updatePersistedStateCalls).toContainEqual([modeKey, "plan"]);
    // Thinking is workspace-scoped, but this test doesn't set a project-scoped thinking preference.
    expect(updatePersistedStateCalls).toContainEqual([pendingInputKey, ""]);
    expect(updatePersistedStateCalls).toContainEqual([pendingImagesKey, undefined]);
  });

  test("handleSend surfaces backend errors and resets state", async () => {
    const createMock = mock(
      (_args: WorkspaceCreateArgs): Promise<WorkspaceCreateResult> =>
        Promise.resolve({
          success: false,
          error: "backend exploded",
        } as WorkspaceCreateResult)
    );
    const nameGenerationMock = mock(
      (_args: NameGenerationArgs): Promise<NameGenerationResult> =>
        Promise.resolve({
          success: true,
          data: { name: "test-name", modelUsed: "anthropic:claude-haiku-4-5" },
        } as NameGenerationResult)
    );
    const { workspaceApi, nameGenerationApi } = setupWindow({
      create: createMock,
      nameGeneration: nameGenerationMock,
    });
    draftSettingsState = createDraftSettingsHarness({ trunkBranch: "dev" });
    const onWorkspaceCreated = mock((metadata: FrontendWorkspaceMetadata) => metadata);

    const getHook = renderUseCreationWorkspace({
      projectPath: TEST_PROJECT_PATH,
      onWorkspaceCreated,
      message: "make workspace",
    });

    // Wait for name generation to trigger
    await waitFor(() => expect(nameGenerationApi.generate.mock.calls.length).toBe(1));

    await act(async () => {
      await getHook().handleSend("make workspace");
    });

    expect(workspaceApi.create.mock.calls.length).toBe(1);
    expect(onWorkspaceCreated.mock.calls.length).toBe(0);
    await waitFor(() => expect(getHook().toast?.message).toBe("backend exploded"));
    await waitFor(() => expect(getHook().isSending).toBe(false));

    // Side effect: send-options reader may migrate thinking level into the project scope.
    const thinkingKey = getThinkingLevelKey(getProjectScopeId(TEST_PROJECT_PATH));
    expect(updatePersistedStateCalls).toEqual([[thinkingKey, "off"]]);
  });
});

type DraftSettingsHarness = ReturnType<typeof createDraftSettingsHarness>;

function createDraftSettingsHarness(
  initial?: Partial<{
    runtimeMode: RuntimeMode;
    sshHost: string;
    trunkBranch: string;
    runtimeString?: string | undefined;
    defaultRuntimeMode?: RuntimeMode;
  }>
) {
  const state = {
    runtimeMode: initial?.runtimeMode ?? "local",
    defaultRuntimeMode: initial?.defaultRuntimeMode ?? "worktree",
    sshHost: initial?.sshHost ?? "",
    trunkBranch: initial?.trunkBranch ?? "main",
    runtimeString: initial?.runtimeString,
  } satisfies {
    runtimeMode: RuntimeMode;
    defaultRuntimeMode: RuntimeMode;
    sshHost: string;
    trunkBranch: string;
    runtimeString: string | undefined;
  };

  const setTrunkBranch = mock((branch: string) => {
    state.trunkBranch = branch;
  });

  const getRuntimeString = mock(() => state.runtimeString);

  const setRuntimeMode = mock((mode: RuntimeMode) => {
    state.runtimeMode = mode;
    const trimmedHost = state.sshHost.trim();
    state.runtimeString = mode === "ssh" ? (trimmedHost ? `ssh ${trimmedHost}` : "ssh") : undefined;
  });

  const setDefaultRuntimeMode = mock((mode: RuntimeMode) => {
    state.defaultRuntimeMode = mode;
    state.runtimeMode = mode;
    const trimmedHost = state.sshHost.trim();
    state.runtimeString = mode === "ssh" ? (trimmedHost ? `ssh ${trimmedHost}` : "ssh") : undefined;
  });

  const setSshHost = mock((host: string) => {
    state.sshHost = host;
  });

  return {
    state,
    setRuntimeMode,
    setDefaultRuntimeMode,
    setSshHost,
    setTrunkBranch,
    getRuntimeString,
    snapshot(): {
      settings: DraftWorkspaceSettings;
      setRuntimeMode: typeof setRuntimeMode;
      setDefaultRuntimeMode: typeof setDefaultRuntimeMode;
      setSshHost: typeof setSshHost;
      setTrunkBranch: typeof setTrunkBranch;
      getRuntimeString: typeof getRuntimeString;
    } {
      const settings: DraftWorkspaceSettings = {
        model: "gpt-4",
        thinkingLevel: "medium",
        mode: "exec",
        runtimeMode: state.runtimeMode,
        defaultRuntimeMode: state.defaultRuntimeMode,
        sshHost: state.sshHost,
        trunkBranch: state.trunkBranch,
      };
      return {
        settings,
        setRuntimeMode,
        setDefaultRuntimeMode,
        setSshHost,
        setTrunkBranch,
        getRuntimeString,
      };
    },
  };
}

interface HookOptions {
  projectPath: string;
  onWorkspaceCreated: (metadata: FrontendWorkspaceMetadata) => void;
  message?: string;
}

function renderUseCreationWorkspace(options: HookOptions) {
  const resultRef: {
    current: ReturnType<typeof useCreationWorkspace> | null;
  } = { current: null };

  function Harness(props: HookOptions) {
    resultRef.current = useCreationWorkspace({
      ...props,
      message: props.message ?? "",
    });
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
