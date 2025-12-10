/**
 * Editor configuration types for the ~/.mux/editors.js system.
 *
 * Editors can open workspaces in two modes:
 * - "native": Spawns a detached GUI process (VS Code, Cursor, Zed)
 * - "web_term": Opens in mux's web terminal with a command (vim, nvim)
 */

/**
 * Context passed to editor open functions.
 * Provides information about the workspace and environment.
 */
export interface EditorContext {
  /** Absolute path to open (workspace directory or specific file) */
  path: string;
  /** SSH host if this is an SSH workspace */
  host?: string;
  /** Whether this is an SSH workspace */
  isSSH: boolean;
  /** Whether running in browser mode (no native process spawning) */
  isBrowser: boolean;
  /** Whether running in desktop (Electron) mode */
  isDesktop: boolean;
  /** Operating system platform */
  platform: NodeJS.Platform;
  /** Find the first available command from a list of candidates */
  findCommand: (commands: string[]) => Promise<string | null>;
}

/**
 * Result from an editor's open function.
 */
export type EditorOpenResult =
  | {
      /** Spawn a native/detached GUI process */
      type: "native";
      /** Command to execute */
      command: string;
      /** Arguments to pass */
      args: string[];
    }
  | {
      /** Open in web terminal with this command */
      type: "web_term";
      /** Full command string to run in terminal */
      command: string;
    }
  | {
      /** Editor cannot handle this context */
      error: string;
    };

/**
 * Editor definition in editors.js
 */
export interface EditorDefinition {
  /** Display name shown in UI */
  name: string;
  /** Function that determines how to open the editor */
  open: (ctx: EditorContext) => Promise<EditorOpenResult> | EditorOpenResult;
}

/**
 * Structure of ~/.mux/editors.js default export
 */
export interface EditorsConfig {
  /** ID of the default editor */
  default: string;
  /** Map of editor ID to editor definition */
  editors: Record<string, EditorDefinition>;
}

/**
 * Simplified editor info for frontend display (no functions)
 */
export interface EditorInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * Default editors.js content shipped with mux.
 * This is written to ~/.mux/editors.js on first run.
 */
export const DEFAULT_EDITORS_JS = `// Editor configuration for mux
// Customize how editors open workspaces
//
// Each editor has:
//   name: Display name in the UI
//   open(ctx): Function that returns how to open the editor
//
// ctx provides:
//   path      - Workspace path to open
//   host      - SSH host (if SSH workspace)
//   isSSH     - Whether this is an SSH workspace
//   isBrowser - Whether running in browser mode
//   isDesktop - Whether running in Electron desktop mode
//   platform  - "darwin", "linux", or "win32"
//   findCommand(cmds) - Find first available command from list
//
// Return one of:
//   { type: "native", command: "...", args: [...] } - Spawn GUI process
//   { type: "web_term", command: "..." }            - Open in web terminal
//   { error: "..." }                                - Show error to user

export default {
  default: "vscode",

  editors: {
    vscode: {
      name: "VS Code",
      open: async (ctx) => {
        if (ctx.isBrowser) {
          return { error: "VS Code requires the desktop app" };
        }
        if (ctx.isSSH) {
          return {
            type: "native",
            command: "code",
            args: ["--remote", \`ssh-remote+\${ctx.host}\`, ctx.path],
          };
        }
        return { type: "native", command: "code", args: [ctx.path] };
      },
    },

    cursor: {
      name: "Cursor",
      open: async (ctx) => {
        if (ctx.isBrowser) {
          return { error: "Cursor requires the desktop app" };
        }
        if (ctx.isSSH) {
          return {
            type: "native",
            command: "cursor",
            args: ["--remote", \`ssh-remote+\${ctx.host}\`, ctx.path],
          };
        }
        return { type: "native", command: "cursor", args: [ctx.path] };
      },
    },

    zed: {
      name: "Zed",
      open: async (ctx) => {
        if (ctx.isBrowser) {
          return { error: "Zed requires the desktop app" };
        }
        if (ctx.isSSH) {
          return { error: "Zed does not support SSH workspaces" };
        }
        return { type: "native", command: "zed", args: [ctx.path] };
      },
    },

    vim: {
      name: "Vim/Neovim",
      open: async (ctx) => {
        const cmd = await ctx.findCommand(["nvim", "vim", "vi"]);
        if (!cmd) {
          return { error: "No vim-like editor found (tried nvim, vim, vi)" };
        }
        return { type: "web_term", command: \`\${cmd} \${ctx.path}\` };
      },
    },
  },
};
`;
