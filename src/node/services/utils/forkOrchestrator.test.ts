import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { Config } from "@/node/config";
import type {
  InitLogger,
  Runtime,
  WorkspaceCreationResult,
  WorkspaceForkResult,
} from "@/node/runtime/Runtime";

vi.mock("@/node/services/utils/forkRuntimeUpdates", () => ({
  applyForkRuntimeUpdates: vi.fn(),
}));

vi.mock("@/node/runtime/runtimeFactory", () => ({
  createRuntime: vi.fn(),
}));

vi.mock("@/node/git", () => ({
  listLocalBranches: vi.fn(),
  detectDefaultTrunkBranch: vi.fn(),
}));

const { orchestrateFork } = await import("./forkOrchestrator");
const { applyForkRuntimeUpdates } = await import("@/node/services/utils/forkRuntimeUpdates");
const { createRuntime } = await import("@/node/runtime/runtimeFactory");
const { detectDefaultTrunkBranch, listLocalBranches } = await import("@/node/git");

const applyForkRuntimeUpdatesMock = applyForkRuntimeUpdates as unknown as ReturnType<typeof vi.fn>;
const createRuntimeMock = createRuntime as unknown as ReturnType<typeof vi.fn>;
const detectDefaultTrunkBranchMock = detectDefaultTrunkBranch as unknown as ReturnType<
  typeof vi.fn
>;
const listLocalBranchesMock = listLocalBranches as unknown as ReturnType<typeof vi.fn>;

const PROJECT_PATH = "/projects/demo";
const SOURCE_WORKSPACE_NAME = "feature/source";
const NEW_WORKSPACE_NAME = "feature/new";
const SOURCE_WORKSPACE_ID = "workspace-source";
const SOURCE_RUNTIME_CONFIG: RuntimeConfig = { type: "local" };
const DEFAULT_FORKED_RUNTIME_CONFIG: RuntimeConfig = { type: "docker", image: "node:20" };

function createInitLogger(): InitLogger {
  return {
    logStep: vi.fn(),
    logStdout: vi.fn(),
    logStderr: vi.fn(),
    logComplete: vi.fn(),
  };
}

function createConfig(): Config {
  return {
    updateWorkspaceMetadata: vi.fn(),
  } as unknown as Config;
}

function createSourceRuntimeMocks(): {
  sourceRuntime: Runtime;
  forkWorkspace: ReturnType<typeof vi.fn>;
  createWorkspace: ReturnType<typeof vi.fn>;
} {
  const forkWorkspace = vi.fn();
  const createWorkspace = vi.fn();
  const sourceRuntime = {
    forkWorkspace,
    createWorkspace,
  } as unknown as Runtime;

  return { sourceRuntime, forkWorkspace, createWorkspace };
}

interface RunOrchestrateForkOptions {
  sourceRuntime: Runtime;
  allowCreateFallback: boolean;
  config?: Config;
  sourceRuntimeConfig?: RuntimeConfig;
}

async function runOrchestrateFork(options: RunOrchestrateForkOptions) {
  const config = options.config ?? createConfig();

  return orchestrateFork({
    sourceRuntime: options.sourceRuntime,
    projectPath: PROJECT_PATH,
    sourceWorkspaceName: SOURCE_WORKSPACE_NAME,
    newWorkspaceName: NEW_WORKSPACE_NAME,
    initLogger: createInitLogger(),
    config,
    sourceWorkspaceId: SOURCE_WORKSPACE_ID,
    sourceRuntimeConfig: options.sourceRuntimeConfig ?? SOURCE_RUNTIME_CONFIG,
    allowCreateFallback: options.allowCreateFallback,
  });
}

describe("orchestrateFork", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    applyForkRuntimeUpdatesMock.mockResolvedValue({
      forkedRuntimeConfig: DEFAULT_FORKED_RUNTIME_CONFIG,
    });
    createRuntimeMock.mockReturnValue({ marker: "target-runtime" } as unknown as Runtime);
    listLocalBranchesMock.mockResolvedValue(["main"]);
    detectDefaultTrunkBranchMock.mockResolvedValue("main");
  });

  it("returns Ok with fork metadata when forkWorkspace succeeds", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    const forkResult: WorkspaceForkResult = {
      success: true,
      workspacePath: "/workspaces/forked",
      sourceBranch: "feature/source-branch",
    };
    forkWorkspace.mockResolvedValue(forkResult);

    const targetRuntime = { marker: "fresh-runtime" } as unknown as Runtime;
    createRuntimeMock.mockReturnValue(targetRuntime);
    const config = createConfig();

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: false,
      config,
    });

    expect(result).toEqual({
      success: true,
      data: {
        workspacePath: "/workspaces/forked",
        trunkBranch: "feature/source-branch",
        forkedRuntimeConfig: DEFAULT_FORKED_RUNTIME_CONFIG,
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
      },
    });

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(listLocalBranchesMock).not.toHaveBeenCalled();
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
    expect(applyForkRuntimeUpdatesMock).toHaveBeenCalledWith(
      config,
      SOURCE_WORKSPACE_ID,
      SOURCE_RUNTIME_CONFIG,
      forkResult
    );
    expect(createRuntimeMock).toHaveBeenCalledWith(DEFAULT_FORKED_RUNTIME_CONFIG, {
      projectPath: PROJECT_PATH,
      workspaceName: NEW_WORKSPACE_NAME,
    });
  });

  it("falls back to createWorkspace when fork fails and fallback is allowed", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork failed",
    } satisfies WorkspaceForkResult);
    listLocalBranchesMock.mockResolvedValue(["main", "develop"]);
    detectDefaultTrunkBranchMock.mockResolvedValue("develop");
    createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/created",
    } satisfies WorkspaceCreationResult);

    const targetRuntime = { marker: "runtime-after-create-fallback" } as unknown as Runtime;
    createRuntimeMock.mockReturnValue(targetRuntime);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: PROJECT_PATH,
        branchName: NEW_WORKSPACE_NAME,
        trunkBranch: "develop",
        directoryName: NEW_WORKSPACE_NAME,
      })
    );

    expect(result).toEqual({
      success: true,
      data: {
        workspacePath: "/workspaces/created",
        trunkBranch: "develop",
        forkedRuntimeConfig: DEFAULT_FORKED_RUNTIME_CONFIG,
        targetRuntime,
        forkedFromSource: false,
        sourceRuntimeConfigUpdated: false,
      },
    });

    expect(createRuntimeMock).toHaveBeenCalledWith(DEFAULT_FORKED_RUNTIME_CONFIG, {
      projectPath: PROJECT_PATH,
      workspaceName: NEW_WORKSPACE_NAME,
    });
  });

  it("returns Err immediately when fork fails and fallback is not allowed", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork denied",
    } satisfies WorkspaceForkResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: false,
    });

    expect(result).toEqual({ success: false, error: "fork denied" });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(listLocalBranchesMock).not.toHaveBeenCalled();
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
    expect(createRuntimeMock).not.toHaveBeenCalled();
  });

  it("returns Err for fatal fork failures even when fallback is allowed", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fatal fork failure",
      failureIsFatal: true,
    } satisfies WorkspaceForkResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result).toEqual({ success: false, error: "fatal fork failure" });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(listLocalBranchesMock).not.toHaveBeenCalled();
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
  });

  it("prefers sourceWorkspaceName as trunk branch when listed locally during fallback", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({ success: false } satisfies WorkspaceForkResult);
    listLocalBranchesMock.mockResolvedValue([SOURCE_WORKSPACE_NAME, "main", "develop"]);
    createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/from-source-workspace-branch",
    } satisfies WorkspaceCreationResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          trunkBranch: SOURCE_WORKSPACE_NAME,
          forkedFromSource: false,
        }),
      })
    );
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
  });

  it("falls back to main when trunk branch detection throws", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({ success: false } satisfies WorkspaceForkResult);
    listLocalBranchesMock.mockRejectedValue(new Error("git unavailable"));
    createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/main-fallback",
    } satisfies WorkspaceCreationResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          trunkBranch: "main",
        }),
      })
    );
    expect(detectDefaultTrunkBranchMock).not.toHaveBeenCalled();
  });

  it("marks sourceRuntimeConfigUpdated true when fork result includes source runtime config", async () => {
    const { sourceRuntime, forkWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/forked-with-source-update",
      sourceBranch: "main",
      sourceRuntimeConfig: {
        type: "worktree",
        srcBaseDir: "/tmp/shared-src",
      },
    } satisfies WorkspaceForkResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: false,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          sourceRuntimeConfigUpdated: true,
        }),
      })
    );
  });

  it("uses the runtime config from applyForkRuntimeUpdates when creating target runtime", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork failed",
    } satisfies WorkspaceForkResult);
    createWorkspace.mockResolvedValue({
      success: true,
      workspacePath: "/workspaces/created-with-custom-runtime",
    } satisfies WorkspaceCreationResult);

    const customForkedRuntimeConfig: RuntimeConfig = {
      type: "ssh",
      host: "ssh.example.com",
      srcBaseDir: "~/mux",
    };
    applyForkRuntimeUpdatesMock.mockResolvedValue({
      forkedRuntimeConfig: customForkedRuntimeConfig,
    });

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          forkedRuntimeConfig: customForkedRuntimeConfig,
        }),
      })
    );
    expect(createRuntimeMock).toHaveBeenCalledWith(customForkedRuntimeConfig, {
      projectPath: PROJECT_PATH,
      workspaceName: NEW_WORKSPACE_NAME,
    });
  });

  it("returns Err when create fallback also fails", async () => {
    const { sourceRuntime, forkWorkspace, createWorkspace } = createSourceRuntimeMocks();
    forkWorkspace.mockResolvedValue({
      success: false,
      error: "fork failed",
    } satisfies WorkspaceForkResult);
    createWorkspace.mockResolvedValue({
      success: false,
      error: "create failed",
    } satisfies WorkspaceCreationResult);

    const result = await runOrchestrateFork({
      sourceRuntime,
      allowCreateFallback: true,
    });

    expect(result).toEqual({ success: false, error: "create failed" });
    expect(createRuntimeMock).not.toHaveBeenCalled();
  });
});
