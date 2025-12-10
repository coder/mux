import { spawn, spawnSync } from "child_process";
import type { Config } from "@/node/config";
import { isSSHRuntime } from "@/common/types/runtime";
import { log } from "@/node/services/log";
import { createRuntime } from "@/node/runtime/runtimeFactory";

/**
 * Quote a string for safe use in shell commands.
 * Uses single quotes with proper escaping for embedded single quotes.
 */
function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export interface EditorConfig {
  editor: string;
  customCommand?: string;
}

/**
 * Service for opening workspaces in code editors.
 * Supports VS Code, Cursor, Zed, and custom editors.
 * For SSH workspaces, can use Remote-SSH extension (VS Code/Cursor only).
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
        // SSH workspace handling - only VS Code and Cursor support Remote-SSH
        if (editorConfig.editor !== "vscode" && editorConfig.editor !== "cursor") {
          return {
            success: false,
            error: `${editorConfig.editor} does not support Remote-SSH for SSH workspaces`,
          };
        }

        // Resolve tilde paths to absolute paths for SSH (VS Code doesn't expand ~)
        const runtime = createRuntime(runtimeConfig, { projectPath: workspace.projectPath });
        const resolvedPath = await runtime.resolvePath(targetPath);

        // Build the remote command: code --remote ssh-remote+host /remote/path
        // Quote the path to handle spaces; the remote host arg doesn't need quoting
        const shellCmd = `${editorCommand} --remote ${shellQuote(`ssh-remote+${runtimeConfig.host}`)} ${shellQuote(resolvedPath)}`;

        log.info(`Opening SSH path in editor: ${shellCmd}`);
        const child = spawn(shellCmd, [], {
          detached: true,
          stdio: "ignore",
          shell: true,
        });
        child.unref();
      } else {
        // Local - expand tilde and open the path (quote to handle spaces)
        const resolvedPath = targetPath.startsWith("~/")
          ? targetPath.replace("~", process.env.HOME ?? "~")
          : targetPath;
        const shellCmd = `${editorCommand} ${shellQuote(resolvedPath)}`;
        log.info(`Opening local path in editor: ${shellCmd}`);
        const child = spawn(shellCmd, [], {
          detached: true,
          stdio: "ignore",
          shell: true,
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
   * Uses shell: true to ensure we get the full PATH from user's shell profile,
   * which is necessary for commands installed via Homebrew or similar.
   */
  private isCommandAvailable(command: string): boolean {
    try {
      const result = spawnSync("which", [command], { encoding: "utf8", shell: true });
      return result.status === 0;
    } catch {
      return false;
    }
  }
}
