import type { ORPCClient } from "@/browser/orpc/react";
import type { DraftWorkspaceSettings } from "@/browser/hooks/useDraftWorkspaceSettings";
import {
  getInputKey,
  getModeKey,
  getPendingScopeId,
  getProjectScopeId,
  getThinkingLevelKey,
} from "@/common/constants/storage";
import type { SendMessageError } from "@/common/types/errors";
import type { SendMessageOptions, WorkspaceChatMessage } from "@/common/orpc/types";
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

let currentSendOptions: SendMessageOptions;
const useSendMessageOptionsMock = mock(() => currentSendOptions);

void mock.module("@/browser/hooks/useSendMessageOptions", () => ({
  useSendMessageOptions: useSendMessageOptionsMock,
}));

let currentORPCClient: MockOrpcClient | null = null;
void mock.module("@/browser/orpc/react", () => ({
  useORPC: () => {
    if (!currentORPCClient) {
      throw new Error("ORPC client not initialized");
    }
    return currentORPCClient as ORPCClient;
  },
}));

const TEST_PROJECT_PATH = "/projects/demo";
const FALLBACK_BRANCH = "main";
const TEST_WORKSPACE_ID = "ws-created";
type BranchListResult = Awaited<ReturnType<ORPCClient["projects"]["listBranches"]>>;
type ListBranchesArgs = Parameters<ORPCClient["projects"]["listBranches"]>[0];
type WorkspaceSendMessageArgs = Parameters<ORPCClient["workspace"]["sendMessage"]>[0];
type WorkspaceSendMessageResult = Awaited<ReturnType<ORPCClient["workspace"]["sendMessage"]>>;
type MockOrpcProjectsClient = Pick<ORPCClient["projects"], "listBranches">;
type MockOrpcWorkspaceClient = Pick<ORPCClient["workspace"], "sendMessage">;
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
}
interface SetupWindowOptions {
  listBranches?: ReturnType<typeof mock<(args: ListBranchesArgs) => Promise<BranchListResult>>>;
  sendMessage?: ReturnType<
    typeof mock<(args: WorkspaceSendMessageArgs) => Promise<WorkspaceSendMessageResult>>
  >;
}

const setupWindow = ({ listBranches, sendMessage }: SetupWindowOptions = {}) => {
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
    mock<(args: WorkspaceSendMessageArgs) => Promise<WorkspaceSendMessageResult>>((args) => {
      if (!args.workspaceId && !args.options?.projectPath) {
        return Promise.resolve({
          success: false,
          error: { type: "unknown", raw: "Missing project path" } satisfies SendMessageError,
        });
      }

      if (!args.workspaceId) {
        return Promise.resolve({
          success: true,
          data: {
            workspaceId: TEST_WORKSPACE_ID,
            metadata: TEST_METADATA,
          },
        } satisfies WorkspaceSendMessageResult);
      }

      const existingWorkspaceResult: WorkspaceSendMessageResult = {
        success: true,
        data: {},
      };
      return Promise.resolve(existingWorkspaceResult);
    });

  currentORPCClient = {
    projects: {
      listBranches: (input: ListBranchesArgs) => listBranchesMock(input),
    },
    workspace: {
      sendMessage: (input: WorkspaceSendMessageArgs) => sendMessageMock(input),
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
    workspace: {
      list: rejectNotImplemented("workspace.list"),
      create: rejectNotImplemented("workspace.create"),
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
    platform: "electron",
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
    workspaceApi: { sendMessage: sendMessageMock },
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

  test("handleSend sends message and syncs preferences on success", async () => {
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
          data: {
            workspaceId: TEST_WORKSPACE_ID,
            metadata: TEST_METADATA,
          },
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
    // ORPC uses a single argument object
    const firstCall = workspaceApi.sendMessage.mock.calls[0];
    if (!firstCall) {
      throw new Error("Expected workspace.sendMessage to be called at least once");
    }
    const [request] = firstCall;
    if (!request) {
      throw new Error("sendMessage mock was invoked without arguments");
    }
    const { workspaceId, message, options } = request;
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
    const pendingInputKey = getInputKey(getPendingScopeId(TEST_PROJECT_PATH));
    expect(updatePersistedStateCalls).toContainEqual([modeKey, "plan"]);
    expect(updatePersistedStateCalls).toContainEqual([thinkingKey, "high"]);
    expect(updatePersistedStateCalls).toContainEqual([pendingInputKey, ""]);
  });

  test("handleSend surfaces backend errors and resets state", async () => {
    const sendMessageMock = mock(
      (_args: WorkspaceSendMessageArgs): Promise<WorkspaceSendMessageResult> =>
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
