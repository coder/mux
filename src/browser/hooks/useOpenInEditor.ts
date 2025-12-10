import { useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import {
  EDITOR_CONFIG_KEY,
  DEFAULT_EDITOR_CONFIG,
  type EditorConfig,
} from "@/common/constants/storage";
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

/**
 * Hook to open a path in the user's configured code editor.
 *
 * In Electron mode: calls the backend API to spawn the editor process.
 * In browser mode: generates deep link URLs (vscode://, cursor://) that open
 * the user's locally installed editor.
 *
 * If no editor is configured, opens Settings to the General section.
 * For SSH workspaces with unsupported editors (Zed, custom), returns an error.
 *
 * @returns A function that opens a path in the editor:
 *   - workspaceId: required workspace identifier
 *   - targetPath: the path to open (workspace directory or specific file)
 *   - runtimeConfig: optional, used to detect SSH workspaces for validation
 */
export function useOpenInEditor() {
  const { api } = useAPI();
  const { open: openSettings } = useSettings();

  return useCallback(
    async (
      workspaceId: string,
      targetPath: string,
      runtimeConfig?: RuntimeConfig
    ): Promise<OpenInEditorResult> => {
      // Read editor config from localStorage
      const editorConfig = readPersistedState<EditorConfig>(
        EDITOR_CONFIG_KEY,
        DEFAULT_EDITOR_CONFIG
      );

      const isSSH = isSSHRuntime(runtimeConfig);

      // For custom editor with no command configured, open settings
      if (editorConfig.editor === "custom" && !editorConfig.customCommand) {
        openSettings("general");
        return { success: false, error: "Please configure a custom editor command in Settings" };
      }

      // For SSH workspaces, validate the editor supports Remote-SSH (only VS Code/Cursor)
      if (isSSH) {
        if (editorConfig.editor === "zed") {
          return {
            success: false,
            error: "Zed does not support Remote-SSH for SSH workspaces",
          };
        }
        if (editorConfig.editor === "custom") {
          return {
            success: false,
            error: "Custom editors do not support Remote-SSH for SSH workspaces",
          };
        }
      }

      // Browser mode: use deep links instead of backend spawn
      if (isBrowserMode) {
        // Custom editor can't work via deep links
        if (editorConfig.editor === "custom") {
          return {
            success: false,
            error: "Custom editors are not supported in browser mode. Use VS Code or Cursor.",
          };
        }

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
          editor: editorConfig.editor as DeepLinkEditor,
          path: targetPath,
          sshHost,
        });

        if (!deepLink) {
          return {
            success: false,
            error: `${editorConfig.editor} does not support SSH remote connections`,
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
        editorConfig,
      });

      if (!result) {
        return { success: false, error: "API not available" };
      }

      if (!result.success) {
        return { success: false, error: result.error };
      }

      return { success: true };
    },
    [api, openSettings]
  );
}
