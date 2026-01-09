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
   * Discovers executables at <workspacePath>/.mux/commands/<name>
   */
  async listCommands(runtime: Runtime, workspacePath: string): Promise<SlashCommand[]> {
    // Build paths relative to cwd to avoid mixing Windows vs POSIX separators.
    // (workspacePath can be a native Windows path even though we execute via bash.)
    const commandsDir = path.posix.join(".mux", "commands");

    try {
      // Use find to list executable files (works for both local and SSH runtimes)
      const result = await execBuffered(
        runtime,
        `find "${commandsDir}" -maxdepth 1 -type f -executable 2>/dev/null || true`,
        { cwd: workspacePath, timeout: 10 }
      );

      if (!result.stdout.trim()) {
        return [];
      }

      const commands: SlashCommand[] = [];
      for (const filePath of result.stdout.trim().split("\n")) {
        const name = path.posix.basename(filePath);
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
   * Run a custom slash command.
   *
   * Streams init-style events (init-start, init-output, init-end) via EventEmitter.
   * Returns the accumulated stdout when complete.
   */
  async runCommand(
    runtime: Runtime,
    workspacePath: string,
    workspaceId: string,
    name: string,
    args: string[],
    stdin: string,
    muxEnv: Record<string, string>,
    abortSignal?: AbortSignal
  ): Promise<SlashCommandResult> {
    // Validate command name
    if (!COMMAND_NAME_REGEX.test(name)) {
      throw new Error(`Invalid command name: ${name}`);
    }

    const commandPath = path.join(workspacePath, ".mux", "commands", name);
    const commandExecPath = `./.mux/commands/${name}`;

    // Build command with args (quote path and args for shell safety)
    // Note: Execute via relative path so workspacePath separators don't matter (Windows vs POSIX).
    const quotedPath = `'${commandExecPath.replace(/'/g, "'\\''")}'`;
    const quotedArgs = args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
    const fullCommand = quotedArgs ? `${quotedPath} ${quotedArgs}` : quotedPath;

    const startTime = Date.now();

    // Emit init-start with source="slash-command"
    this.emit("init-start", {
      type: "init-start",
      workspaceId,
      hookPath: commandPath,
      timestamp: startTime,
      source: "slash-command",
      commandName: name,
    } satisfies WorkspaceInitEvent & { workspaceId: string });

    // Accumulate raw stdout chunks for return value (preserves empty lines)
    //
    // Note: We intentionally cap stdout to avoid holding arbitrarily large command output in memory.
    const stdoutChunks: Uint8Array[] = [];
    let stdoutByteLength = 0;
    let stdoutTruncated = false;
    const MAX_STDOUT_BYTES = 1024 * 1024; // 1MB limit

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

    // LineBuffer for streaming display (may drop empty lines, that's OK for live display)
    const stdoutBuffer = new LineBuffer((line) => {
      // Emit for live display
      this.emit("init-output", {
        type: "init-output",
        workspaceId,
        line,
        isError: false,
        timestamp: Date.now(),
      } satisfies WorkspaceInitEvent & { workspaceId: string });
    });

    const stderrBuffer = new LineBuffer((line) => {
      // Emit stderr for display (not accumulated for return)
      this.emit("init-output", {
        type: "init-output",
        workspaceId,
        line,
        isError: true,
        timestamp: Date.now(),
      } satisfies WorkspaceInitEvent & { workspaceId: string });
    });

    try {
      // Execute with stdin support
      const stream = await runtime.exec(fullCommand, {
        cwd: workspacePath,
        timeout: 300, // 5 minute timeout for commands
        abortSignal,
        env: muxEnv,
      });

      // Write stdin if provided
      if (stdin) {
        const writer = stream.stdin.getWriter();
        await writer.write(new TextEncoder().encode(stdin));
        await writer.close();
      } else {
        // Close stdin immediately if no input
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
            // Accumulate raw bytes for final output (preserves empty lines)
            appendStdoutChunk(value);
            // Stream decoded text for live display (may drop empty lines)
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

      const endTime = Date.now();

      // Emit init-end
      this.emit("init-end", {
        type: "init-end",
        workspaceId,
        exitCode,
        timestamp: endTime,
      } satisfies WorkspaceInitEvent & { workspaceId: string });

      log.debug(
        `Slash command /${name} completed (exit ${exitCode}, duration ${endTime - startTime}ms)`
      );

      // Combine chunks and decode to string (preserves empty lines)
      const combinedStdout = new Uint8Array(stdoutByteLength);
      let offset = 0;
      for (const chunk of stdoutChunks) {
        combinedStdout.set(chunk, offset);
        offset += chunk.length;
      }
      const stdout = new TextDecoder().decode(combinedStdout).trimEnd();

      return {
        stdout,
        exitCode,
      };
    } catch (error) {
      const endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Emit error line and init-end
      this.emit("init-output", {
        type: "init-output",
        workspaceId,
        line: `Error: ${errorMessage}`,
        isError: true,
        timestamp: endTime,
      } satisfies WorkspaceInitEvent & { workspaceId: string });

      this.emit("init-end", {
        type: "init-end",
        workspaceId,
        exitCode: 1,
        timestamp: endTime,
      } satisfies WorkspaceInitEvent & { workspaceId: string });

      throw error;
    }
  }
}
