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
import { parseSimpleFrontmatter } from "@/node/utils/markdown";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { log } from "./log";

/** Regex for valid command names: lowercase alphanumeric with hyphens */
const COMMAND_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Static file extension (markdown only, supports frontmatter) */
const STATIC_FILE_EXTENSION = ".md";

/** Regex to match usage comment in executables: # usage: <usage> */
const USAGE_COMMENT_REGEX = /^#\s*usage:\s*(.+)$/i;

export interface SlashCommand {
  name: string;
  description?: string;
}

export interface SlashCommandListResult {
  commands: SlashCommand[];
  /** Files that were skipped due to invalid names (for user feedback) */
  skippedInvalidNames: string[];
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
   * - Static markdown files at <workspacePath>/.mux/commands/<name>.md
   *
   * Extracts descriptions from:
   * - .md files: YAML frontmatter `description` field
   * - Executables: Magic comment `# mux: <description>` after shebang
   */
  async listCommands(runtime: Runtime, workspacePath: string): Promise<SlashCommandListResult> {
    // Build paths relative to cwd to avoid mixing Windows vs POSIX separators.
    // (workspacePath can be a native Windows path even though we execute via bash.)
    const commandsDir = path.posix.join(".mux", "commands");

    try {
      // Find executables OR static markdown files
      const result = await execBuffered(
        runtime,
        `find "${commandsDir}" -maxdepth 1 -type f \\( -executable -o -name "*.md" \\) 2>/dev/null || true`,
        { cwd: workspacePath, timeout: 10 }
      );

      if (!result.stdout.trim()) {
        return { commands: [], skippedInvalidNames: [] };
      }

      // Collect unique command names with their file info, track invalid names
      const commandFiles = new Map<string, { filename: string; isStatic: boolean }>();
      const skippedInvalidNames: string[] = [];

      for (const filePath of result.stdout.trim().split("\n")) {
        const filename = path.posix.basename(filePath);
        const name = this.getCommandName(filename);

        if (!COMMAND_NAME_REGEX.test(name)) {
          skippedInvalidNames.push(filename);
          continue;
        }

        const isStatic = filename.endsWith(STATIC_FILE_EXTENSION);
        // Static files take precedence over executables
        if (!commandFiles.has(name) || isStatic) {
          commandFiles.set(name, { filename, isStatic });
        }
      }

      // Extract descriptions in parallel
      const commands = await Promise.all(
        Array.from(commandFiles.entries()).map(async ([name, { filename, isStatic }]) => {
          const description = await this.extractDescription(
            runtime,
            workspacePath,
            filename,
            isStatic
          );
          return { name, description };
        })
      );

      return {
        commands: commands.sort((a, b) => a.name.localeCompare(b.name)),
        skippedInvalidNames,
      };
    } catch (error) {
      log.debug("Failed to list slash commands:", error);
      return { commands: [], skippedInvalidNames: [] };
    }
  }

  /**
   * Extract description from a command file.
   * - For .md files: parse YAML frontmatter
   * - For executables: look for magic comment `# mux: <description>`
   */
  private async extractDescription(
    runtime: Runtime,
    workspacePath: string,
    filename: string,
    isStatic: boolean
  ): Promise<string | undefined> {
    const commandsDir = path.posix.join(".mux", "commands");
    const filePath = `${commandsDir}/${filename}`;

    try {
      // Read first few lines (enough for frontmatter or magic comment)
      const result = await execBuffered(runtime, `head -10 "${filePath}"`, {
        cwd: workspacePath,
        timeout: 5,
      });

      if (isStatic) {
        return this.parseMarkdownDescription(result.stdout);
      } else {
        return this.parseExecutableDescription(result.stdout);
      }
    } catch {
      return undefined;
    }
  }

  /**
   * Parse usage from markdown frontmatter.
   */
  private parseMarkdownDescription(content: string): string | undefined {
    const { frontmatter } = parseSimpleFrontmatter(content);
    return typeof frontmatter.usage === "string" ? frontmatter.usage : undefined;
  }

  /**
   * Parse usage from executable comment.
   * Looks for `# usage: <usage>` in first few lines after shebang.
   */
  private parseExecutableDescription(content: string): string | undefined {
    const lines = content.split("\n");
    // Skip shebang, check next few lines for usage comment
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i].trim();
      // Skip shebang
      if (line.startsWith("#!")) continue;
      // Check for usage comment
      const match = USAGE_COMMENT_REGEX.exec(line);
      if (match) {
        return match[1].trim();
      }
    }
    return undefined;
  }

  /**
   * Extract command name from filename, stripping .md extension if present.
   */
  private getCommandName(filename: string): string {
    if (filename.endsWith(STATIC_FILE_EXTENSION)) {
      return filename.slice(0, -STATIC_FILE_EXTENSION.length);
    }
    return filename;
  }

  /**
   * Resolve the actual file path for a command name.
   * Checks for static .md file first, then bare executable.
   */
  private async resolveCommandFile(
    runtime: Runtime,
    workspacePath: string,
    name: string
  ): Promise<{ filename: string; isStatic: boolean } | null> {
    const commandsDir = path.posix.join(".mux", "commands");

    // Check for static .md file first
    const mdFilename = `${name}${STATIC_FILE_EXTENSION}`;
    const mdResult = await execBuffered(
      runtime,
      `test -f "${commandsDir}/${mdFilename}" && echo "exists" || true`,
      { cwd: workspacePath, timeout: 5 }
    );
    if (mdResult.stdout.trim() === "exists") {
      return { filename: mdFilename, isStatic: true };
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
   * Read a static markdown file and return its contents (frontmatter stripped).
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

      // Strip frontmatter if present, use body only
      const { body } = parseSimpleFrontmatter(result.stdout);
      const stdout = body.trimEnd();

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
