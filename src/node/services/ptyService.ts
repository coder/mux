/**
 * PTY Service - Manages terminal PTY sessions
 *
 * Handles local, SSH, and Docker terminal sessions using node-pty.
 * Uses callbacks for output/exit events to avoid circular dependencies.
 */

import { randomUUID } from "crypto";

import { log } from "@/node/services/log";
import type { Runtime } from "@/node/runtime/Runtime";
import type {
  TerminalSession,
  TerminalCreateParams,
  TerminalResizeParams,
} from "@/common/types/terminal";
import type { IPty } from "node-pty";
import { SSHRuntime, type SSHRuntimeConfig } from "@/node/runtime/SSHRuntime";
import { LocalBaseRuntime } from "@/node/runtime/LocalBaseRuntime";
import { DockerRuntime } from "@/node/runtime/DockerRuntime";
import { access } from "fs/promises";
import { constants } from "fs";
import { getControlPath, sshConnectionPool } from "@/node/runtime/sshConnectionPool";
import { resolveLocalPtyShell } from "@/node/utils/main/resolveLocalPtyShell";
import { expandTildeForSSH } from "@/node/runtime/tildeExpansion";

interface SessionData {
  pty: IPty;
  workspaceId: string;
  workspacePath: string;
  runtime: Runtime;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

interface PtySpawnConfig {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Load node-pty dynamically (handles Electron vs server mode)
 * @param runtimeType - Used for error messages
 * @param preferElectronBuild - If true, try node-pty first (for local terminals in Electron).
 *                              If false, try @lydell/node-pty first (for SSH/Docker).
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
function loadNodePty(runtimeType: string, preferElectronBuild: boolean): typeof import("node-pty") {
  const first = preferElectronBuild ? "node-pty" : "@lydell/node-pty";
  const second = preferElectronBuild ? "@lydell/node-pty" : "node-pty";

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const pty = require(first);
    log.debug(`Using ${first} for ${runtimeType}`);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return pty;
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const pty = require(second);
      log.debug(`Using ${second} for ${runtimeType} (fallback)`);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return pty;
    } catch (err) {
      log.error("Neither @lydell/node-pty nor node-pty available:", err);
      throw new Error(
        process.versions.electron
          ? `${runtimeType} terminals are not available. node-pty failed to load (likely due to Electron ABI version mismatch). Run 'make rebuild-native' to rebuild native modules.`
          : `${runtimeType} terminals are not available. No prebuilt binaries found for your platform. Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.`
      );
    }
  }
}

/**
 * Create a data handler that buffers incomplete escape sequences
 */
function createBufferedDataHandler(onData: (data: string) => void): (data: string) => void {
  let buffer = "";
  return (data: string) => {
    buffer += data;
    let sendUpTo = buffer.length;

    // Hold back incomplete escape sequences
    if (buffer.endsWith("\x1b")) {
      sendUpTo = buffer.length - 1;
    } else if (buffer.endsWith("\x1b[")) {
      sendUpTo = buffer.length - 2;
    } else {
      // eslint-disable-next-line no-control-regex, @typescript-eslint/prefer-regexp-exec
      const match = buffer.match(/\x1b\[[0-9;]*$/);
      if (match) {
        sendUpTo = buffer.length - match[0].length;
      }
    }

    if (sendUpTo > 0) {
      onData(buffer.substring(0, sendUpTo));
      buffer = buffer.substring(sendUpTo);
    }
  };
}

/**
 * Build SSH command arguments from config
 * Preserves ControlMaster connection pooling and respects ~/.ssh/config
 */
function buildSSHArgs(config: SSHRuntimeConfig, remotePath: string): string[] {
  const args: string[] = [];

  if (config.port) {
    args.push("-p", String(config.port));
  }

  if (config.identityFile) {
    args.push("-i", config.identityFile);
    args.push("-o", "StrictHostKeyChecking=no");
    args.push("-o", "UserKnownHostsFile=/dev/null");
    args.push("-o", "LogLevel=ERROR");
  }

  // Connection multiplexing
  const controlPath = getControlPath(config);
  args.push("-o", "ControlMaster=auto");
  args.push("-o", `ControlPath=${controlPath}`);
  args.push("-o", "ControlPersist=60");

  // Timeouts
  args.push("-o", "ConnectTimeout=15");
  args.push("-o", "ServerAliveInterval=5");
  args.push("-o", "ServerAliveCountMax=2");

  // Force PTY allocation
  args.push("-t");

  args.push(config.host);

  const expandedPath = expandTildeForSSH(remotePath);
  args.push(`cd ${expandedPath} && exec $SHELL -i`);

  return args;
}

/**
 * PTYService - Manages terminal PTY sessions for workspaces
 *
 * Handles local, SSH, and Docker terminal sessions using node-pty.
 * Each workspace can have one or more terminal sessions.
 */
export class PTYService {
  private sessions = new Map<string, SessionData>();

  /**
   * Create a new terminal session for a workspace
   */
  async createSession(
    params: TerminalCreateParams,
    runtime: Runtime,
    workspacePath: string,
    onData: (data: string) => void,
    onExit: (exitCode: number) => void
  ): Promise<TerminalSession> {
    // Include a random suffix to avoid collisions when creating multiple sessions quickly.
    // Collisions can cause two PTYs to appear "merged" under one sessionId.
    const sessionId = `${params.workspaceId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const runtimeType =
      runtime instanceof SSHRuntime ? "SSH" : runtime instanceof DockerRuntime ? "Docker" : "Local";
    log.info(
      `Creating terminal session ${sessionId} for workspace ${params.workspaceId} (${runtimeType})`
    );

    // Determine spawn config based on runtime type
    let spawnConfig: PtySpawnConfig;

    if (runtime instanceof LocalBaseRuntime) {
      // Validate workspace path exists for local
      try {
        await access(workspacePath, constants.F_OK);
      } catch {
        throw new Error(`Workspace path does not exist: ${workspacePath}`);
      }
      const shell = resolveLocalPtyShell();
      spawnConfig = { command: shell.command, args: shell.args, cwd: workspacePath };

      if (!spawnConfig.command.trim()) {
        throw new Error("Cannot spawn Local terminal: empty shell command");
      }

      const printableArgs = spawnConfig.args.length > 0 ? ` ${spawnConfig.args.join(" ")}` : "";
      log.info(
        `Spawning PTY: ${spawnConfig.command}${printableArgs}, cwd: ${workspacePath}, size: ${params.cols}x${params.rows}`
      );
      log.debug(`process.env.SHELL: ${process.env.SHELL ?? "undefined"}`);
      log.debug(`process.env.PATH: ${process.env.PATH ?? process.env.Path ?? "undefined"}`);
    } else if (runtime instanceof SSHRuntime) {
      const sshConfig = runtime.getConfig();
      // Ensure connection is healthy before spawning terminal
      await sshConnectionPool.acquireConnection(sshConfig);
      const sshArgs = buildSSHArgs(sshConfig, workspacePath);
      spawnConfig = { command: "ssh", args: sshArgs, cwd: process.cwd() };
      log.info(`[PTY] SSH terminal for ${sessionId}: ssh ${sshArgs.join(" ")}`);
    } else if (runtime instanceof DockerRuntime) {
      const containerName = runtime.getContainerName();
      if (!containerName) {
        throw new Error("Docker container not initialized");
      }
      const dockerArgs = [
        "exec",
        "-it",
        containerName,
        "/bin/sh",
        "-c",
        `cd ${workspacePath} && exec /bin/sh`,
      ];
      spawnConfig = { command: "docker", args: dockerArgs, cwd: process.cwd() };
      log.info(`[PTY] Docker terminal for ${sessionId}: docker ${dockerArgs.join(" ")}`);
    } else {
      throw new Error(`Unsupported runtime type: ${runtime.constructor.name}`);
    }

    log.info(`[PTY] Terminal size: ${params.cols}x${params.rows}`);

    // Load node-pty and spawn process
    // Local prefers node-pty (Electron rebuild), SSH/Docker prefer @lydell/node-pty (prebuilds)
    const isLocal = runtime instanceof LocalBaseRuntime;

    const pathEnv =
      process.env.PATH ??
      process.env.Path ??
      (process.platform === "win32" ? undefined : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    const pty = loadNodePty(runtimeType, isLocal);
    let ptyProcess: IPty;
    try {
      ptyProcess = pty.spawn(spawnConfig.command, spawnConfig.args, {
        name: "xterm-256color",
        cols: params.cols,
        rows: params.rows,
        cwd: spawnConfig.cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          ...(pathEnv ? { PATH: pathEnv } : {}),
        },
      });
    } catch (err) {
      log.error(`[PTY] Failed to spawn ${runtimeType} terminal ${sessionId}:`, err);

      const printableArgs = spawnConfig.args.length > 0 ? ` ${spawnConfig.args.join(" ")}` : "";
      const cmd = `${spawnConfig.command}${printableArgs}`;
      const details = `cmd="${cmd}", cwd="${spawnConfig.cwd}", platform="${process.platform}"`;
      const errMessage = err instanceof Error ? err.message : String(err);

      if (isLocal) {
        log.error(`Local PTY spawn config: ${cmd} (cwd: ${spawnConfig.cwd})`);
        log.error(`process.env.SHELL: ${process.env.SHELL ?? "undefined"}`);
        log.error(`process.env.PATH: ${process.env.PATH ?? process.env.Path ?? "undefined"}`);
      }

      if (err instanceof Error) {
        throw new Error(`Failed to spawn ${runtimeType} terminal (${details}): ${errMessage}`, {
          cause: err,
        });
      }

      throw new Error(`Failed to spawn ${runtimeType} terminal (${details}): ${errMessage}`);
    }

    // Wire up handlers
    ptyProcess.onData(createBufferedDataHandler(onData));
    ptyProcess.onExit(({ exitCode }) => {
      log.info(`${runtimeType} terminal session ${sessionId} exited with code ${exitCode}`);
      this.sessions.delete(sessionId);
      onExit(exitCode);
    });

    this.sessions.set(sessionId, {
      pty: ptyProcess,
      workspaceId: params.workspaceId,
      workspacePath,
      runtime,
      onData,
      onExit,
    });

    return {
      sessionId,
      workspaceId: params.workspaceId,
      cols: params.cols,
      rows: params.rows,
    };
  }

  /**
   * Send input to a terminal session
   */
  sendInput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.pty) {
      log.info(`Cannot send input to session ${sessionId}: not found or no PTY`);
      return;
    }

    // Works for both local and SSH now
    session.pty.write(data);
  }

  /**
   * Resize a terminal session
   */
  resize(params: TerminalResizeParams): void {
    const session = this.sessions.get(params.sessionId);
    if (!session?.pty) {
      log.info(`Cannot resize terminal session ${params.sessionId}: not found or no PTY`);
      return;
    }

    // Now works for both local AND SSH! 🎉
    session.pty.resize(params.cols, params.rows);
    log.debug(
      `Resized terminal ${params.sessionId} (${session.runtime instanceof SSHRuntime ? "SSH" : "local"}) to ${params.cols}x${params.rows}`
    );
  }

  /**
   * Close a terminal session
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.info(`Cannot close terminal session ${sessionId}: not found`);
      return;
    }

    log.info(`Closing terminal session ${sessionId}`);

    if (session.pty) {
      // Works for both local and SSH
      session.pty.kill();
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Get all session IDs for a workspace.
   * Used by frontend to discover existing sessions to reattach to after reload.
   */
  getWorkspaceSessionIds(workspaceId: string): string[] {
    return Array.from(this.sessions.entries())
      .filter(([, session]) => session.workspaceId === workspaceId)
      .map(([id]) => id);
  }

  /**
   * Close all terminal sessions for a workspace
   */
  closeWorkspaceSessions(workspaceId: string): void {
    const sessionIds = Array.from(this.sessions.entries())
      .filter(([, session]) => session.workspaceId === workspaceId)
      .map(([id]) => id);

    log.info(`Closing ${sessionIds.length} terminal session(s) for workspace ${workspaceId}`);

    sessionIds.forEach((id) => this.closeSession(id));
  }

  /**
   * Close all terminal sessions.
   * Called during server shutdown to prevent orphan PTY processes.
   */
  closeAllSessions(): void {
    const sessionIds = Array.from(this.sessions.keys());
    log.info(`Closing all ${sessionIds.length} terminal session(s)`);
    sessionIds.forEach((id) => this.closeSession(id));
  }

  /**
   * Get all sessions for debugging
   */
  getSessions(): Map<string, SessionData> {
    return this.sessions;
  }
}
