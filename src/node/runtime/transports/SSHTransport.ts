import type { SpawnResult } from "../RemoteRuntime";
import type { PtyHandle } from "../ptyHandle";
import type { SSHConnectionConfig } from "../sshConnectionPool";

export type SSHTransportConfig = SSHConnectionConfig;

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
