import type { EditorType } from "@/common/constants/storage";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import { getEditorDeepLink, type DeepLinkEditor } from "@/browser/utils/editorDeepLinks";

export function shouldAttemptEditorDeepLinkFallback(error: string | undefined): boolean {
  if (!error) return false;

  // Primary signal from our backend EditorService.
  if (error.startsWith("Editor command not found:")) return true;

  return false;
}

export function getEditorDeepLinkFallbackUrl(args: {
  editor: EditorType;
  targetPath: string;
  runtimeConfig?: RuntimeConfig;
  error?: string;
}): string | null {
  if (!shouldAttemptEditorDeepLinkFallback(args.error)) return null;

  if (args.editor === "custom") return null;

  const deepLinkEditor: DeepLinkEditor | null =
    args.editor === "vscode" || args.editor === "cursor" || args.editor === "zed"
      ? args.editor
      : null;

  if (!deepLinkEditor) return null;

  let sshHost: string | undefined;
  if (isSSHRuntime(args.runtimeConfig)) {
    sshHost = args.runtimeConfig.host;
    if (deepLinkEditor === "zed" && args.runtimeConfig.port != null) {
      sshHost = sshHost + ":" + args.runtimeConfig.port;
    }
  }

  return getEditorDeepLink({
    editor: deepLinkEditor,
    path: args.targetPath,
    sshHost,
  });
}
