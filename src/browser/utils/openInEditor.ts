import { readPersistedState } from "@/browser/hooks/usePersistedState";
import {
  getEditorDeepLink,
  getDockerDeepLink,
  isLocalhost,
  type DeepLinkEditor,
} from "@/browser/utils/editorDeepLinks";
import {
  DEFAULT_EDITOR_CONFIG,
  EDITOR_CONFIG_KEY,
  type EditorConfig,
} from "@/common/constants/storage";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime, isDockerRuntime } from "@/common/types/runtime";
import type { APIClient } from "@/browser/contexts/API";
import { getEditorDeepLinkFallbackUrl } from "@/browser/utils/openInEditorDeepLinkFallback";

export interface OpenInEditorResult {
  success: boolean;
  error?: string;
}

// Browser mode: window.api is not set (only exists in Electron via preload)
const isBrowserMode = typeof window !== "undefined" && !window.api;

export async function openInEditor(args: {
  api: APIClient | null | undefined;
  openSettings?: (section?: string) => void;
  workspaceId: string;
  targetPath: string;
  runtimeConfig?: RuntimeConfig;
}): Promise<OpenInEditorResult> {
  const editorConfig = readPersistedState<EditorConfig>(EDITOR_CONFIG_KEY, DEFAULT_EDITOR_CONFIG);

  const isSSH = isSSHRuntime(args.runtimeConfig);
  const isDocker = isDockerRuntime(args.runtimeConfig);

  // For custom editor with no command configured, open settings (if available)
  if (editorConfig.editor === "custom" && !editorConfig.customCommand) {
    args.openSettings?.("general");
    return { success: false, error: "Please configure a custom editor command in Settings" };
  }

  // For SSH workspaces, validate the editor supports SSH connections
  if (isSSH) {
    if (editorConfig.editor === "custom") {
      return {
        success: false,
        error: "Custom editors do not support SSH connections for SSH workspaces",
      };
    }
  }

  // Docker workspaces always use deep links (VS Code connects to container remotely)
  if (isDocker && args.runtimeConfig?.type === "docker") {
    if (editorConfig.editor === "zed") {
      return { success: false, error: "Zed does not support Docker containers" };
    }
    if (editorConfig.editor === "custom") {
      return { success: false, error: "Custom editors do not support Docker containers" };
    }

    const containerName = args.runtimeConfig.containerName;
    if (!containerName) {
      return {
        success: false,
        error: "Container name not available. Try reopening the workspace.",
      };
    }

    // VS Code's attached-container URI scheme only supports opening folders as workspaces,
    // not individual files. Attempting to open a file path results in VS Code treating it
    // as a workspace root and failing with "chdir failed: not a directory".
    // For file paths: open the parent directory so the file is visible in the file tree.
    // For directory paths (e.g., /src): open as-is.
    const lastSlash = args.targetPath.lastIndexOf("/");
    const isRootLevelPath = lastSlash === 0; // e.g., /src, /var
    const targetDir = isRootLevelPath
      ? args.targetPath
      : args.targetPath.substring(0, lastSlash) || "/";
    const deepLink = getDockerDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      containerName,
      path: targetDir,
    });

    if (!deepLink) {
      return { success: false, error: `${editorConfig.editor} does not support Docker containers` };
    }

    window.open(deepLink, "_blank");
    return { success: true };
  }

  // Browser mode: use deep links instead of backend spawn
  if (isBrowserMode) {
    // Custom editor can't work via deep links
    if (editorConfig.editor === "custom") {
      return {
        success: false,
        error: "Custom editors are not supported in browser mode. Use VS Code, Cursor, or Zed.",
      };
    }

    // Determine SSH host for deep link
    let sshHost: string | undefined;
    if (isSSH && args.runtimeConfig?.type === "ssh") {
      // SSH workspace: use the configured SSH host
      sshHost = args.runtimeConfig.host;
      if (editorConfig.editor === "zed" && args.runtimeConfig.port != null) {
        sshHost = sshHost + ":" + args.runtimeConfig.port;
      }
    } else if (!isLocalhost(window.location.hostname)) {
      // Remote server + local workspace: need SSH to reach server's files
      const serverSshHost = await args.api?.server.getSshHost();
      sshHost = serverSshHost ?? window.location.hostname;
    }
    // else: localhost access to local workspace → no SSH needed

    const deepLink = getEditorDeepLink({
      editor: editorConfig.editor as DeepLinkEditor,
      path: args.targetPath,
      sshHost,
    });

    if (!deepLink) {
      return {
        success: false,
        error: `${editorConfig.editor} does not support SSH remote connections`,
      };
    }

    window.open(deepLink, "_blank");
    return { success: true };
  }

  // Electron mode: call the backend API
  const result = await args.api?.general.openInEditor({
    workspaceId: args.workspaceId,
    targetPath: args.targetPath,
    editorConfig,
  });

  if (!result) {
    return { success: false, error: "API not available" };
  }

  if (!result.success) {
    const deepLink =
      typeof window === "undefined"
        ? null
        : getEditorDeepLinkFallbackUrl({
            editor: editorConfig.editor,
            targetPath: args.targetPath,
            runtimeConfig: args.runtimeConfig,
            error: result.error,
          });

    if (deepLink) {
      window.open(deepLink, "_blank");
      return { success: true };
    }

    return { success: false, error: result.error };
  }

  return { success: true };
}
