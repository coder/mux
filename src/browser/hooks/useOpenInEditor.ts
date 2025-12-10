import { useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import {
  getEditorDeepLink,
  isLocalhost,
  type DeepLinkEditor,
} from "@/browser/utils/editorDeepLinks";

export interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

// Browser mode: window.api is not set (only exists in Electron via preload)
const isBrowserMode = typeof window !== "undefined" && !window.api;

// Editors that support deep links in browser mode
const DEEP_LINK_EDITORS = ["vscode", "cursor", "zed"];

/**
 * Hook to open a path in the user's configured code editor.
 *
 * In Electron mode: calls the backend API which uses ~/.mux/editors.js config.
 * In browser mode: generates deep link URLs (vscode://, cursor://) that open
 * the user's locally installed editor. Only VS Code/Cursor support SSH remote.
 *
 * Editor configuration is handled by the backend via ~/.mux/editors.js.
 * The backend determines the appropriate editor based on:
 * - User's default editor preference
 * - Workspace type (local vs SSH)
 * - Runtime environment (desktop vs browser)
 *
 * @returns A function that opens a path in the editor:
 *   - workspaceId: required workspace identifier
 *   - targetPath: the path to open (workspace directory or specific file)
 *   - runtimeConfig: optional, used for SSH host in browser mode deep links
 *   - editorId: optional, override the default editor
 */
export function useOpenInEditor() {
  const { api } = useAPI();

  return useCallback(
    async (
      workspaceId: string,
      targetPath: string,
      runtimeConfig?: RuntimeConfig,
      editorId?: string
    ): Promise<OpenInEditorResult> => {
      // Browser mode: use deep links for supported editors
      if (isBrowserMode) {
        // Get the editor to use - either specified or fetch default from backend
        let editor = editorId;
        if (!editor) {
          try {
            const editors = await api?.general.listEditors();
            const defaultEditor = editors?.find((e) => e.isDefault);
            editor = defaultEditor?.id;
          } catch {
            // Fall back to vscode if we can't fetch
            editor = "vscode";
          }
        }

        if (!editor || !DEEP_LINK_EDITORS.includes(editor)) {
          return {
            success: false,
            error: `${editor ?? "This editor"} is not supported in browser mode. Use VS Code or Cursor.`,
          };
        }

        const isSSH = isSSHRuntime(runtimeConfig);

        // Determine SSH host for deep link
        let sshHost: string | undefined;
        if (isSSH && runtimeConfig?.type === "ssh") {
          // SSH workspace: use the configured SSH host
          sshHost = runtimeConfig.host;
        } else if (!isLocalhost(window.location.hostname)) {
          // Remote server + local workspace: need SSH to reach server's files
          const serverSshHost = await api?.server.getSshHost();
          sshHost = serverSshHost ?? window.location.hostname;
        }
        // else: localhost access to local workspace → no SSH needed

        const deepLink = getEditorDeepLink({
          editor: editor as DeepLinkEditor,
          path: targetPath,
          sshHost,
        });

        if (!deepLink) {
          return {
            success: false,
            error: `${editor} does not support SSH remote connections`,
          };
        }

        // Open deep link (browser will handle protocol and launch editor)
        window.open(deepLink, "_blank");
        return { success: true };
      }

      // Electron mode: call the backend API
      const result = await api?.general.openInEditor({
        workspaceId,
        targetPath,
        editorId,
      });

      if (!result) {
        return { success: false, error: "API not available" };
      }

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return { success: true };
    },
    [api]
  );
}
