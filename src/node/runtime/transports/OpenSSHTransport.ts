import { spawn } from "child_process";
import { log } from "@/node/services/log";

import { spawnPtyProcess } from "../ptySpawn";
import { expandTildeForSSH } from "../tildeExpansion";
import { getControlPath, sshConnectionPool, type SSHConnectionConfig } from "../sshConnectionPool";
import type { SpawnResult } from "../RemoteRuntime";
import type {
  SSHTransport,
  SSHTransportConfig,
  SpawnOptions,
  PtyHandle,
  PtySessionParams,
} from "./SSHTransport";

export class OpenSSHTransport implements SSHTransport {
  private readonly config: SSHConnectionConfig;
  private readonly controlPath: string;

  constructor(config: SSHConnectionConfig) {
    this.config = config;
    this.controlPath = getControlPath(config);
  }

  isConnectionFailure(exitCode: number, _stderr: string): boolean {
    return exitCode === 255;
  }

  getConfig(): SSHTransportConfig {
    return this.config;
  }

  markHealthy(): void {
    sshConnectionPool.markHealthy(this.config);
  }

  reportFailure(error: string): void {
    sshConnectionPool.reportFailure(this.config, error);
  }

  async acquireConnection(options?: {
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    onWait?: (waitMs: number) => void;
  }): Promise<void> {
    await sshConnectionPool.acquireConnection(this.config, {
      abortSignal: options?.abortSignal,
      timeoutMs: options?.timeoutMs,
      onWait: options?.onWait,
    });
  }

  async spawnRemoteProcess(fullCommand: string, options: SpawnOptions): Promise<SpawnResult> {
    await sshConnectionPool.acquireConnection(this.config, {
      abortSignal: options.abortSignal,
    });

    const sshArgs: string[] = [options.forcePTY ? "-t" : "-T", ...this.buildSSHArgs()];

    const connectTimeout =
      options.timeout !== undefined ? Math.min(Math.ceil(options.timeout), 15) : 15;
    sshArgs.push("-o", `ConnectTimeout=${connectTimeout}`);
    sshArgs.push("-o", "ServerAliveInterval=5");
    sshArgs.push("-o", "ServerAliveCountMax=2");

    sshArgs.push(this.config.host, fullCommand);

    log.debug(`SSH exec on ${this.config.host}`);
    const process = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    return { process };
  }

  async createPtySession(params: PtySessionParams): Promise<PtyHandle> {
    await sshConnectionPool.acquireConnection(this.config, { maxWaitMs: 0 });

    const args: string[] = [...this.buildSSHArgs()];
    args.push("-o", "ConnectTimeout=15");
    args.push("-o", "ServerAliveInterval=5");
    args.push("-o", "ServerAliveCountMax=2");
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

  private buildSSHArgs(): string[] {
    const args: string[] = [];

    if (this.config.port) {
      args.push("-p", this.config.port.toString());
    }

    if (this.config.identityFile) {
      args.push("-i", this.config.identityFile);
      args.push("-o", "StrictHostKeyChecking=no");
      args.push("-o", "UserKnownHostsFile=/dev/null");
    }

    args.push("-o", "LogLevel=FATAL");
    args.push("-o", "ControlMaster=auto");
    args.push("-o", `ControlPath=${this.controlPath}`);
    args.push("-o", "ControlPersist=60");

    return args;
  }
}
