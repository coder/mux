import { spawn, spawnSync } from "child_process";
import type { Config } from "@/node/config";
import { isSSHRuntime } from "@/common/types/runtime";
import { log } from "@/node/services/log";

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
   * Open the workspace in the user's configured code editor.
   * For SSH workspaces, opens via Remote-SSH extension (VS Code/Cursor only).
   */
  async openWorkspaceInEditor(
    workspaceId: string,
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

        // Build the remote command: code --remote ssh-remote+host /remote/path
        const sshHost = runtimeConfig.host;
        const remotePath = workspace.namedWorkspacePath;
        const args = ["--remote", `ssh-remote+${sshHost}`, remotePath];

        log.info(`Opening SSH workspace in editor: ${editorCommand} ${args.join(" ")}`);
        const child = spawn(editorCommand, args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } else {
        // Local workspace - just open the path
        const workspacePath = workspace.namedWorkspacePath;
        log.info(`Opening local workspace in editor: ${editorCommand} ${workspacePath}`);
        const child = spawn(editorCommand, [workspacePath], {
          detached: true,
          stdio: "ignore",
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
   * Check if a command is available in the system PATH
   */
  private isCommandAvailable(command: string): boolean {
    try {
      const result = spawnSync("which", [command], { encoding: "utf8" });
      return result.status === 0;
    } catch {
      return false;
    }
  }
}
