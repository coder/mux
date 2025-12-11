import { spawn } from "child_process";
import { statSync } from "fs";
import type { Config } from "@/node/config";
import { isSSHRuntime } from "@/common/types/runtime";
import { log } from "@/node/services/log";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { findAvailableCommand } from "@/node/utils/commandDiscovery";
import type { TerminalService } from "@/node/services/terminalService";
import type {
  EditorContext,
  EditorsConfig,
  EditorInfo,
  EditorOpenResult,
} from "@/common/types/editor";
import { DEFAULT_EDITORS_JS } from "@/common/types/editor";

/**
 * Service for opening workspaces in code editors.
 *
 * Editor configuration is loaded from ~/.mux/editors.js which exports:
 * - default: string (editor ID)
 * - editors: Record<string, { name, open(ctx) }>
 *
 * Each editor's open() function receives context about the workspace
 * and returns instructions for how to open it (native spawn or web terminal).
 */
export class EditorService {
  private readonly config: Config;
  private terminalService?: TerminalService;
  private editorsConfig: EditorsConfig | null = null;
  private editorsConfigMtime = 0;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Set the terminal service reference (for opening web terminals).
   * Called after service container initialization to avoid circular deps.
   */
  setTerminalService(terminalService: TerminalService): void {
    this.terminalService = terminalService;
  }

  /**
   * Check if running in browser mode (no native process spawning)
   */
  isBrowserMode(): boolean {
    return !this.terminalService?.isDesktopMode();
  }

  /**
   * Load editors config from ~/.mux/editors.js
   * Creates default file if it doesn't exist.
   * Caches config and reloads when file changes.
   */
  private async loadEditorsConfig(): Promise<EditorsConfig> {
    const editorsPath = this.config.getEditorsFilePath();

    // Ensure file exists with defaults
    await this.config.ensureEditorsFile(DEFAULT_EDITORS_JS);

    // Check if we need to reload (file modified)
    let mtime = 0;
    try {
      mtime = statSync(editorsPath).mtimeMs;
    } catch {
      // File doesn't exist, will be created
    }

    if (this.editorsConfig && mtime === this.editorsConfigMtime) {
      return this.editorsConfig;
    }

    // Dynamic import the JS file
    // Add cache-busting query to force reload when file changes
    // Note: Dynamic import is required here - we're loading user-defined JavaScript config
    // eslint-disable-next-line no-restricted-syntax
    const module = (await import(/* @vite-ignore */ `file://${editorsPath}?t=${mtime}`)) as {
      default: EditorsConfig;
    };
    this.editorsConfig = module.default;
    this.editorsConfigMtime = mtime;
    return this.editorsConfig;
  }

  /**
   * Get list of available editors for the UI
   */
  async listEditors(): Promise<EditorInfo[]> {
    const config = await this.loadEditorsConfig();
    return Object.entries(config.editors).map(([id, editor]) => ({
      id,
      name: editor.name,
      isDefault: id === config.default,
    }));
  }

  /**
   * Get the current default editor ID
   */
  getDefaultEditorId(): string {
    return this.config.getDefaultEditorId();
  }

  /**
   * Set the default editor
   */
  async setDefaultEditor(editorId: string): Promise<void> {
    const config = await this.loadEditorsConfig();
    if (!config.editors[editorId]) {
      throw new Error(`Unknown editor: ${editorId}`);
    }
    await this.config.setDefaultEditorId(editorId);
    // Invalidate cache so next load picks up the change
    this.editorsConfigMtime = 0;
  }

  /**
   * Open a path in the user's configured code editor.
   *
   * @param workspaceId - The workspace (used to determine if SSH and get remote host)
   * @param targetPath - The path to open (workspace directory or specific file)
   * @param editorId - Optional editor ID override (uses default if not provided)
   */
  async openInEditor(
    workspaceId: string,
    targetPath: string,
    editorId?: string
  ): Promise<{ success: true; data: void } | { success: false; error: string }> {
    try {
      // Load workspace metadata
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const workspace = allMetadata.find((w) => w.id === workspaceId);

      if (!workspace) {
        return { success: false, error: `Workspace not found: ${workspaceId}` };
      }

      // Load editor config
      const editorsConfig = await this.loadEditorsConfig();
      const selectedEditorId = editorId ?? editorsConfig.default;
      const editor = editorsConfig.editors[selectedEditorId];

      if (!editor) {
        return { success: false, error: `Unknown editor: ${selectedEditorId}` };
      }

      // Build context for the editor's open function
      const runtimeConfig = workspace.runtimeConfig;
      const isSSH = isSSHRuntime(runtimeConfig);

      // Resolve path for SSH workspaces (VS Code doesn't expand ~)
      let resolvedPath = targetPath;
      if (isSSH) {
        const runtime = createRuntime(runtimeConfig, { projectPath: workspace.projectPath });
        resolvedPath = await runtime.resolvePath(targetPath);
      }

      const ctx: EditorContext = {
        path: resolvedPath,
        host: isSSH ? runtimeConfig.host : undefined,
        isSSH,
        isBrowser: this.isBrowserMode(),
        isDesktop: !this.isBrowserMode(),
        platform: process.platform,
        findCommand: (commands: string[]) => findAvailableCommand(commands),
      };

      // Call the editor's open function
      const result: EditorOpenResult = await editor.open(ctx);

      // Handle error response
      if ("error" in result) {
        return { success: false, error: result.error };
      }

      // Handle web terminal response
      if (result.type === "web_term") {
        if (!this.terminalService) {
          return { success: false, error: "Terminal service not available" };
        }
        await this.terminalService.openWindow(workspaceId, result.command);
        return { success: true, data: undefined };
      }

      // Handle native spawn response
      if (result.type === "native") {
        if (this.isBrowserMode()) {
          return {
            success: false,
            error: "Native editors are not available in browser mode",
          };
        }

        log.info(`Opening in editor: ${result.command} ${result.args.join(" ")}`);
        const child = spawn(result.command, result.args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return { success: true, data: undefined };
      }

      return { success: false, error: "Invalid editor response" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to open in editor: ${message}`);
      return { success: false, error: message };
    }
  }
}
