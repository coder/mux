import { useCallback } from "react";
import { useAPI } from "@/browser/contexts/API";
import { useSettings } from "@/browser/contexts/SettingsContext";
import type { RuntimeConfig } from "@/common/types/runtime";
import { openInEditor } from "@/browser/utils/openInEditor";

export type { OpenInEditorResult } from "@/browser/utils/openInEditor";

/**
 * Hook to open a path in the user's configured code editor.
 *
 * This is a thin wrapper around the shared renderer entry point in
 * `src/browser/utils/openInEditor.ts`.
 */
export function useOpenInEditor() {
  const { api } = useAPI();
  const { open: openSettings } = useSettings();

  return useCallback(
    async (workspaceId: string, targetPath: string, runtimeConfig?: RuntimeConfig) => {
      return openInEditor({
        api,
        openSettings,
        workspaceId,
        targetPath,
        runtimeConfig,
      });
    },
    [api, openSettings]
  );
}
