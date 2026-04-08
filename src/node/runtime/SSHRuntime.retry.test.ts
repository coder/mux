import { describe, expect, it } from "bun:test";
import type { InitLogger } from "./Runtime";
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

describe("SSHRuntime project sync retry orchestration", () => {
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
