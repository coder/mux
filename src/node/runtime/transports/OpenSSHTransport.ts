import { spawn } from "child_process";
import { log } from "@/node/services/log";

import { spawnPtyProcess } from "../ptySpawn";
import { expandTildeForSSH } from "../tildeExpansion";
import { appendOpenSSHHostKeyPolicyArgs, type SSHConnectionConfig } from "../sshConnectionPool";
import { openSshMasterPool } from "../openSshMasterPool";
import type { SpawnResult } from "../RemoteRuntime";
import type {
  SSHTransport,
  SSHTransportConfig,
  SpawnOptions,
  PtyHandle,
  PtySessionParams,
} from "./SSHTransport";

const MAX_REPORTED_FAILURE_STDERR_CHARS = 1000;

function summarizeFailureStderr(stderr: string, exitCode: number): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return `SSH exited with code ${exitCode}`;
  }
  if (trimmed.length <= MAX_REPORTED_FAILURE_STDERR_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_REPORTED_FAILURE_STDERR_CHARS)}…`;
}

export class OpenSSHTransport implements SSHTransport {
  constructor(private readonly config: SSHConnectionConfig) {}

  isConnectionFailure(exitCode: number, _stderr: string): boolean {
    return exitCode === 255;
  }

  getConfig(): SSHTransportConfig {
    return this.config;
  }

  async acquireConnection(options?: {
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    maxWaitMs?: number;
    onWait?: (waitMs: number) => void;
  }): Promise<void> {
    await openSshMasterPool.ensureConnection(this.config, {
      abortSignal: options?.abortSignal,
      timeoutMs: options?.timeoutMs,
      maxWaitMs: options?.maxWaitMs,
      onWait: options?.onWait,
    });
  }

  async spawnRemoteProcess(fullCommand: string, options: SpawnOptions): Promise<SpawnResult> {
    const remainingWaitMs =
      options.deadlineMs != null ? Math.max(0, options.deadlineMs - Date.now()) : undefined;
    const lease = await openSshMasterPool.acquireLease(this.config, {
      abortSignal: options.abortSignal,
      timeoutMs: remainingWaitMs,
      maxWaitMs: remainingWaitMs,
    });

    // Note: use -tt (not -t) so PTY allocation works even when stdin is a pipe.
    const sshArgs: string[] = [
      options.forcePTY ? "-tt" : "-T",
      ...this.buildBaseSSHArgs(),
      "-o",
      "ControlMaster=no",
      "-o",
      `ControlPath=${lease.controlPath}`,
    ];

    const connectTimeout =
      options.timeout !== undefined ? Math.min(Math.ceil(options.timeout), 15) : 15;
    sshArgs.push("-o", `ConnectTimeout=${connectTimeout}`);
    sshArgs.push("-o", "ServerAliveInterval=5");
    sshArgs.push("-o", "ServerAliveCountMax=2");
    sshArgs.push("-o", "BatchMode=yes");
    appendOpenSSHHostKeyPolicyArgs(sshArgs);
    sshArgs.push(this.config.host, fullCommand);

    log.debug(`SSH exec on ${this.config.host} via ${lease.shardId}`);
    const process = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let released = false;
    const releaseLease = () => {
      if (released) {
        return;
      }
      released = true;
      lease.release();
    };

    return {
      process,
      onExit: (exitCode, stderr) => {
        if (this.isConnectionFailure(exitCode, stderr)) {
          lease.reportFailure(summarizeFailureStderr(stderr, exitCode));
        } else {
          lease.markHealthy();
        }
      },
      onClose: () => {
        releaseLease();
      },
      onError: (error) => {
        lease.reportFailure(error.message);
        releaseLease();
      },
    };
  }

  async createPtySession(params: PtySessionParams): Promise<PtyHandle> {
    // PTYs stay on a dedicated direct SSH session so they do not consume pooled master
    // capacity reserved for the many short exec/file operations that drive workspace scale.
    // Preflight only needs an already-started master (or to bootstrap one), not a free exec slot.
    await openSshMasterPool.ensureReadyMaster(this.config, { maxWaitMs: 0 });

    const args: string[] = [...this.buildBaseSSHArgs()];
    args.push("-o", "ConnectTimeout=15");
    args.push("-o", "ServerAliveInterval=5");
    args.push("-o", "ServerAliveCountMax=2");
    args.push("-o", "BatchMode=yes");
    appendOpenSSHHostKeyPolicyArgs(args);
    args.push("-t");
    args.push(this.config.host);

    // expandTildeForSSH already returns a quoted string (e.g., "$HOME/path")
    // Do NOT wrap with shellQuotePath - that would double-quote it
    const expandedPath = expandTildeForSSH(params.workspacePath);
    args.push(`cd ${expandedPath} && exec $SHELL -i`);

    return spawnPtyProcess({
      runtimeLabel: "SSH",
      command: "ssh",
      args,
      cwd: process.cwd(),
      cols: params.cols,
      rows: params.rows,
      preferElectronBuild: false,
    });
  }

  private buildBaseSSHArgs(): string[] {
    const args: string[] = [];

    if (this.config.port) {
      args.push("-p", this.config.port.toString());
    }

    if (this.config.identityFile) {
      args.push("-i", this.config.identityFile);
    }

    args.push("-o", "LogLevel=FATAL");
    return args;
  }
}
