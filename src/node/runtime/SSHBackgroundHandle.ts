import type { BackgroundHandle } from "./Runtime";
import type { SSHRuntime } from "./SSHRuntime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { expandTildeForSSH } from "./tildeExpansion";
import { log } from "@/node/services/log";
import { buildTerminateCommand, parseExitCode } from "./backgroundCommands";

/**
 * Handle to an SSH background process.
 *
 * Uses file-based status detection:
 * - Process is running if exit_code file doesn't exist (getExitCode returns null)
 * - Exit code is read from exit_code file (written by trap on process exit)
 *
 * Output files (stdout.log, stderr.log) are on the remote machine
 * and read by agents via bash("tail ...") commands.
 */
export class SSHBackgroundHandle implements BackgroundHandle {
  private terminated = false;

  constructor(
    private readonly sshRuntime: SSHRuntime,
    private readonly pid: number,
    /** Remote path to output directory (e.g., /tmp/mux-bashes/workspace/bg-xxx) */
    public readonly outputDir: string
  ) {}

  /**
   * Get the exit code from the remote exit_code file.
   * Returns null if process is still running (file doesn't exist yet).
   */
  async getExitCode(): Promise<number | null> {
    try {
      const exitCodePath = expandTildeForSSH(`${this.outputDir}/exit_code`);
      const result = await execBuffered(
        this.sshRuntime,
        `cat ${exitCodePath} 2>/dev/null || echo ""`,
        {
          cwd: "/",
          timeout: 10,
        }
      );
      return parseExitCode(result.stdout);
    } catch (error) {
      log.debug(
        `SSHBackgroundHandle.getExitCode: Error reading exit code: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Terminate the process group via SSH.
   * Sends SIGTERM to process group, waits briefly, then SIGKILL if still running.
   *
   * Uses negative PID to kill entire process group (PID === PGID due to set -m).
   * Same pattern as Local for parity.
   */
  async terminate(): Promise<void> {
    if (this.terminated) return;

    try {
      // Use shared buildTerminateCommand for parity with Local
      // Pass raw path + expandTildeForSSH to avoid double-quoting
      // (expandTildeForSSH returns quoted strings, buildTerminateCommand would quote again)
      const exitCodePath = `${this.outputDir}/exit_code`;
      const terminateCmd = buildTerminateCommand(this.pid, exitCodePath, expandTildeForSSH);
      await execBuffered(this.sshRuntime, terminateCmd, {
        cwd: "/",
        timeout: 15,
      });
      log.debug(`SSHBackgroundHandle: Terminated process group ${this.pid}`);
    } catch (error) {
      // Process may already be dead - that's fine
      log.debug(
        `SSHBackgroundHandle.terminate: Error during terminate: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.terminated = true;
  }

  /**
   * Clean up resources.
   * No local resources to clean for SSH handles.
   */
  async dispose(): Promise<void> {
    // No local resources to clean up
  }

  /**
   * Write meta.json to the output directory on the remote machine.
   */
  async writeMeta(metaJson: string): Promise<void> {
    try {
      // Use heredoc for safe JSON writing
      const metaPath = expandTildeForSSH(`${this.outputDir}/meta.json`);
      await execBuffered(this.sshRuntime, `cat > ${metaPath} << 'METAEOF'\n${metaJson}\nMETAEOF`, {
        cwd: "/",
        timeout: 10,
      });
    } catch (error) {
      log.debug(
        `SSHBackgroundHandle.writeMeta: Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
