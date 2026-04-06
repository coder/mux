import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";

import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { RemoteRuntime, type SpawnResult } from "./RemoteRuntime";
import type {
  ExecOptions,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
} from "./Runtime";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(_signal?: string): boolean {
    return true;
  }
}

class TestRemoteRuntime extends RemoteRuntime {
  protected readonly commandPrefix = "Test";

  constructor(
    private readonly childProcess: FakeChildProcess,
    private readonly onExitCalls: Array<[number, string]>,
    private readonly onCloseCalls: number[]
  ) {
    super();
  }

  protected spawnRemoteProcess(
    _fullCommand: string,
    _options: ExecOptions & { deadlineMs?: number }
  ): Promise<SpawnResult> {
    return Promise.resolve({
      process: this.childProcess as never,
      onExit: (exitCode, stderr) => {
        this.onExitCalls.push([exitCode, stderr]);
      },
      onClose: () => {
        this.onCloseCalls.push(1);
      },
    });
  }

  protected getBasePath(): string {
    return "/tmp";
  }

  protected quoteForRemote(targetPath: string): string {
    return targetPath;
  }

  protected cdCommand(cwd: string): string {
    return `cd ${cwd}`;
  }

  resolvePath(targetPath: string): Promise<string> {
    return Promise.resolve(targetPath);
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    return `${projectPath}/${workspaceName}`;
  }

  createWorkspace(_params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    throw new Error("unused in test");
  }

  initWorkspace(_params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    throw new Error("unused in test");
  }

  renameWorkspace(): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    throw new Error("unused in test");
  }

  deleteWorkspace(): Promise<
    { success: true; deletedPath: string } | { success: false; error: string }
  > {
    throw new Error("unused in test");
  }

  forkWorkspace(_params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    throw new Error("unused in test");
  }
}

describe("RemoteRuntime synthetic exit handling", () => {
  test("does not forward aborted exits to transport onExit hooks", async () => {
    const childProcess = new FakeChildProcess();
    const onExitCalls: Array<[number, string]> = [];
    const onCloseCalls: number[] = [];
    const runtime = new TestRemoteRuntime(childProcess, onExitCalls, onCloseCalls);
    const controller = new AbortController();

    const stream = await runtime.exec("echo ok", { cwd: "/tmp", abortSignal: controller.signal });
    controller.abort();
    childProcess.emit("close", 0, null);

    expect(await stream.exitCode).toBe(EXIT_CODE_ABORTED);
    expect(onExitCalls).toEqual([]);
    expect(onCloseCalls).toEqual([1]);
  });

  test("does not forward timed-out exits to transport onExit hooks", async () => {
    const childProcess = new FakeChildProcess();
    const onExitCalls: Array<[number, string]> = [];
    const onCloseCalls: number[] = [];
    const runtime = new TestRemoteRuntime(childProcess, onExitCalls, onCloseCalls);

    const stream = await runtime.exec("echo ok", { cwd: "/tmp", timeout: 0.01 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    childProcess.emit("close", 0, null);

    expect(await stream.exitCode).toBe(EXIT_CODE_TIMEOUT);
    expect(onExitCalls).toEqual([]);
    expect(onCloseCalls).toEqual([1]);
  });
});
