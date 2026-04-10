import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as disposableExec from "@/node/utils/disposableExec";
import type { ExecOptions, ExecStream, InitLogger } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import type { RemoteProjectLayout } from "./remoteProjectLayout";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import type { PtyHandle, PtySessionParams, SSHTransport } from "./transports";

const noop = (): void => undefined;
const noopAsync = (): Promise<void> => Promise.resolve();
const tempDirs: string[] = [];

const noopInitLogger: InitLogger = {
  logStep: noop,
  logStdout: noop,
  logStderr: noop,
  logComplete: noop,
};

function createMockTransport(config: SSHRuntimeConfig): SSHTransport {
  return {
    spawnRemoteProcess() {
      return Promise.reject(new Error("Unexpected transport use in SSHRuntime sync contract test"));
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
      return Promise.reject(new Error("Unexpected PTY creation in SSHRuntime sync contract test"));
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

const discardChunk = (_chunk: Uint8Array): Promise<void> => Promise.resolve();

function createExecStream(stdout: string, stderr = "", exitCode = 0): ExecStream {
  return {
    stdout: createTextStream(stdout),
    stderr: createTextStream(stderr),
    stdin: new WritableStream<Uint8Array>({
      write: discardChunk,
      close: noopAsync,
      abort: noopAsync,
    }),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(0),
  };
}

function createMockExecResult(
  result: Promise<{ stdout: string; stderr: string }>
): ReturnType<typeof disposableExec.execFileAsync> {
  void result.catch(noop);
  return {
    result,
    get promise() {
      return result;
    },
    child: {},
    [Symbol.dispose]: noop,
  } as unknown as ReturnType<typeof disposableExec.execFileAsync>;
}

class CommandCaptureSSHRuntime extends SSHRuntime {
  readonly commands: string[] = [];

  constructor() {
    const config: SSHRuntimeConfig = {
      host: "example.test",
      srcBaseDir: "/remote/src",
    };
    super(config, createMockTransport(config));
  }

  override exec(command: string, _options: ExecOptions): Promise<ExecStream> {
    this.commands.push(command);
    return Promise.resolve(createExecStream(""));
  }
}

interface GitPushPrivateApi {
  syncProjectSnapshotViaGitPush(
    projectPath: string,
    layout: RemoteProjectLayout,
    currentSnapshotPath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void>;
}

interface BundleSyncPrivateApi {
  transferBundleToRemote: (
    projectPath: string,
    remoteBundlePath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ) => Promise<void>;
  syncProjectSnapshotViaBundle(
    projectPath: string,
    layout: RemoteProjectLayout,
    currentSnapshotPath: string,
    snapshotDigest: string,
    baseRepoPathArg: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void>;
}

interface SnapshotPrivateApi {
  computeSnapshotDigest(projectPath: string): Promise<string>;
  resolveLocalSyncRefManifest(projectPath: string): Promise<string | null>;
}

function createLayout(): RemoteProjectLayout {
  return {
    projectId: "project-id",
    projectRoot: "/remote/src/project",
    baseRepoPath: "/remote/src/project/.mux-base.git",
    currentSnapshotPath: "/remote/src/project/.mux-meta/current-snapshot",
  };
}

async function createTempGitRepo(): Promise<string> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "mux-ssh-sync-contract-"));
  tempDirs.push(repoPath);
  execSync(
    [
      `git -C "${repoPath}" init -b main`,
      `git -C "${repoPath}" config user.email "test@test.com"`,
      `git -C "${repoPath}" config user.name "Test"`,
      `sh -c 'printf initial > "${repoPath}/file.txt"'`,
      `git -C "${repoPath}" add file.txt`,
      `git -C "${repoPath}" commit -m "initial"`,
    ].join(" && "),
    { stdio: "pipe" }
  );
  return repoPath;
}

afterEach(async () => {
  mock.restore();
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true }))
  );
});

describe("SSHRuntime authoritative sync contract", () => {
  it("derives snapshot identity from branch refs instead of tag-only drift", async () => {
    const repoPath = await createTempGitRepo();
    const runtime = new CommandCaptureSSHRuntime();
    const privateApi = runtime as unknown as SnapshotPrivateApi;

    const initialDigest = await privateApi.computeSnapshotDigest(repoPath);
    const initialManifest = await privateApi.resolveLocalSyncRefManifest(repoPath);

    execSync(`git -C "${repoPath}" tag v1.0.0`, { stdio: "pipe" });

    expect(await privateApi.computeSnapshotDigest(repoPath)).toBe(initialDigest);
    expect(await privateApi.resolveLocalSyncRefManifest(repoPath)).toBe(initialManifest);

    execSync(`git -C "${repoPath}" branch feature/snapshot-contract`, { stdio: "pipe" });

    expect(await privateApi.computeSnapshotDigest(repoPath)).not.toBe(initialDigest);
    expect(await privateApi.resolveLocalSyncRefManifest(repoPath)).not.toBe(initialManifest);
  });

  it("pushes pruneable bundle branches separately from shared tags", async () => {
    const runtime = new CommandCaptureSSHRuntime();
    const layout = createLayout();
    const gitCalls: string[][] = [];

    spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("git");
      gitCalls.push([...args]);
      const isTagCheck = args.includes("for-each-ref") && args.includes("refs/tags");
      return createMockExecResult(
        Promise.resolve({ stdout: isTagCheck ? "refs/tags/v1.0.0\n" : "", stderr: "" })
      );
    });

    await (runtime as unknown as GitPushPrivateApi).syncProjectSnapshotViaGitPush(
      "/local/project",
      layout,
      layout.currentSnapshotPath,
      noopInitLogger
    );

    const pushCalls = gitCalls.filter((args) => args.includes("push"));
    const tagCheckCalls = gitCalls.filter((args) => args.includes("for-each-ref"));

    expect(pushCalls).toHaveLength(2);
    expect(tagCheckCalls).toHaveLength(1);
    expect(tagCheckCalls[0]).toContain("--count=1");
    expect(tagCheckCalls[0]).toContain("refs/tags");

    expect(pushCalls[0]).toContain("--prune");
    expect(pushCalls[0]).toContain("--atomic");
    expect(pushCalls[0]).toContain("+refs/heads/*:refs/mux-bundle/*");
    expect(pushCalls[0]).not.toContain("+refs/tags/*:refs/tags/*");

    expect(pushCalls[1]).not.toContain("--prune");
    expect(pushCalls[1]).not.toContain("--atomic");
    expect(pushCalls[1]).toContain("+refs/tags/*:refs/tags/*");
    expect(pushCalls[1]).not.toContain("+refs/heads/*:refs/mux-bundle/*");
  });

  it("skips the metadata tag push when the local repo has no tags", async () => {
    const runtime = new CommandCaptureSSHRuntime();
    const layout = createLayout();
    const gitCalls: string[][] = [];

    spyOn(disposableExec, "execFileAsync").mockImplementation((file, args) => {
      expect(file).toBe("git");
      gitCalls.push([...args]);
      return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
    });

    await (runtime as unknown as GitPushPrivateApi).syncProjectSnapshotViaGitPush(
      "/local/project",
      layout,
      layout.currentSnapshotPath,
      noopInitLogger
    );

    const pushCalls = gitCalls.filter((args) => args.includes("push"));
    const tagCheckCalls = gitCalls.filter((args) => args.includes("for-each-ref"));

    expect(pushCalls).toHaveLength(1);
    expect(tagCheckCalls).toHaveLength(1);
    expect(pushCalls[0]).toContain("--prune");
    expect(pushCalls[0]).toContain("--atomic");
    expect(pushCalls[0]).toContain("+refs/heads/*:refs/mux-bundle/*");
    expect(pushCalls[0]).not.toContain("+refs/tags/*:refs/tags/*");
  });

  it("fetches pruneable bundle branches separately from shared tags", async () => {
    const runtime = new CommandCaptureSSHRuntime();
    const layout = createLayout();
    const privateApi = runtime as unknown as BundleSyncPrivateApi;
    privateApi.transferBundleToRemote = () => Promise.resolve();

    await privateApi.syncProjectSnapshotViaBundle(
      "/local/project",
      layout,
      layout.currentSnapshotPath,
      "snapshot-digest",
      '"/remote/src/project/.mux-base.git"',
      noopInitLogger
    );

    const fetchCommands = runtime.commands.filter((command) => command.includes(" fetch "));
    expect(fetchCommands).toHaveLength(2);
    expect(fetchCommands[0]).toContain("fetch --prune");
    expect(fetchCommands[0]).toContain("'+refs/heads/*:refs/mux-bundle/*'");
    expect(fetchCommands[0]).not.toContain("refs/tags");
    expect(fetchCommands[0]).not.toContain("--prune-tags");

    expect(fetchCommands[1]).not.toContain("--prune");
    expect(fetchCommands[1]).toContain("'+refs/tags/*:refs/tags/*'");
    expect(fetchCommands[1]).not.toContain("refs/heads/*:refs/mux-bundle/*");
  });
});
