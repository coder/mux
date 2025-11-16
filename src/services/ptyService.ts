/**
 * PTY Service - Manages terminal PTY sessions
 *
 * Handles both local (using node-pty) and remote (using SSH) terminal sessions.
 * Uses callbacks for output/exit events to avoid circular dependencies.
 */

import { log } from "@/services/log";
import type { Runtime } from "@/runtime/Runtime";
import type { TerminalSession, TerminalCreateParams, TerminalResizeParams } from "@/types/terminal";
import type { IPty } from "@homebridge/node-pty-prebuilt-multiarch";
import { SSHRuntime, type SSHRuntimeConfig } from "@/runtime/SSHRuntime";
import { LocalRuntime } from "@/runtime/LocalRuntime";
import { access } from "fs/promises";
import { constants } from "fs";
import { getControlPath } from "@/runtime/sshConnectionPool";
import { expandTildeForSSH } from "@/runtime/tildeExpansion";

interface SessionData {
  pty: IPty; // Used for both local and SSH sessions
  workspaceId: string;
  workspacePath: string;
  runtime: Runtime;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}

/**
 * Build SSH command arguments from config
 * Preserves ControlMaster connection pooling and respects ~/.ssh/config
 */
function buildSSHArgs(config: SSHRuntimeConfig, remotePath: string): string[] {
  const args: string[] = [];

  // Add port if specified (overrides ~/.ssh/config)
  if (config.port) {
    args.push("-p", String(config.port));
  }

  // Add identity file if specified (overrides ~/.ssh/config)
  if (config.identityFile) {
    args.push("-i", config.identityFile);
    args.push("-o", "StrictHostKeyChecking=no");
    args.push("-o", "UserKnownHostsFile=/dev/null");
    args.push("-o", "LogLevel=ERROR");
  }

  // Add connection multiplexing (reuse SSHRuntime's controlPath logic)
  const controlPath = getControlPath(config);
  args.push("-o", "ControlMaster=auto");
  args.push("-o", `ControlPath=${controlPath}`);
  args.push("-o", "ControlPersist=60");

  // Add connection timeout
  args.push("-o", "ConnectTimeout=15");
  args.push("-o", "ServerAliveInterval=5");
  args.push("-o", "ServerAliveCountMax=2");

  // Force PTY allocation
  args.push("-t");

  // Host (can be alias from ~/.ssh/config)
  args.push(config.host);

  // Remote command: cd to workspace and start shell
  // expandTildeForSSH already handles quoting, so use it directly
  const expandedPath = expandTildeForSSH(remotePath);
  args.push(`cd ${expandedPath} && exec $SHELL -i`);

  return args;
}

/**
 * PTYService - Manages terminal PTY sessions for workspaces
 *
 * Handles both local (using node-pty) and remote (using SSH) terminal sessions.
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
    const sessionId = `${params.workspaceId}-${Date.now()}`;

    log.info(
      `Creating terminal session ${sessionId} for workspace ${params.workspaceId} (${runtime instanceof SSHRuntime ? "SSH" : "local"})`
    );

    if (runtime instanceof LocalRuntime) {
      // Local: Use node-pty (dynamically import to avoid crash if not available)
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      let pty: typeof import("@homebridge/node-pty-prebuilt-multiarch");
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
        pty = require("@homebridge/node-pty-prebuilt-multiarch");
      } catch (err) {
        log.error("node-pty not available - local terminals will not work:", err);
        throw new Error(
          "Local terminals are not available. node-pty failed to load (likely due to Electron ABI version mismatch). Use SSH workspaces for terminal access."
        );
      }

      // Validate workspace path exists
      try {
        await access(workspacePath, constants.F_OK);
      } catch {
        throw new Error(`Workspace path does not exist: ${workspacePath}`);
      }

      const shell = process.env.SHELL ?? "/bin/bash";

      log.info(
        `Spawning PTY with shell: ${shell}, cwd: ${workspacePath}, size: ${params.cols}x${params.rows}`
      );
      log.debug(`PATH env: ${process.env.PATH ?? "undefined"}`);

      let ptyProcess;
      try {
        ptyProcess = pty.spawn(shell, [], {
          name: "xterm-256color",
          cols: params.cols,
          rows: params.rows,
          cwd: workspacePath,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            // Ensure PATH is set properly for shell to find commands
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          },
        });
      } catch (err) {
        log.error(`Failed to spawn PTY: ${String(err)}`);
        log.error(`Shell: ${shell}, CWD: ${workspacePath}`);
        log.error(`process.env.SHELL: ${process.env.SHELL ?? "undefined"}`);
        log.error(`process.env.PATH: ${process.env.PATH ?? "undefined"}`);
        throw new Error(
          `Failed to spawn shell "${shell}": ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Forward PTY data via callback
      // Buffer to handle escape sequences split across chunks
      let buffer = "";

      ptyProcess.onData((data) => {
        // Append new data to buffer
        buffer += data;

        // Check if buffer ends with an incomplete escape sequence
        // Look for ESC at the end without its complete sequence
        let sendUpTo = buffer.length;

        // If buffer ends with ESC or ESC[, hold it back for next chunk
        if (buffer.endsWith("\x1b")) {
          sendUpTo = buffer.length - 1;
        } else if (buffer.endsWith("\x1b[")) {
          sendUpTo = buffer.length - 2;
        } else {
          // Check if it ends with ESC[ followed by incomplete CSI sequence
          // eslint-disable-next-line no-control-regex, @typescript-eslint/prefer-regexp-exec
          const match = buffer.match(/\x1b\[[0-9;]*$/);
          if (match) {
            sendUpTo = buffer.length - match[0].length;
          }
        }

        // Send complete data
        if (sendUpTo > 0) {
          const toSend = buffer.substring(0, sendUpTo);
          onData(toSend);
          buffer = buffer.substring(sendUpTo);
        }
      });

      // Handle exit
      ptyProcess.onExit(({ exitCode }) => {
        log.info(`Terminal session ${sessionId} exited with code ${exitCode}`);
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
    } else if (runtime instanceof SSHRuntime) {
      // SSH: Use node-pty to spawn SSH with local PTY (enables resize support)
      const sshConfig = runtime.getConfig();
      const sshArgs = buildSSHArgs(sshConfig, workspacePath);

      log.info(`[PTY] SSH terminal for ${sessionId}: ssh ${sshArgs.join(" ")}`);
      log.info(`[PTY] SSH terminal size: ${params.cols}x${params.rows}`);

      // Load node-pty dynamically
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      let pty: typeof import("@homebridge/node-pty-prebuilt-multiarch");
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
        pty = require("@homebridge/node-pty-prebuilt-multiarch");
      } catch (err) {
        log.error("node-pty not available - SSH terminals will not work:", err);
        throw new Error(
          "SSH terminals are not available. node-pty failed to load (likely due to Electron ABI version mismatch)."
        );
      }

      let ptyProcess: IPty;
      try {
        // Spawn SSH with PTY (same as local terminals)
        ptyProcess = pty.spawn("ssh", sshArgs, {
          name: "xterm-256color",
          cols: params.cols,
          rows: params.rows,
          cwd: process.cwd(),
          env: {
            ...process.env,
            TERM: "xterm-256color",
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          },
        });
      } catch (err) {
        log.error(`[PTY] Failed to spawn SSH terminal ${sessionId}:`, err);
        throw new Error(
          `Failed to spawn SSH terminal: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Handle data (same as local - buffer incomplete escape sequences)
      let buffer = "";
      ptyProcess.onData((data) => {
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
          const toSend = buffer.substring(0, sendUpTo);
          onData(toSend);
          buffer = buffer.substring(sendUpTo);
        }
      });

      // Handle exit (same as local)
      ptyProcess.onExit(({ exitCode }) => {
        log.info(`SSH terminal session ${sessionId} exited with code ${exitCode}`);
        this.sessions.delete(sessionId);
        onExit(exitCode);
      });

      // Store PTY (same interface as local)
      this.sessions.set(sessionId, {
        pty: ptyProcess,
        workspaceId: params.workspaceId,
        workspacePath,
        runtime,
        onData,
        onExit,
      });
    } else {
      throw new Error(`Unsupported runtime type: ${runtime.constructor.name}`);
    }

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
   * Get all sessions for debugging
   */
  getSessions(): Map<string, SessionData> {
    return this.sessions;
  }
}
