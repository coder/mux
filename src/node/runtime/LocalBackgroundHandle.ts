import type { BackgroundHandle } from "./Runtime";
import { parseExitCode, EXIT_CODE_SIGKILL, EXIT_CODE_SIGTERM } from "./backgroundCommands";
import { log } from "@/node/services/log";
import { execAsync } from "@/node/utils/disposableExec";
import { getBashPath } from "@/node/utils/main/bashPath";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Handle to a local background process.
 *
 * Uses file-based status detection (same approach as SSHBackgroundHandle):
 * - Process is running if exit_code file doesn't exist
 * - Exit code is read from exit_code file (written by bash trap on exit)
 *
 * Output is written directly to files via shell redirection (nohup ... > file),
 * so the process continues writing even if mux closes.
 */
export class LocalBackgroundHandle implements BackgroundHandle {
  private terminated = false;

  constructor(
    private readonly pid: number,
    /**
     * Process group ID for termination.
     * - Unix (setsid=true): equals pid, since setsid makes process a session/group leader
     * - Windows MSYS2 (setsid=false): actual PGID from /proc, used with kill -PGID
     */
    private readonly pgid: number,
    public readonly outputDir: string
  ) {}

  /**
   * Get the exit code from the exit_code file.
   * Returns null if process is still running (file doesn't exist yet).
   */
  async getExitCode(): Promise<number | null> {
    try {
      const exitCodePath = path.join(this.outputDir, "exit_code");
      const content = await fs.readFile(exitCodePath, "utf-8");
      return parseExitCode(content);
    } catch {
      // File doesn't exist or can't be read - process still running or crashed
      return null;
    }
  }

  /**
   * Terminate the process by killing the process group.
   * Sends SIGTERM, waits briefly, then SIGKILL if still running.
   *
   * Uses negative PID to kill the entire process group (setsid makes the
   * process a session/group leader). Same pattern as SSH for parity.
   *
   * On Windows (MSYS2/Git Bash), converts MSYS2 PID to Windows PID and uses taskkill.
   */
  async terminate(): Promise<void> {
    if (this.terminated) return;

    const exitCodePath = path.join(this.outputDir, "exit_code");

    // Windows: use MSYS2's kill command with negative PGID to kill process group
    // taskkill doesn't work because MSYS2's process tree doesn't match Windows' process tree
    // MSYS2's kill understands its own process groups, so kill -PGID works correctly
    if (process.platform === "win32") {
      try {
        // Use PGID to kill entire process group via MSYS2's kill command
        const terminateScript = `kill -9 -${this.pgid} 2>/dev/null || true`;
        log.debug(`LocalBackgroundHandle: Terminating MSYS2 process group ${this.pgid} via bash`);
        using proc = execAsync(terminateScript, { shell: getBashPath() });
        await proc.result;
      } catch (error) {
        // Process already dead
        log.debug(
          `LocalBackgroundHandle: Windows terminate error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      // Write exit code - trap may not fire with kill -9
      try {
        await fs.access(exitCodePath);
      } catch {
        // Ignore write errors - best effort
        await fs.writeFile(exitCodePath, String(EXIT_CODE_SIGKILL)).catch(() => undefined);
      }
      this.terminated = true;
      return;
    }

    // Unix: use process group signals
    const negativePgid = -this.pgid; // Negative PGID = process group

    try {
      log.debug(`LocalBackgroundHandle: Sending SIGTERM to process group ${negativePgid}`);
      process.kill(negativePgid, "SIGTERM");

      // Wait 2 seconds for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check if process is still running
      let stillRunning = false;
      try {
        process.kill(this.pid, 0); // Signal 0 tests if process exists
        stillRunning = true;
      } catch {
        // Process is dead
      }

      if (stillRunning) {
        log.debug(
          `LocalBackgroundHandle: Process still running, sending SIGKILL to group ${negativePgid}`
        );
        process.kill(negativePgid, "SIGKILL");

        // Write exit code for SIGKILL since we had to force kill
        await fs.writeFile(exitCodePath, String(EXIT_CODE_SIGKILL)).catch(() => {
          // Ignore errors writing exit code
        });
      } else {
        // Process died from SIGTERM - write exit code if trap didn't write it
        // Give a tiny bit of time for the trap to write (filesystem sync)
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          await fs.access(exitCodePath);
          // File exists, trap wrote it - don't overwrite
        } catch {
          // No exit_code file - trap didn't run in time, write SIGTERM exit code
          await fs.writeFile(exitCodePath, String(EXIT_CODE_SIGTERM)).catch(() => {
            // Ignore errors writing exit code
          });
        }
      }
    } catch (error) {
      // Process may already be dead - that's fine
      // Write exit code if we couldn't signal it
      log.debug(
        `LocalBackgroundHandle: Error during terminate: ${error instanceof Error ? error.message : String(error)}`
      );
      try {
        await fs.access(exitCodePath);
        // File exists - don't overwrite
      } catch {
        // No exit code - process was likely already dead, write SIGTERM exit
        await fs.writeFile(exitCodePath, String(EXIT_CODE_SIGTERM));
      }
    }

    this.terminated = true;
  }

  /**
   * Clean up resources.
   * No local resources to clean - process runs independently via nohup.
   */
  async dispose(): Promise<void> {
    // No resources to clean up - we don't own the process
  }

  /**
   * Write meta.json to the output directory.
   */
  async writeMeta(metaJson: string): Promise<void> {
    await fs.writeFile(path.join(this.outputDir, "meta.json"), metaJson);
  }
}
