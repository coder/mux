import type { SpawnResult } from "../RemoteRuntime";
import type { SSHConnectionConfig } from "../sshConnectionPool";

export type SSHTransportConfig = SSHConnectionConfig;

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(handler: (data: string) => void): { dispose: () => void };
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void };
}

export interface SpawnOptions {
  forcePTY?: boolean;
  timeout?: number;
  abortSignal?: AbortSignal;
}

export interface PtySessionParams {
  workspacePath: string;
  cols: number;
  rows: number;
}

export interface SSHTransport {
  /** Spawn a command on the remote host, returning a ChildProcess-compatible object. */
  spawnRemoteProcess(command: string, options: SpawnOptions): Promise<SpawnResult>;

  /** Determine if an exit code represents a connection-level failure for this transport. */
  isConnectionFailure(exitCode: number, stderr: string): boolean;

  /** Mark connection as healthy (after successful command). */
  markHealthy(): void;

  /** Report connection failure (triggers backoff). */
  reportFailure(error: string): void;

  /** Pre-flight connection check with backoff enforcement. */
  acquireConnection(options?: {
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    onWait?: (waitMs: number) => void;
  }): Promise<void>;

  /** Get underlying config (for PTY terminal spawning). */
  getConfig(): SSHTransportConfig;

  /** Create interactive PTY session for the transport. */
  createPtySession(params: PtySessionParams): Promise<PtyHandle>;
}
