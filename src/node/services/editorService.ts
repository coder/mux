import { spawn, spawnSync } from "child_process";
import type { Config } from "@/node/config";
import { isSSHRuntime } from "@/common/types/runtime";
import { log } from "@/node/services/log";
import { createRuntime } from "@/node/runtime/runtimeFactory";

/**
 * Build a detached spawn invocation for opening GUI editors.
 *
 * On Windows, many editor CLIs are batch scripts (e.g. code.cmd), which require
 * launching via cmd.exe. Using cmd.exe with args (instead of a shell string)
 * also avoids platform-specific quoting bugs.
 */
export function getDetachedSpawnSpec(options: {
  platform: NodeJS.Platform;
  command: string;
  args: string[];
}): { command: string; args: string[] } {
  if (options.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", options.command, ...options.args],
    };
  }

  return { command: options.command, args: options.args };
}

/**
 * Quote a string for safe use in shell commands.
 *
 * IMPORTANT: Prefer spawning commands with an args array instead of building a
 * single shell string. This helper exists only for custom editor commands.
 */
function shellQuote(value: string): string {
  if (value.length === 0) return process.platform === "win32" ? '""' : "''";

  // cmd.exe: use double quotes (single quotes are treated as literal characters)
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }

  // POSIX shells: single quotes with proper escaping for embedded single quotes.
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export interface EditorConfig {
  editor: string;
  customCommand?: string;
}

/**
 * Service for opening workspaces in code editors.
 * Supports VS Code, Cursor, Zed, and custom editors.
 * For SSH workspaces: VS Code/Cursor use Remote-SSH; Zed opens an ssh:// URL.
 */
export class EditorService {
  private readonly config: Config;

  private static readonly EDITOR_COMMANDS: Record<string, string> = {
    vscode: "code",
    cursor: "cursor",
    zed: "zed",
  };

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Open a path in the user's configured code editor.
   * For SSH workspaces with Remote-SSH extension enabled, opens directly in the editor.
   *
   * @param workspaceId - The workspace (used to determine if SSH and get remote host)
   * @param targetPath - The path to open (workspace directory or specific file)
   * @param editorConfig - Editor configuration from user settings
   */
  async openInEditor(
    workspaceId: string,
    targetPath: string,
    editorConfig: EditorConfig
  ): Promise<{ success: true; data: void } | { success: false; error: string }> {
    try {
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspace = allMetadata.find((w) => w.id === workspaceId);

      if (!workspace) {
        return { success: false, error: `Workspace not found: ${workspaceId}` };
      }

      const runtimeConfig = workspace.runtimeConfig;
      const isSSH = isSSHRuntime(runtimeConfig);

      // Determine the editor command
      const editorCommand =
        editorConfig.editor === "custom"
          ? editorConfig.customCommand
          : EditorService.EDITOR_COMMANDS[editorConfig.editor];

      if (!editorCommand) {
        return { success: false, error: "No editor command configured" };
      }

      // Check if editor is available
      const isAvailable = this.isCommandAvailable(editorCommand);
      if (!isAvailable) {
        return { success: false, error: `Editor command not found: ${editorCommand}` };
      }

      if (isSSH) {
        // Resolve tilde paths to absolute paths for SSH.
        // (VS Code's Remote-SSH won't expand ~, and Zed expects a concrete ssh:// URL.)
        const runtime = createRuntime(runtimeConfig, { projectPath: workspace.projectPath });
        const resolvedPath = await runtime.resolvePath(targetPath);

        if (editorConfig.editor === "zed") {
          const hostWithPort =
            runtimeConfig.port != null
              ? runtimeConfig.host + ":" + runtimeConfig.port
              : runtimeConfig.host;
          const sshUrl = `ssh://${hostWithPort}${resolvedPath}`;

          const { command, args } = getDetachedSpawnSpec({
            platform: process.platform,
            command: editorCommand,
            args: [sshUrl],
          });

          log.info(`Opening SSH path in editor: ${[command, ...args].join(" ")}`);
          const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.unref();
        } else {
          // VS Code/Cursor SSH workspace handling via Remote-SSH
          if (editorConfig.editor !== "vscode" && editorConfig.editor !== "cursor") {
            return {
              success: false,
              error: `${editorConfig.editor} does not support SSH connections for SSH workspaces`,
            };
          }

          const { command, args } = getDetachedSpawnSpec({
            platform: process.platform,
            command: editorCommand,
            args: ["--remote", `ssh-remote+${runtimeConfig.host}`, resolvedPath],
          });

          log.info(`Opening SSH path in editor: ${[command, ...args].join(" ")}`);
          const child = spawn(command, args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.unref();
        }
      } else {
        // Local - expand tilde (spawn doesn't expand ~)
        const resolvedPath = targetPath.startsWith("~/")
          ? targetPath.replace("~", process.env.HOME ?? "~")
          : targetPath;

        // Custom commands may include flags, env vars, etc.
        if (editorConfig.editor === "custom") {
          const shellCmd = `${editorCommand} ${shellQuote(resolvedPath)}`;
          log.info(`Opening local path in editor: ${shellCmd}`);
          const child = spawn(shellCmd, [], {
            detached: true,
            stdio: "ignore",
            shell: true,
            windowsHide: true,
          });
          child.unref();
          return { success: true, data: undefined };
        }

        const { command, args } = getDetachedSpawnSpec({
          platform: process.platform,
          command: editorCommand,
          args: [resolvedPath],
        });

        log.info(`Opening local path in editor: ${[command, ...args].join(" ")}`);
        const child = spawn(command, args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      }

      return { success: true, data: undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to open in editor: ${message}`);
      return { success: false, error: message };
    }
  }

  /**
   * Check if a command is available in the system PATH.
   * Inherits enriched PATH from process.env (set by initShellEnv at startup).
   */
  private isCommandAvailable(command: string): boolean {
    try {
      const lookupCommand = process.platform === "win32" ? "where" : "which";
      const result = spawnSync(lookupCommand, [command], { encoding: "utf8" });
      return result.status === 0;
    } catch {
      return false;
    }
  }
}
