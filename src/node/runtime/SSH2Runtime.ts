/**
 * SSH2 runtime implementation that executes commands and file operations
 * over SSH using the ssh2 client library.
 */

import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { Client, ClientChannel } from "ssh2";
import { RuntimeError as RuntimeErrorClass, type ExecOptions, type InitLogger } from "./Runtime";
import type { SpawnResult } from "./RemoteRuntime";
import { SSHRuntime, type SSHRuntimeConfig } from "./SSHRuntime";
import { ssh2ConnectionPool } from "./SSH2ConnectionPool";
import { syncProjectViaGitBundle } from "./gitBundleSync";
import { streamProcessToLogger } from "./streamProcess";
import { shescape, streamToString } from "./streamUtils";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";

function logSSHBackoffWait(initLogger: InitLogger, waitMs: number): void {
  const secs = Math.max(1, Math.ceil(waitMs / 1000));
  initLogger.logStep(`SSH unavailable; retrying in ${secs}s...`);
}

/** Truncate SSH stderr for error logging (keep first line, max 200 chars) */
function truncateSSHError(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "exit code 255";
  const firstLine = trimmed.split("\n")[0];
  if (firstLine.length <= 200) return firstLine;
  return firstLine.slice(0, 197) + "...";
}

class SSH2ChildProcess extends EventEmitter {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly stdin: NodeJS.WritableStream;

  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  pid = 0;

  constructor(private readonly channel: ClientChannel) {
    super();

    // Pipe channel through PassThrough streams to fix EOF handling.
    // Readable.toWeb() on a Duplex doesn't properly signal EOF when only
    // the readable side ends - it waits for the writable side too.
    // PassThrough (a Transform) correctly propagates EOF to web streams.
    const stdoutPipe = new PassThrough();
    const stderrPipe = new PassThrough();
    const stdinPipe = new PassThrough();

    channel.pipe(stdoutPipe);
    (channel.stderr ?? new PassThrough()).pipe(stderrPipe);
    stdinPipe.pipe(channel);

    this.stdout = stdoutPipe;
    this.stderr = stderrPipe;
    this.stdin = stdinPipe;

    channel.on("exit", (code: number | null, signal: string | null) => {
      this.exitCode = typeof code === "number" ? code : null;
      this.signalCode = typeof signal === "string" ? signal : null;
    });

    channel.on("close", () => {
      this.emit("close", this.exitCode ?? 0, this.signalCode);
    });

    channel.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  kill(signal?: string): boolean {
    this.killed = true;
    try {
      if (signal && typeof this.channel.signal === "function") {
        this.channel.signal(signal);
      }
    } catch {
      // Ignore signal errors.
    }

    try {
      this.channel.close();
    } catch {
      // Ignore close errors.
    }

    return true;
  }
}

async function pipeReadableToWebWritable(
  readable: NodeJS.ReadableStream | null | undefined,
  writable: WritableStream<Uint8Array>,
  abortSignal?: AbortSignal
): Promise<void> {
  if (!readable) {
    throw new Error("Missing git bundle output stream");
  }

  const writer = writable.getWriter();
  try {
    for await (const chunk of readable) {
      if (abortSignal?.aborted) {
        throw new Error("Bundle creation aborted");
      }
      const data =
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : chunk instanceof Uint8Array
            ? chunk
            : Buffer.from(chunk);
      await writer.write(data);
    }
    await writer.close();
  } catch (error) {
    try {
      await writer.abort(error);
    } catch {
      writer.releaseLock();
    }
    throw error;
  }
}

async function waitForProcessExit(proc: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.on("close", (code) => resolve(code ?? 0));
    proc.on("error", (err) => reject(err));
  });
}

export class SSH2Runtime extends SSHRuntime {
  protected readonly commandPrefix = "SSH2";

  constructor(config: SSHRuntimeConfig) {
    super(config);
  }

  protected override onExitCode(exitCode: number, _options: ExecOptions, stderr: string): void {
    if (exitCode === 255) {
      ssh2ConnectionPool.reportFailure(this.getConfig(), truncateSSHError(stderr));
    } else {
      ssh2ConnectionPool.markHealthy(this.getConfig());
    }
  }

  protected override async spawnRemoteProcess(
    fullCommand: string,
    options: ExecOptions
  ): Promise<SpawnResult> {
    const connectTimeoutSec =
      options.timeout !== undefined ? Math.min(Math.ceil(options.timeout), 15) : 15;

    let client: Client;
    try {
      ({ client } = await ssh2ConnectionPool.acquireConnection(this.getConfig(), {
        abortSignal: options.abortSignal,
        timeoutMs: connectTimeoutSec * 1000,
      }));
    } catch (error) {
      throw new RuntimeErrorClass(
        `SSH2 connection failed: ${getErrorMessage(error)}`,
        "network",
        error instanceof Error ? error : undefined
      );
    }

    try {
      const channel = await new Promise<ClientChannel>((resolve, reject) => {
        const onExec = (err?: Error, stream?: ClientChannel) => {
          if (err) {
            reject(err);
            return;
          }
          if (!stream) {
            reject(new Error("SSH2 exec did not return a stream"));
            return;
          }
          resolve(stream);
        };

        if (options.forcePTY) {
          client.exec(fullCommand, { pty: { term: "xterm-256color" } }, onExec);
        } else {
          client.exec(fullCommand, onExec);
        }
      });

      channel.on("error", (err: Error) => {
        ssh2ConnectionPool.reportFailure(this.getConfig(), getErrorMessage(err));
      });

      const process = new SSH2ChildProcess(channel) as unknown as ChildProcess;
      return { process };
    } catch (error) {
      ssh2ConnectionPool.reportFailure(this.getConfig(), getErrorMessage(error));
      throw new RuntimeErrorClass(
        `SSH2 command failed: ${getErrorMessage(error)}`,
        "network",
        error instanceof Error ? error : undefined
      );
    }
  }

  override async resolvePath(filePath: string): Promise<string> {
    const script = [
      `p=${shescape.quote(filePath)}`,
      'if [ "$p" = "~" ]; then',
      '  echo "$HOME"',
      'elif [ "${p#\\~/}" != "$p" ]; then',
      '  echo "$HOME/${p#\\~/}"',
      'elif [ "${p#/}" != "$p" ]; then',
      '  echo "$p"',
      "else",
      '  echo "$PWD/$p"',
      "fi",
    ].join("\n");

    const command = `bash -lc ${shescape.quote(script)}`;

    const result = await execBuffered(this, command, { cwd: "/tmp", timeout: 10 });
    if (result.exitCode !== 0) {
      const message = result.stderr || result.stdout || "Unknown error";
      throw new Error(`Failed to resolve SSH path: ${message}`);
    }

    return result.stdout.trim();
  }

  protected override async syncProjectToRemote(
    projectPath: string,
    workspacePath: string,
    initLogger: InitLogger,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const timestamp = Date.now();
    const remoteBundlePath = `~/.mux-bundle-${timestamp}.bundle`;

    await syncProjectViaGitBundle({
      projectPath,
      workspacePath,
      remoteTmpDir: "~",
      remoteBundlePath,
      exec: (command, options) => this.exec(command, options),
      quoteRemotePath: (path) => this.quoteForRemote(path),
      logOriginErrors: true,
      initLogger,
      abortSignal,
      cloneStep: "Cloning repository on remote...",
      createRemoteBundle: async ({ remoteBundlePath, initLogger, abortSignal }) => {
        await ssh2ConnectionPool.acquireConnection(this.getConfig(), {
          abortSignal,
          onWait: (waitMs) => logSSHBackoffWait(initLogger, waitMs),
        });

        if (abortSignal?.aborted) {
          throw new Error("Bundle creation aborted");
        }

        const gitProc = spawn("git", ["-C", projectPath, "bundle", "create", "-", "--all"], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        const cleanup = streamProcessToLogger(gitProc, initLogger, {
          logStdout: false,
          logStderr: true,
          abortSignal,
        });

        let stderr = "";
        gitProc.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        const remoteStream = await this.exec(`cat > ${this.quoteForRemote(remoteBundlePath)}`, {
          cwd: "~",
          timeout: 300,
          abortSignal,
        });

        try {
          await pipeReadableToWebWritable(gitProc.stdout, remoteStream.stdin, abortSignal);
        } catch (error) {
          gitProc.kill();
          cleanup();
          throw error;
        }

        const [gitExitCode, remoteExitCode] = await Promise.all([
          waitForProcessExit(gitProc),
          remoteStream.exitCode,
        ]);

        cleanup();

        if (abortSignal?.aborted) {
          throw new Error("Bundle creation aborted");
        }

        if (gitExitCode !== 0) {
          throw new Error(`Failed to create bundle: ${stderr}`);
        }

        if (remoteExitCode !== 0) {
          const remoteStderr = await streamToString(remoteStream.stderr);
          throw new Error(`Failed to upload bundle: ${remoteStderr}`);
        }
      },
    });
  }
}
