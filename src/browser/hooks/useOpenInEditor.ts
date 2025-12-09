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

export interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

/**
 * Hook to open a path in the user's configured code editor.
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

      // Call the backend API
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
