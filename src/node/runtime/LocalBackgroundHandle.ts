import type { BackgroundHandle } from "./Runtime";
import { parseExitCode, buildTerminateCommand } from "./backgroundCommands";
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
   * Sends SIGTERM (15), waits 2 seconds, then SIGKILL (9) if still running.
   *
   * Uses buildTerminateCommand for parity with SSH - works on Linux, macOS, and Windows MSYS2.
   */
  async terminate(): Promise<void> {
    if (this.terminated) return;

    try {
      const exitCodePath = path.join(this.outputDir, "exit_code");
      const terminateCmd = buildTerminateCommand(this.pid, exitCodePath);
      log.debug(`LocalBackgroundHandle: Terminating process group ${this.pid}`);
      using proc = execAsync(terminateCmd, { shell: getBashPath() });
      await proc.result;
    } catch (error) {
      // Process may already be dead - that's fine
      log.debug(
        `LocalBackgroundHandle.terminate: Error: ${error instanceof Error ? error.message : String(error)}`
      );
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
