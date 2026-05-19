import { describe, expect, it } from "bun:test";
import type { ExecOptions, ExecStream, InitLogger, WorkspaceInitParams } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import type { RemoteProjectLayout } from "./remoteProjectLayout";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import type { PtyHandle, PtySessionParams, SSHTransport } from "./transports";

const noop = (): void => undefined;

const noopInitLogger: InitLogger = {
  logStep: noop,
  logStdout: noop,
  logStderr: noop,
  logComplete: noop,
};

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface SyncAction {
  label: string;
  error?: Error;
  abortController?: AbortController;
}

function createDeferred(): Deferred {
  let resolve: () => void = noop;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createMockTransport(config: SSHRuntimeConfig): SSHTransport {
  return {
    spawnRemoteProcess() {
      return Promise.reject(new Error("Unexpected transport use in SSHRuntime retry test"));
    },
    isConnectionFailure() {
      return false;
    },
    acquireConnection() {
      return Promise.resolve();
    },
    getConfig() {
      return config;
    },
    createPtySession(_params: PtySessionParams): Promise<PtyHandle> {
      return Promise.reject(new Error("Unexpected PTY creation in SSHRuntime retry test"));
    },
  };
}

function createTextStream(text: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (encoded.byteLength > 0) {
        controller.enqueue(encoded);
      }
      controller.close();
    },
  });
}

const resolveVoid = (): Promise<void> => Promise.resolve();
const discardChunk = (_chunk: Uint8Array): Promise<void> => Promise.resolve();

function createExecStream(stdout: string, stderr = "", exitCode = 0): ExecStream {
  return {
    stdout: createTextStream(stdout),
    stderr: createTextStream(stderr),
    stdin: new WritableStream<Uint8Array>({
      write: discardChunk,
      close: resolveVoid,
      abort: resolveVoid,
    }),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(0),
  };
}

class TestSSHRuntime extends SSHRuntime {
  readonly callOrder: string[] = [];
  readonly cleanupCalls: string[] = [];
  readonly backoffCalls: number[] = [];

  private readonly actions: SyncAction[] = [];
  private cleanupHook?: () => Promise<void>;

  constructor() {
    const config: SSHRuntimeConfig = {
      host: "example.test",
      srcBaseDir: "/remote/src",
    };
    super(config, createMockTransport(config));
  }

  queueActions(...actions: SyncAction[]): void {
    this.actions.push(...actions);
  }

  setCleanupHook(cleanupHook?: () => Promise<void>): void {
    this.cleanupHook = cleanupHook;
  }

  async runSync(projectPath: string, abortSignal?: AbortSignal): Promise<void> {
    await this.syncProjectToRemote(projectPath, noopInitLogger, abortSignal);
  }

  protected override syncProjectToRemoteOnce(
    _projectPath: string,
    _layout: RemoteProjectLayout,
    _initLogger: InitLogger,
    _abortSignal?: AbortSignal
  ): Promise<void> {
    const action = this.actions.shift();
    if (!action) {
      return Promise.reject(new Error("Missing sync action"));
    }

    this.callOrder.push(action.label);
    action.abortController?.abort();
    if (action.error) {
      return Promise.reject(action.error);
    }
    return Promise.resolve();
  }

  protected override async cleanupRetryableProjectSyncFailure(
    baseRepoPathArg: string,
    _attempt: number,
    _maxAttempts: number,
    _abortSignal?: AbortSignal
  ): Promise<void> {
    this.cleanupCalls.push(baseRepoPathArg);
    await this.cleanupHook?.();
  }

  protected override waitForProjectSyncRetryDelay(
    ms: number,
    abortSignal?: AbortSignal
  ): Promise<void> {
    this.backoffCalls.push(ms);
    if (abortSignal?.aborted) {
      return Promise.reject(new Error("Operation aborted"));
    }
    return Promise.resolve();
  }
}

class CleanupCommandSSHRuntime extends SSHRuntime {
  readonly commands: string[] = [];
  readonly timeouts: number[] = [];
  readonly steps: string[] = [];

  countObjectsStdout = "count: 0\npacks: 0\n";
  countObjectsStderr = "";
  countObjectsExitCode = 0;
  tmpCleanupStdout = "";
  promisorStdout = "/remote/src/project/.mux-base.git/objects/pack/pack-a.promisor\n";
  gcStdout = "";
  gcStderr = "";
  gcExitCode = 0;

  constructor() {
    const config: SSHRuntimeConfig = {
      host: "example.test",
      srcBaseDir: "/remote/src",
    };
    super(config, createMockTransport(config));
  }

  async runCleanup(baseRepoPathArg: string, abortSignal?: AbortSignal): Promise<void> {
    await this.cleanupRetryableProjectSyncFailure(baseRepoPathArg, 1, 3, abortSignal);
  }

  async runEnsureHealthy(baseRepoPathArg: string, abortSignal?: AbortSignal): Promise<void> {
    await this.ensureHealthyBaseRepoForSync(
      baseRepoPathArg,
      {
        ...noopInitLogger,
        logStep: (step) => {
          this.steps.push(step);
        },
      },
      abortSignal
    );
  }

  async runPartialCleanup(
    projectPath: string,
    workspaceName: string,
    workspacePath: string,
    trusted?: boolean
  ): Promise<void> {
    await this.cleanupPartialWorkspaceState({
      projectPath,
      workspaceName,
      workspacePath,
      reason: "test cleanup",
      trusted,
    });
  }

  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    this.commands.push(command);
    this.timeouts.push(options.timeout ?? -1);

    if (command.includes("count-objects -v")) {
      return Promise.resolve(
        createExecStream(
          this.countObjectsStdout,
          this.countObjectsStderr,
          this.countObjectsExitCode
        )
      );
    }
    if (command.startsWith("pack_dir=")) {
      return Promise.resolve(createExecStream(this.tmpCleanupStdout));
    }
    if (command.startsWith("find ")) {
      return Promise.resolve(createExecStream(this.promisorStdout));
    }
    if (command.includes(" gc --prune=now")) {
      return Promise.resolve(createExecStream(this.gcStdout, this.gcStderr, this.gcExitCode));
    }
    return Promise.resolve(createExecStream(""));
  }
}

class InitMaterializationSSHRuntime extends SSHRuntime {
  readonly commands: string[] = [];
  worktreeAddExitCode = 0;
  worktreeAddStderr = "";
  gitmodulesPresent = false;
  submoduleUpdateExitCode = 0;

  constructor() {
    const config: SSHRuntimeConfig = {
      host: "example.test",
      srcBaseDir: "/remote/src",
    };
    super(config, createMockTransport(config));
  }

  protected override syncProjectToRemote(
    _projectPath: string,
    _initLogger: InitLogger,
    _abortSignal?: AbortSignal
  ): Promise<void> {
    return Promise.resolve();
  }

  createInitParams(workspaceName: string): WorkspaceInitParams {
    return {
      projectPath: "/local/project",
      branchName: workspaceName,
      trunkBranch: "main",
      workspacePath: `/remote/src/project/${workspaceName}`,
      initLogger: noopInitLogger,
      trusted: true,
    };
  }

  override exec(command: string, _options: ExecOptions): Promise<ExecStream> {
    this.commands.push(command);

    if (command.includes("STATUS_CREATED=")) {
      return Promise.resolve(createExecStream("STATUS_CREATED=existed\nSTATUS_CORE_BARE=absent\n"));
    }
    if (command.startsWith("test -d ")) {
      return Promise.resolve(createExecStream("", "", 1));
    }
    if (command.includes(" fetch origin ")) {
      return Promise.resolve(createExecStream("", "origin unavailable", 1));
    }
    if (command.includes("rev-parse --verify 'refs/mux-bundle/main'")) {
      return Promise.resolve(createExecStream("refs/mux-bundle/main\n"));
    }
    if (command.includes(" worktree add ")) {
      return Promise.resolve(
        createExecStream("", this.worktreeAddStderr, this.worktreeAddExitCode)
      );
    }
    if (command.startsWith("pack_dir=")) {
      return Promise.resolve(createExecStream(""));
    }
    if (command.includes("worktree prune")) {
      return Promise.resolve(createExecStream(""));
    }
    if (command.startsWith("if [ -f .gitmodules ]")) {
      return this.gitmodulesPresent
        ? Promise.resolve(createExecStream("present"))
        : Promise.resolve(createExecStream("missing", "", 2));
    }
    if (command === "git submodule sync --recursive") {
      return Promise.resolve(createExecStream(""));
    }
    if (command === "git submodule update --init --recursive") {
      return Promise.resolve(
        createExecStream("", "submodule update failed", this.submoduleUpdateExitCode)
      );
    }

    return Promise.resolve(createExecStream(""));
  }
}

function expectCommandMatching(
  commands: string[],
  predicate: (command: string) => boolean
): number {
  const index = commands.findIndex(predicate);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function isTmpPackCleanupCommand(command: string): boolean {
  return command.startsWith("pack_dir=") && command.includes("tmp_pack_*");
}

// Single-line shell pipeline that strips partial-clone config from a shared
// bare base repo. The exact text is asserted in tests because order matters:
// the strip must precede the on-disk `.promisor` marker cleanup so that even
// a half-completed repair leaves the repo non-promisor (and therefore safe
// from the upstream `check_connected()` sideband deadlock — see the doc
// comment on `stripBaseRepoPromisorConfig` in SSHRuntime.ts).
function isHealthProbeCommand(command: string): boolean {
  return command.includes("count-objects -v") && command.includes("MUX_HEALTH_TMP_PACK_COUNT");
}

function expectMaintenanceCommands(
  runtime: { commands: string[]; timeouts: number[] },
  baseRepoPathArg: string
): void {
  const stripIndex = runtime.commands.indexOf(expectedStripPromisorCommand(baseRepoPathArg));
  const tmpCleanupIndex = expectCommandMatching(runtime.commands, isTmpPackCleanupCommand);
  const promisorCleanupIndex = runtime.commands.indexOf(
    `find ${baseRepoPathArg}/objects/pack -name '*.promisor' -print -delete 2>/dev/null || true`
  );
  const gcIndex = runtime.commands.indexOf(`git -C ${baseRepoPathArg} gc --prune=now`);

  expect(stripIndex).toBeGreaterThanOrEqual(0);
  expect(stripIndex).toBeLessThan(tmpCleanupIndex);
  expect(tmpCleanupIndex).toBeLessThan(promisorCleanupIndex);
  expect(promisorCleanupIndex).toBeLessThan(gcIndex);
  expect(runtime.timeouts[stripIndex]).toBe(10);
  expect(runtime.timeouts[tmpCleanupIndex]).toBe(10);
  expect(runtime.timeouts[promisorCleanupIndex]).toBe(10);
  expect(runtime.timeouts[gcIndex]).toBe(120);
}

function expectedStripPromisorCommand(baseRepoPathArg: string): string {
  return (
    `git -C ${baseRepoPathArg} config --unset-all remote.origin.promisor; ` +
    `git -C ${baseRepoPathArg} config --unset-all remote.origin.partialclonefilter; ` +
    `git -C ${baseRepoPathArg} config --unset-all extensions.partialclone; ` +
    `true`
  );
}

describe("SSHRuntime project sync retry orchestration", () => {
  it("strips legacy partial-clone keys before any on-disk maintenance", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';

    await runtime.runCleanup(baseRepoPathArg);

    const stripIndex = runtime.commands.indexOf(expectedStripPromisorCommand(baseRepoPathArg));
    expect(stripIndex).toBeGreaterThanOrEqual(0);
    expect(stripIndex).toBeLessThan(
      expectCommandMatching(runtime.commands, isTmpPackCleanupCommand)
    );
    expect(stripIndex).toBeLessThan(
      expectCommandMatching(runtime.commands, (command) => command.startsWith("find "))
    );
    expect(stripIndex).toBeLessThan(
      expectCommandMatching(runtime.commands, (command) => command.includes(" gc --prune=now"))
    );
    expect(runtime.timeouts[stripIndex]).toBe(10);
  });

  it("removes stale promisor markers before running git gc", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';

    await runtime.runCleanup(baseRepoPathArg);

    const tmpCleanupIndex = expectCommandMatching(runtime.commands, isTmpPackCleanupCommand);
    const promisorCleanupIndex = runtime.commands.indexOf(
      `find ${baseRepoPathArg}/objects/pack -name '*.promisor' -print -delete 2>/dev/null || true`
    );
    const gcIndex = runtime.commands.indexOf(`git -C ${baseRepoPathArg} gc --prune=now`);

    expect(promisorCleanupIndex).toBeGreaterThan(tmpCleanupIndex);
    expect(gcIndex).toBeGreaterThan(promisorCleanupIndex);
    expect(runtime.timeouts[tmpCleanupIndex]).toBe(10);
    expect(runtime.timeouts[promisorCleanupIndex]).toBe(10);
    expect(runtime.timeouts[gcIndex]).toBe(120);
  });

  it("proactively repairs fragmented base repos before sync", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    runtime.countObjectsStdout = "count: 0\npacks: 50\n";

    await runtime.runEnsureHealthy(baseRepoPathArg);

    expect(runtime.steps).toHaveLength(1);
    expect(runtime.steps[0]).toContain("50 pack files");
    expect(runtime.steps[0]).toContain("running maintenance before sync");
    expect(isHealthProbeCommand(runtime.commands[0] ?? "")).toBe(true);
    expectMaintenanceCommands(runtime, baseRepoPathArg);
  });

  it("proactively repairs base repos with stale tmp packs before sync", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    runtime.countObjectsStdout = [
      "count: 0",
      "packs: 5",
      "size-pack: 10",
      "MUX_HEALTH_TMP_PACK_COUNT=3",
      "MUX_HEALTH_TMP_PACK_BYTES=4096",
      "MUX_HEALTH_STALE_TMP_PACK_COUNT=2",
      "MUX_HEALTH_STALE_TMP_PACK_BYTES=2048",
      "MUX_HEALTH_FREE_BYTES=9999999999",
      "",
    ].join("\n");
    runtime.tmpCleanupStdout = "1024\t/tmp/tmp_pack_a\n1024\t/tmp/tmp_idx_a\n";

    await runtime.runEnsureHealthy(baseRepoPathArg);

    expect(runtime.steps).toHaveLength(1);
    expect(runtime.steps[0]).toContain("2 stale tmp packs");
    expect(isHealthProbeCommand(runtime.commands[0] ?? "")).toBe(true);
    expectMaintenanceCommands(runtime, baseRepoPathArg);
  });

  it("skips proactive maintenance for healthy base repos", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    runtime.countObjectsStdout = "count: 0\npacks: 5\n";

    await runtime.runEnsureHealthy(baseRepoPathArg);

    expect(runtime.steps).toEqual([]);
    expect(runtime.commands).toHaveLength(1);
    expect(isHealthProbeCommand(runtime.commands[0] ?? "")).toBe(true);
    expect(runtime.timeouts).toEqual([10]);
  });

  it("treats base repo health probe failures as best-effort", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    runtime.countObjectsExitCode = 128;
    runtime.countObjectsStderr = "fatal: not a git repository";

    await runtime.runEnsureHealthy(baseRepoPathArg);

    expect(runtime.steps).toEqual([]);
    expect(runtime.commands).toHaveLength(1);
    expect(isHealthProbeCommand(runtime.commands[0] ?? "")).toBe(true);
    expect(runtime.timeouts).toEqual([10]);
  });

  it("keeps proactive maintenance best-effort when git gc exits non-zero", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    runtime.countObjectsStdout = "count: 0\npacks: 50\n";
    runtime.gcExitCode = 1;
    runtime.gcStderr = "warning: gc skipped";

    await runtime.runEnsureHealthy(baseRepoPathArg);

    expect(runtime.steps).toHaveLength(1);
    expect(runtime.steps[0]).toContain("50 pack files");
    expect(runtime.steps[0]).toContain("running maintenance before sync");
    expect(isHealthProbeCommand(runtime.commands[0] ?? "")).toBe(true);
    expectMaintenanceCommands(runtime, baseRepoPathArg);
  });

  it("cleans partial SSH workspace state when materialization cleanup is requested", async () => {
    const runtime = new CleanupCommandSSHRuntime();

    await runtime.runPartialCleanup(
      "/local/project",
      "feature-cancelled",
      "/remote/src/project/feature-cancelled",
      true
    );

    expectCommandMatching(runtime.commands, isTmpPackCleanupCommand);
    const cleanupCommand = runtime.commands.find(
      (command) => command.includes("worktree prune") && command.includes("rm -rf")
    );
    expect(cleanupCommand).toBeDefined();
    expect(cleanupCommand ?? "").toContain("branch -D -- 'feature-cancelled'");
    expect(cleanupCommand ?? "").toContain('rm -rf "/remote/src/project/feature-cancelled"');
  });

  it("cleans only partial state when slow worktree materialization fails", async () => {
    const runtime = new InitMaterializationSSHRuntime();
    runtime.worktreeAddExitCode = 1;
    runtime.worktreeAddStderr = "fatal: worktree add failed";

    const result = await runtime.initWorkspace(runtime.createInitParams("feature-materialize"));

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("Failed to create worktree");
    expectCommandMatching(runtime.commands, isTmpPackCleanupCommand);
    const cleanupCommand = runtime.commands.find(
      (command) => command.includes("worktree prune") && command.includes("rm -rf")
    );
    expect(cleanupCommand).toBeDefined();
    expect(cleanupCommand ?? "").toContain("branch -D -- 'feature-materialize'");
    expect(cleanupCommand ?? "").toContain('rm -rf "/remote/src/project/feature-materialize"');
  });

  it("preserves materialized workspaces when submodule initialization fails", async () => {
    const runtime = new InitMaterializationSSHRuntime();
    runtime.gitmodulesPresent = true;
    runtime.submoduleUpdateExitCode = 1;

    const result = await runtime.initWorkspace(runtime.createInitParams("feature-submodule"));

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("Failed to initialize git submodules");
    expect(runtime.commands.some(isTmpPackCleanupCommand)).toBe(false);
    expect(
      runtime.commands.some(
        (command) => command.includes("worktree prune") && command.includes("rm -rf")
      )
    ).toBe(false);
  });

  it("propagates aborts during proactive maintenance preflight", async () => {
    const runtime = new CleanupCommandSSHRuntime();
    const baseRepoPathArg = '"/remote/src/project/.mux-base.git"';
    const abortController = new AbortController();
    abortController.abort();

    let failure: unknown;
    try {
      await runtime.runEnsureHealthy(baseRepoPathArg, abortController.signal);
      throw new Error("Expected preflight maintenance to stop when aborted");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected aborted preflight maintenance to throw an Error");
    }
    expect(failure.message).toBe("Operation aborted");
    expect(runtime.commands).toEqual([]);
    expect(runtime.timeouts).toEqual([]);
  });

  it("skips cleanup and backoff when a retryable failure was user-aborted", async () => {
    const runtime = new TestSSHRuntime();
    const abortController = new AbortController();
    const projectPath = `/tmp/abort-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    runtime.queueActions({
      label: "attempt-1",
      abortController,
      error: new Error("Failed to push to remote: Command killed by signal SIGTERM"),
    });

    let failure: unknown;
    try {
      await runtime.runSync(projectPath, abortController.signal);
      throw new Error("Expected sync to fail after the abort-driven push kill");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected sync failure to surface as an Error");
    }
    expect(failure.message).toContain("Command killed by signal SIGTERM");
    expect(runtime.callOrder).toEqual(["attempt-1"]);
    expect(runtime.cleanupCalls).toEqual([]);
    expect(runtime.backoffCalls).toEqual([]);
  });

  it("keeps retry cleanup serialized with later syncs for the same project", async () => {
    const runtime = new TestSSHRuntime();
    const projectPath = `/tmp/serialized-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const cleanupEntered = createDeferred();
    const releaseCleanup = createDeferred();

    runtime.queueActions(
      {
        label: "first-1",
        error: new Error("Failed to push to remote: Command killed by signal SIGTERM"),
      },
      { label: "first-2" },
      { label: "second-1" }
    );
    runtime.setCleanupHook(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    });

    const firstSync = runtime.runSync(projectPath);
    await cleanupEntered.promise;

    const secondSync = runtime.runSync(projectPath);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.callOrder).toEqual(["first-1"]);

    releaseCleanup.resolve();
    await firstSync;
    await secondSync;

    expect(runtime.callOrder).toEqual(["first-1", "first-2", "second-1"]);
    expect(runtime.cleanupCalls).toHaveLength(1);
    expect(runtime.backoffCalls).toEqual([1000]);
  });
});
