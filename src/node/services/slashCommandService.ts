/**
 * SlashCommandService - Manages custom executable slash commands.
 *
 * Discovers and executes custom commands from .mux/commands/<name> in workspace directories.
 * Streams output via init events (reuses init-start, init-output, init-end event types).
 */

import * as path from "path";
import { EventEmitter } from "events";
import type { WorkspaceInitEvent } from "@/common/orpc/types";
import type { Runtime } from "@/node/runtime/Runtime";
import { LineBuffer } from "@/node/runtime/initHook";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { log } from "./log";

/** Regex for valid command names: lowercase alphanumeric with hyphens */
const COMMAND_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Static file extensions that are read verbatim (no execution) */
const STATIC_FILE_EXTENSIONS = [".txt", ".md"];

export interface SlashCommand {
  name: string;
}

export interface SlashCommandResult {
  stdout: string;
  exitCode: number;
}

export interface SlashCommandServiceEvents {
  "init-start": (event: WorkspaceInitEvent & { workspaceId: string }) => void;
  "init-output": (event: WorkspaceInitEvent & { workspaceId: string }) => void;
  "init-end": (event: WorkspaceInitEvent & { workspaceId: string }) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface SlashCommandService {
  on<U extends keyof SlashCommandServiceEvents>(
    event: U,
    listener: SlashCommandServiceEvents[U]
  ): this;
  emit<U extends keyof SlashCommandServiceEvents>(
    event: U,
    ...args: Parameters<SlashCommandServiceEvents[U]>
  ): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class SlashCommandService extends EventEmitter {
  /**
   * List available custom slash commands in a workspace.
   *
   * Discovers:
   * - Executable files at <workspacePath>/.mux/commands/<name>
   * - Static text files at <workspacePath>/.mux/commands/<name>.txt or .md
   */
  async listCommands(runtime: Runtime, workspacePath: string): Promise<SlashCommand[]> {
    // Build paths relative to cwd to avoid mixing Windows vs POSIX separators.
    // (workspacePath can be a native Windows path even though we execute via bash.)
    const commandsDir = path.posix.join(".mux", "commands");

    try {
      // Find executables OR static text files (.txt, .md)
      // -executable finds runnable scripts; the -name patterns find static files
      const result = await execBuffered(
        runtime,
        `find "${commandsDir}" -maxdepth 1 -type f \\( -executable -o -name "*.txt" -o -name "*.md" \\) 2>/dev/null || true`,
        { cwd: workspacePath, timeout: 10 }
      );

      if (!result.stdout.trim()) {
        return [];
      }

      const commands: SlashCommand[] = [];
      for (const filePath of result.stdout.trim().split("\n")) {
        const basename = path.posix.basename(filePath);
        // Strip .txt or .md extension to get the command name
        const name = this.getCommandName(basename);
        if (COMMAND_NAME_REGEX.test(name)) {
          commands.push({ name });
        }
      }

      return commands.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      log.debug("Failed to list slash commands:", error);
      return [];
    }
  }

  /**
   * Extract command name from filename, stripping .txt or .md extensions.
   */
  private getCommandName(filename: string): string {
    for (const ext of STATIC_FILE_EXTENSIONS) {
      if (filename.endsWith(ext)) {
        return filename.slice(0, -ext.length);
      }
    }
    return filename;
  }

  /**
   * Check if a filename represents a static text file (read verbatim, not executed).
   */
  private isStaticFile(filename: string): boolean {
    return STATIC_FILE_EXTENSIONS.some((ext) => filename.endsWith(ext));
  }

  /**
   * Resolve the actual file path for a command name.
   * Checks for static files (.txt, .md) first, then bare executable.
   */
  private async resolveCommandFile(
    runtime: Runtime,
    workspacePath: string,
    name: string
  ): Promise<{ filename: string; isStatic: boolean } | null> {
    const commandsDir = path.posix.join(".mux", "commands");

    // Check for static file variants first (prefer .txt over .md)
    for (const ext of STATIC_FILE_EXTENSIONS) {
      const filename = `${name}${ext}`;
      const result = await execBuffered(
        runtime,
        `test -f "${commandsDir}/${filename}" && echo "exists" || true`,
        { cwd: workspacePath, timeout: 5 }
      );
      if (result.stdout.trim() === "exists") {
        return { filename, isStatic: true };
      }
    }

    // Check for bare executable
    const result = await execBuffered(
      runtime,
      `test -f "${commandsDir}/${name}" -a -x "${commandsDir}/${name}" && echo "exists" || true`,
      { cwd: workspacePath, timeout: 5 }
    );
    if (result.stdout.trim() === "exists") {
      return { filename: name, isStatic: false };
    }

    return null;
  }

  /**
   * Run a custom slash command.
   *
   * For static files (.txt, .md): reads contents verbatim.
   * For executables: streams init-style events and returns stdout.
   */
  async runCommand(
    runtime: Runtime,
    workspacePath: string,
    workspaceId: string,
    name: string,
    args: string[],
    muxEnv: Record<string, string>,
    abortSignal?: AbortSignal
  ): Promise<SlashCommandResult> {
    // Validate command name
    if (!COMMAND_NAME_REGEX.test(name)) {
      throw new Error(`Invalid command name: ${name}`);
    }

    // Resolve the actual file (static or executable)
    const resolved = await this.resolveCommandFile(runtime, workspacePath, name);
    if (!resolved) {
      throw new Error(`Command not found: /${name}`);
    }

    const commandPath = path.join(workspacePath, ".mux", "commands", resolved.filename);

    // For static files, just read and return contents
    if (resolved.isStatic) {
      return this.runStaticFile(runtime, workspacePath, workspaceId, name, commandPath);
    }

    // For executables, run with full streaming support
    return this.runExecutable(
      runtime,
      workspacePath,
      workspaceId,
      name,
      commandPath,
      args,
      muxEnv,
      abortSignal
    );
  }

  /**
   * Wrap command execution with init-start/end lifecycle events and error handling.
   */
  private async withCommandLifecycle(
    workspaceId: string,
    name: string,
    commandPath: string,
    executor: () => Promise<SlashCommandResult>
  ): Promise<SlashCommandResult> {
    const startTime = Date.now();

    this.emit("init-start", {
      type: "init-start",
      workspaceId,
      hookPath: commandPath,
      timestamp: startTime,
      source: "slash-command",
      commandName: name,
    } satisfies WorkspaceInitEvent & { workspaceId: string });

    try {
      const result = await executor();

      this.emit("init-end", {
        type: "init-end",
        workspaceId,
        exitCode: result.exitCode,
        timestamp: Date.now(),
      } satisfies WorkspaceInitEvent & { workspaceId: string });

      log.debug(
        `Slash command /${name} completed (exit ${result.exitCode}, duration ${Date.now() - startTime}ms)`
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.emit("init-output", {
        type: "init-output",
        workspaceId,
        line: `Error: ${errorMessage}`,
        isError: true,
        timestamp: Date.now(),
      } satisfies WorkspaceInitEvent & { workspaceId: string });

      this.emit("init-end", {
        type: "init-end",
        workspaceId,
        exitCode: 1,
        timestamp: Date.now(),
      } satisfies WorkspaceInitEvent & { workspaceId: string });

      throw error;
    }
  }

  /**
   * Emit an output line for streaming display.
   */
  private emitOutput(workspaceId: string, line: string, isError = false): void {
    this.emit("init-output", {
      type: "init-output",
      workspaceId,
      line,
      isError,
      timestamp: Date.now(),
    } satisfies WorkspaceInitEvent & { workspaceId: string });
  }

  /**
   * Read a static file (.txt, .md) and return its contents.
   */
  private async runStaticFile(
    runtime: Runtime,
    workspacePath: string,
    workspaceId: string,
    name: string,
    commandPath: string
  ): Promise<SlashCommandResult> {
    return this.withCommandLifecycle(workspaceId, name, commandPath, async () => {
      // Read file contents via cat (works for both local and SSH runtimes)
      const relPath = `./.mux/commands/${path.basename(commandPath)}`;
      const result = await execBuffered(runtime, `cat "${relPath}"`, {
        cwd: workspacePath,
        timeout: 10,
      });

      const stdout = result.stdout.trimEnd();

      // Emit the content for display
      for (const line of stdout.split("\n")) {
        this.emitOutput(workspaceId, line);
      }

      return { stdout, exitCode: 0 };
    });
  }

  /**
   * Run an executable command with full streaming support.
   */
  private async runExecutable(
    runtime: Runtime,
    workspacePath: string,
    workspaceId: string,
    name: string,
    commandPath: string,
    args: string[],
    muxEnv: Record<string, string>,
    abortSignal?: AbortSignal
  ): Promise<SlashCommandResult> {
    const commandExecPath = `./.mux/commands/${name}`;

    // Build command with args (quote path and args for shell safety)
    // Note: Execute via relative path so workspacePath separators don't matter (Windows vs POSIX).
    const quotedPath = `'${commandExecPath.replace(/'/g, "'\\''")}'`;
    const quotedArgs = args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
    const fullCommand = quotedArgs ? `${quotedPath} ${quotedArgs}` : quotedPath;

    return this.withCommandLifecycle(workspaceId, name, commandPath, async () => {
      // Accumulate raw stdout chunks for return value (preserves empty lines)
      // Note: We cap stdout to 1MB to avoid holding arbitrarily large command output in memory.
      const stdoutChunks: Uint8Array[] = [];
      let stdoutByteLength = 0;
      let stdoutTruncated = false;
      const MAX_STDOUT_BYTES = 1024 * 1024;

      const appendStdoutChunk = (chunk: Uint8Array) => {
        if (stdoutTruncated) return;

        const remaining = MAX_STDOUT_BYTES - stdoutByteLength;
        if (remaining <= 0) {
          stdoutTruncated = true;
          return;
        }

        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        stdoutChunks.push(slice);
        stdoutByteLength += slice.length;

        if (chunk.length > remaining) {
          stdoutTruncated = true;
        }
      };

      // LineBuffer for streaming display (may drop empty lines, OK for live display)
      const stdoutBuffer = new LineBuffer((line) => this.emitOutput(workspaceId, line));
      const stderrBuffer = new LineBuffer((line) => this.emitOutput(workspaceId, line, true));

      const stream = await runtime.exec(fullCommand, {
        cwd: workspacePath,
        timeout: 300, // 5 minute timeout for commands
        abortSignal,
        env: muxEnv,
      });

      // Close stdin immediately (no input support)
      {
        const writer = stream.stdin.getWriter();
        await writer.close();
      }

      // Read stdout and stderr in parallel (separate decoders to avoid cross-stream corruption)
      const readStdout = async () => {
        const decoder = new TextDecoder();
        const reader = stream.stdout.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            appendStdoutChunk(value);
            stdoutBuffer.append(decoder.decode(value, { stream: true }));
          }
          stdoutBuffer.append(decoder.decode());
          stdoutBuffer.flush();
        } finally {
          reader.releaseLock();
        }
      };

      const readStderr = async () => {
        const decoder = new TextDecoder();
        const reader = stream.stderr.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            stderrBuffer.append(decoder.decode(value, { stream: true }));
          }
          stderrBuffer.append(decoder.decode());
          stderrBuffer.flush();
        } finally {
          reader.releaseLock();
        }
      };

      // Wait for everything
      const [exitCode] = await Promise.all([stream.exitCode, readStdout(), readStderr()]);

      // Combine chunks and decode to string (preserves empty lines)
      const combinedStdout = new Uint8Array(stdoutByteLength);
      let offset = 0;
      for (const chunk of stdoutChunks) {
        combinedStdout.set(chunk, offset);
        offset += chunk.length;
      }
      const stdout = new TextDecoder().decode(combinedStdout).trimEnd();

      return { stdout, exitCode };
    });
  }
}
