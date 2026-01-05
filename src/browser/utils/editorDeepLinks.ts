/**
 * Editor deep link URL generation for browser mode.
 *
 * When running `mux server` and accessing via browser, we can't spawn editor
 * processes on the server. Instead, we generate deep link URLs that the browser
 * opens, triggering the user's locally installed editor.
 */

export type DeepLinkEditor = "vscode" | "cursor" | "zed";

export interface DeepLinkOptions {
  editor: DeepLinkEditor;
  path: string;
  sshHost?: string; // For SSH/remote workspaces
  line?: number;
  column?: number;
}

/**
 * Generate an editor deep link URL.
 *
 * @returns Deep link URL, or null if the editor doesn't support the requested config
 *          (e.g., Zed doesn't support SSH remote)
 */
export function getEditorDeepLink(options: DeepLinkOptions): string | null {
  const { editor, path, sshHost, line, column } = options;

  // Zed doesn't support Remote-SSH
  if (sshHost && editor === "zed") {
    return null;
  }

  const scheme = editor; // vscode, cursor, zed all use their name as scheme

  if (sshHost) {
    // Remote-SSH format: vscode://vscode-remote/ssh-remote+host/path
    let url = `${scheme}://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${path}`;
    if (line != null) {
      url += `:${line}`;
      if (column != null) {
        url += `:${column}`;
      }
    }
    return url;
  }

  // Local format: vscode://file/path
  let url = `${scheme}://file${path}`;
  if (line != null) {
    url += `:${line}`;
    if (column != null) {
      url += `:${column}`;
    }
  }
  return url;
}

/**
 * Check if a hostname represents localhost.
 */
export function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * Convert a string to hex encoding (for VS Code remote URIs).
 */
function toHex(str: string): string {
  return Array.from(str)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a deep link URL to open a Docker container in VS Code/Cursor.
 * Uses the attached-container URI scheme.
 *
 * @returns Deep link URL, or null if the editor doesn't support Docker containers
 */
export function getDockerDeepLink(options: {
  editor: DeepLinkEditor;
  containerName: string;
  path: string;
}): string | null {
  const { editor, containerName, path } = options;

  // Only VS Code and Cursor support attached-container
  if (editor === "zed") {
    return null;
  }

  // Format: vscode-remote://attached-container+<hex_encoded_json>/<path>
  // The JSON must be: {"containerName":"/<container_name>"}
  // Use // before path to preserve leading / inside container
  const config = JSON.stringify({ containerName: `/${containerName}` });
  const hexConfig = toHex(config);
  return `${editor}://vscode-remote/attached-container+${hexConfig}/${path}`;
}
