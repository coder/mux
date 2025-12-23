import * as vscode from "vscode";
import assert from "node:assert";
import { randomBytes } from "node:crypto";

import { formatRelativeTime } from "mux/browser/utils/ui/dateTime";
import type { WorkspaceChatMessage } from "mux/common/orpc/types";

import {
  getAllWorkspacesFromFiles,
  getAllWorkspacesFromApi,
  getWorkspacePath,
  WorkspaceWithContext,
} from "./muxConfig";
import { checkAuth, checkServerReachable } from "./api/connectionCheck";
import { createApiClient, type ApiClient } from "./api/client";
import {
  clearAuthTokenOverride,
  discoverServerConfig,
  getConnectionModeSetting,
  storeAuthTokenOverride,
  type ConnectionMode,
} from "./api/discovery";
import { openWorkspace } from "./workspaceOpener";

let sessionPreferredMode: "api" | "file" | null = null;
let didShowFallbackPrompt = false;

const ACTION_FIX_CONNECTION_CONFIG = "Fix connection config";
const ACTION_USE_LOCAL_FILES = "Use local file access";

const PENDING_AUTO_SELECT_STATE_KEY = "mux.pendingAutoSelectWorkspace";
const SELECTED_WORKSPACE_STATE_KEY = "mux.selectedWorkspaceId";
const PENDING_AUTO_SELECT_TTL_MS = 5 * 60_000;

interface PendingAutoSelectState {
  workspaceId: string;
  expectedWorkspaceUri: string;
  createdAtMs: number;
}

interface UiWorkspace {
  id: string;
  label: string;
  description: string;
  streaming: boolean;
  runtimeType: string;
}

interface UiConnectionStatus {
  mode: "api" | "file";
  baseUrl?: string;
  error?: string;
}

type WebviewToExtensionMessage =
  | { type: "ready" }
  | { type: "refreshWorkspaces" }
  | { type: "selectWorkspace"; workspaceId: string | null }
  | { type: "openWorkspace"; workspaceId: string }
  | { type: "sendMessage"; workspaceId: string; text: string }
  | { type: "configureConnection" };

type ExtensionToWebviewMessage =
  | { type: "connectionStatus"; status: UiConnectionStatus }
  | { type: "workspaces"; workspaces: UiWorkspace[] }
  | { type: "setSelectedWorkspace"; workspaceId: string | null }
  | { type: "chatReset"; workspaceId: string }
  | { type: "chatEvent"; workspaceId: string; event: WorkspaceChatMessage }
  | { type: "uiNotice"; level: "info" | "error"; message: string };

function toUiWorkspace(workspace: WorkspaceWithContext): UiWorkspace {
  assert(workspace, "toUiWorkspace requires workspace");

  const isLegacyWorktree =
    workspace.runtimeConfig.type === "local" &&
    "srcBaseDir" in workspace.runtimeConfig &&
    Boolean(workspace.runtimeConfig.srcBaseDir);

  const runtimeType =
    workspace.runtimeConfig.type === "ssh"
      ? "ssh"
      : workspace.runtimeConfig.type === "worktree" || isLegacyWorktree
        ? "worktree"
        : "local";

  const sshSuffix = workspace.runtimeConfig.type === "ssh" ? ` (ssh: ${workspace.runtimeConfig.host})` : "";

  return {
    id: workspace.id,
    label: `[${workspace.projectName}] ${workspace.name}${sshSuffix}`,
    description: workspace.projectPath,
    streaming: workspace.extensionMetadata?.streaming ?? false,
    runtimeType,
  };
}

function getNonce(): string {
  return randomBytes(16).toString("base64");
}

function getOpenFolderUri(workspace: WorkspaceWithContext): vscode.Uri {
  assert(workspace, "getOpenFolderUri requires workspace");

  if (workspace.runtimeConfig.type === "ssh") {
    const host = workspace.runtimeConfig.host;
    const remotePath = getWorkspacePath(workspace);
    return vscode.Uri.parse(`vscode-remote://ssh-remote+${host}${remotePath}`);
  }

  const workspacePath = getWorkspacePath(workspace);
  return vscode.Uri.file(workspacePath);
}

async function setPendingAutoSelectWorkspace(
  context: vscode.ExtensionContext,
  workspace: WorkspaceWithContext
): Promise<void> {
  assert(context, "setPendingAutoSelectWorkspace requires context");
  assert(workspace, "setPendingAutoSelectWorkspace requires workspace");

  const expectedUri = getOpenFolderUri(workspace);
  const state: PendingAutoSelectState = {
    workspaceId: workspace.id,
    expectedWorkspaceUri: expectedUri.toString(),
    createdAtMs: Date.now(),
  };

  await context.globalState.update(PENDING_AUTO_SELECT_STATE_KEY, state);
}

async function getPendingAutoSelectWorkspace(
  context: vscode.ExtensionContext
): Promise<PendingAutoSelectState | null> {
  assert(context, "getPendingAutoSelectWorkspace requires context");

  const pending = context.globalState.get<PendingAutoSelectState>(PENDING_AUTO_SELECT_STATE_KEY);
  if (!pending) {
    return null;
  }

  if (
    typeof pending.workspaceId !== "string" ||
    typeof pending.expectedWorkspaceUri !== "string" ||
    typeof pending.createdAtMs !== "number"
  ) {
    await context.globalState.update(PENDING_AUTO_SELECT_STATE_KEY, undefined);
    return null;
  }

  if (Date.now() - pending.createdAtMs > PENDING_AUTO_SELECT_TTL_MS) {
    await context.globalState.update(PENDING_AUTO_SELECT_STATE_KEY, undefined);
    return null;
  }

  return pending;
}

async function clearPendingAutoSelectWorkspace(context: vscode.ExtensionContext): Promise<void> {
  assert(context, "clearPendingAutoSelectWorkspace requires context");
  await context.globalState.update(PENDING_AUTO_SELECT_STATE_KEY, undefined);
}

function getPrimaryWorkspaceFolderUri(): vscode.Uri | null {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri ?? null;
}

async function revealChatView(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.view.extension.muxSecondary");
  } catch {
    // Ignore - command may not exist in older VS Code or if view container isn't registered.
  }

  try {
    await vscode.commands.executeCommand("mux.chatView.focus");
  } catch {
    // Ignore - focus command may not exist for webview views.
  }
}
const ACTION_CANCEL = "Cancel";

type ApiConnectionFailure =
  | { kind: "unreachable"; baseUrl: string; error: string }
  | { kind: "unauthorized"; baseUrl: string; error: string }
  | { kind: "error"; baseUrl: string; error: string };

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeFailure(failure: ApiConnectionFailure): string {
  switch (failure.kind) {
    case "unreachable":
      return `mux server is not reachable at ${failure.baseUrl}`;
    case "unauthorized":
      return `mux server rejected the auth token at ${failure.baseUrl}`;
    case "error":
      return `mux server connection failed at ${failure.baseUrl}`;
  }
}

function getWarningSuffix(failure: ApiConnectionFailure): string {
  if (failure.kind === "unauthorized") {
    return "Using local file access while mux is running can cause inconsistencies.";
  }
  return "Using local file access can cause inconsistencies.";
}

async function tryGetApiClient(
  context: vscode.ExtensionContext
): Promise<{ client: ApiClient; baseUrl: string } | { failure: ApiConnectionFailure }> {
  assert(context, "tryGetApiClient requires context");

  try {
    const discovery = await discoverServerConfig(context);
    const client = createApiClient({ baseUrl: discovery.baseUrl, authToken: discovery.authToken });

    const reachable = await checkServerReachable(discovery.baseUrl);
    if (reachable.status !== "ok") {
      return {
        failure: {
          kind: "unreachable",
          baseUrl: discovery.baseUrl,
          error: reachable.error,
        },
      };
    }

    const auth = await checkAuth(client);
    if (auth.status === "unauthorized") {
      return {
        failure: {
          kind: "unauthorized",
          baseUrl: discovery.baseUrl,
          error: auth.error,
        },
      };
    }
    if (auth.status !== "ok") {
      return {
        failure: {
          kind: "error",
          baseUrl: discovery.baseUrl,
          error: auth.error,
        },
      };
    }

    return {
      client,
      baseUrl: discovery.baseUrl,
    };
  } catch (error) {
    return {
      failure: {
        kind: "error",
        baseUrl: "unknown",
        error: formatError(error),
      },
    };
  }
}

async function tryGetWorkspacesFromApi(
  context: vscode.ExtensionContext
): Promise<{ workspaces: WorkspaceWithContext[] } | { failure: ApiConnectionFailure }> {
  const api = await tryGetApiClient(context);
  if ("failure" in api) {
    return api;
  }

  const workspaces = await getAllWorkspacesFromApi(api.client);
  return { workspaces };
}

async function getWorkspacesForCommand(
  context: vscode.ExtensionContext
): Promise<WorkspaceWithContext[] | null> {
  const modeSetting: ConnectionMode = getConnectionModeSetting();

  if (modeSetting === "file-only" || sessionPreferredMode === "file") {
    sessionPreferredMode = "file";
    return getAllWorkspacesFromFiles();
  }

  const apiResult = await tryGetWorkspacesFromApi(context);
  if ("workspaces" in apiResult) {
    sessionPreferredMode = "api";
    return apiResult.workspaces;
  }

  const failure = apiResult.failure;

  if (modeSetting === "server-only") {
    const selection = await vscode.window.showErrorMessage(
      `mux: ${describeFailure(failure)}. (${failure.error})`,
      ACTION_FIX_CONNECTION_CONFIG
    );

    if (selection === ACTION_FIX_CONNECTION_CONFIG) {
      await configureConnectionCommand(context);
    }

    return null;
  }

  // modeSetting is auto.
  if (didShowFallbackPrompt) {
    sessionPreferredMode = "file";
    void vscode.window.showWarningMessage(
      `mux: ${describeFailure(failure)}. Falling back to local file access. Run "mux: Configure Connection" to fix.`
    );
    return getAllWorkspacesFromFiles();
  }

  const selection = await vscode.window.showWarningMessage(
    `mux: ${describeFailure(failure)}. ${getWarningSuffix(failure)}`,
    ACTION_FIX_CONNECTION_CONFIG,
    ACTION_USE_LOCAL_FILES,
    ACTION_CANCEL
  );

  if (!selection || selection === ACTION_CANCEL) {
    return null;
  }

  didShowFallbackPrompt = true;

  if (selection === ACTION_USE_LOCAL_FILES) {
    sessionPreferredMode = "file";
    return getAllWorkspacesFromFiles();
  }

  await configureConnectionCommand(context);

  const retry = await tryGetWorkspacesFromApi(context);
  if ("workspaces" in retry) {
    sessionPreferredMode = "api";
    return retry.workspaces;
  }

  // Still can't connect; fall back without prompting again.
  sessionPreferredMode = "file";
  void vscode.window.showWarningMessage(
    `mux: ${describeFailure(retry.failure)}. Falling back to local file access. (${retry.failure.error})`
  );
  return getAllWorkspacesFromFiles();
}

/**
 * Get the icon for a runtime type
 * - local (project-dir): $(folder) - simple folder, uses project directly
 * - worktree: $(git-branch) - git worktree isolation
 * - legacy local with srcBaseDir: $(git-branch) - treated as worktree
 * - ssh: $(remote) - remote execution
 */
function getRuntimeIcon(runtimeConfig: WorkspaceWithContext["runtimeConfig"]): string {
  if (runtimeConfig.type === "ssh") {
    return "$(remote)";
  }
  if (runtimeConfig.type === "worktree") {
    return "$(git-branch)";
  }
  // type === "local": check if it has srcBaseDir (legacy worktree) or not (project-dir)
  if ("srcBaseDir" in runtimeConfig && runtimeConfig.srcBaseDir) {
    return "$(git-branch)"; // Legacy worktree
  }
  return "$(folder)"; // Project-dir local
}

/**
 * Format workspace for display in QuickPick
 */
function formatWorkspaceLabel(workspace: WorkspaceWithContext): string {
  // Choose icon based on streaming status and runtime type
  const icon = workspace.extensionMetadata?.streaming
    ? "$(sync~spin)" // Spinning icon for active streaming
    : getRuntimeIcon(workspace.runtimeConfig);

  const baseName = `${icon} [${workspace.projectName}] ${workspace.name}`;

  // Add SSH host info if applicable
  if (workspace.runtimeConfig.type === "ssh") {
    return `${baseName} (ssh: ${workspace.runtimeConfig.host})`;
  }

  return baseName;
}

/**
 * Create QuickPick item for a workspace
 */
function createWorkspaceQuickPickItem(
  workspace: WorkspaceWithContext
): vscode.QuickPickItem & { workspace: WorkspaceWithContext } {
  // Prefer recency (last used) over created timestamp
  let detail: string | undefined;
  if (workspace.extensionMetadata?.recency) {
    detail = `Last used: ${formatRelativeTime(workspace.extensionMetadata.recency)}`;
  } else if (workspace.createdAt) {
    detail = `Created: ${new Date(workspace.createdAt).toLocaleDateString()}`;
  }

  return {
    label: formatWorkspaceLabel(workspace),
    description: workspace.projectPath,
    detail,
    workspace,
  };
}

/**
 * Command: Open a mux workspace
 */
async function openWorkspaceCommand(context: vscode.ExtensionContext) {
  // Get all workspaces, this is intentionally not cached.
  const workspaces = await getWorkspacesForCommand(context);
  if (!workspaces) {
    return;
  }

  if (workspaces.length === 0) {
    const selection = await vscode.window.showInformationMessage(
      "No mux workspaces found. Create a workspace in mux first.",
      "Open mux"
    );

    // User can't easily open mux from VS Code, so just inform them
    if (selection === "Open mux") {
      vscode.window.showInformationMessage("Please open the mux application to create workspaces.");
    }
    return;
  }

  // Create QuickPick items (already sorted by recency in getAllWorkspaces)
  const allItems = workspaces.map(createWorkspaceQuickPickItem);

  // Use createQuickPick for more control over sorting behavior
  const quickPick = vscode.window.createQuickPick<
    vscode.QuickPickItem & { workspace: WorkspaceWithContext }
  >();
  quickPick.placeholder = "Select a mux workspace to open";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = false;
  quickPick.items = allItems;

  // When user types, filter items but preserve recency order
  quickPick.onDidChangeValue((value) => {
    if (!value) {
      // No filter - show all items in recency order
      quickPick.items = allItems;
      return;
    }

    // Filter items manually to preserve recency order
    const lowerValue = value.toLowerCase();
    quickPick.items = allItems.filter((item) => {
      const labelMatch = item.label.toLowerCase().includes(lowerValue);
      const descMatch = item.description?.toLowerCase().includes(lowerValue);
      return labelMatch || descMatch;
    });
  });

  quickPick.show();

  // Wait for user selection
  const selected = await new Promise<
    (vscode.QuickPickItem & { workspace: WorkspaceWithContext }) | undefined
  >((resolve) => {
    quickPick.onDidAccept(() => {
      resolve(quickPick.selectedItems[0]);
      quickPick.dispose();
    });
    quickPick.onDidHide(() => {
      resolve(undefined);
      quickPick.dispose();
    });
  });

  if (!selected) {
    return;
  }

  // Open the selected workspace
  await setPendingAutoSelectWorkspace(context, selected.workspace);
  await openWorkspace(selected.workspace);
}

async function configureConnectionCommand(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("mux");

  // Small loop so users can set/clear both URL + token in one command.
  // Keep UX minimal: no nested quick picks or extra commands.
  for (;;) {
    const currentUrl = config.get<string>("serverUrl")?.trim() ?? "";
    const hasToken = (await context.secrets.get("mux.serverAuthToken")) !== undefined;

    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "Set server URL",
          description: currentUrl ? `Current: ${currentUrl}` : "Current: auto-discover",
        },
        ...(currentUrl
          ? ([{ label: "Clear server URL override", description: "Use env/lockfile/default" }] as const)
          : ([] as const)),
        {
          label: "Set auth token",
          description: hasToken ? "Current: set" : "Current: none",
        },
        ...(hasToken ? ([{ label: "Clear auth token" }] as const) : ([] as const)),
        { label: "Done" },
      ],
      { placeHolder: "Configure mux server connection" }
    );

    if (!pick || pick.label === "Done") {
      return;
    }

    if (pick.label === "Set server URL") {
      const value = await vscode.window.showInputBox({
        title: "mux server URL",
        value: currentUrl,
        prompt: "Example: http://127.0.0.1:3000 (leave blank for auto-discovery)",
        validateInput(input) {
          const trimmed = input.trim();
          if (!trimmed) {
            return null;
          }
          try {
            const url = new URL(trimmed);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
              return "URL must start with http:// or https://";
            }
            return null;
          } catch {
            return "Invalid URL";
          }
        },
      });

      if (value === undefined) {
        continue;
      }

      const trimmed = value.trim();
      await config.update(
        "serverUrl",
        trimmed ? trimmed : undefined,
        vscode.ConfigurationTarget.Global
      );
      continue;
    }

    if (pick.label === "Clear server URL override") {
      await config.update("serverUrl", undefined, vscode.ConfigurationTarget.Global);
      continue;
    }

    if (pick.label === "Set auth token") {
      const token = await vscode.window.showInputBox({
        title: "mux server auth token",
        prompt: "Paste the mux server auth token",
        password: true,
        validateInput(input) {
          return input.trim().length > 0 ? null : "Token cannot be empty";
        },
      });

      if (token === undefined) {
        continue;
      }

      await storeAuthTokenOverride(context, token.trim());
      continue;
    }

    if (pick.label === "Clear auth token") {
      await clearAuthTokenOverride(context);
      continue;
    }
  }
}




async function getWorkspacesForSidebar(
  context: vscode.ExtensionContext
): Promise<{ workspaces: WorkspaceWithContext[]; status: UiConnectionStatus }> {
  assert(context, "getWorkspacesForSidebar requires context");

  const modeSetting: ConnectionMode = getConnectionModeSetting();

  if (modeSetting === "file-only") {
    const workspaces = await getAllWorkspacesFromFiles();
    return { workspaces, status: { mode: "file" } };
  }

  const api = await tryGetApiClient(context);
  if ("failure" in api) {
    const failure = api.failure;

    if (modeSetting === "server-only") {
      return {
        workspaces: [],
        status: {
          mode: "file",
          baseUrl: failure.baseUrl,
          error: `${describeFailure(failure)}. (${failure.error})`,
        },
      };
    }

    const workspaces = await getAllWorkspacesFromFiles();
    return {
      workspaces,
      status: {
        mode: "file",
        baseUrl: failure.baseUrl,
        error: `${describeFailure(failure)}. ${getWarningSuffix(failure)} (${failure.error})`,
      },
    };
  }

  const workspaces = await getAllWorkspacesFromApi(api.client);
  return {
    workspaces,
    status: {
      mode: "api",
      baseUrl: api.baseUrl,
    },
  };
}

function findWorkspaceIdMatchingCurrentFolder(workspaces: WorkspaceWithContext[]): string | null {
  assert(Array.isArray(workspaces), "findWorkspaceIdMatchingCurrentFolder requires workspaces array");

  const folderUri = getPrimaryWorkspaceFolderUri();
  if (!folderUri) {
    return null;
  }

  const folderUriString = folderUri.toString();
  for (const workspace of workspaces) {
    const expected = getOpenFolderUri(workspace).toString();
    if (expected === folderUriString) {
      return workspace.id;
    }
  }

  return null;
}

function renderChatViewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style nonce="${nonce}">
      :root {
        color-scheme: light dark;
      }
      body {
        padding: 0;
        margin: 0;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }
      #container {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }
      #top {
        padding: 10px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBar-background);
      }
      #status {
        font-size: 12px;
        line-height: 1.3;
        margin-bottom: 8px;
        opacity: 0.9;
        white-space: pre-wrap;
      }
      .row {
        display: flex;
        gap: 6px;
        align-items: center;
        margin-top: 6px;
      }
      select {
        flex: 1;
        min-width: 120px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        padding: 4px 6px;
      }
      button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: 1px solid transparent;
        padding: 4px 8px;
        cursor: pointer;
      }
      button.secondary {
        background: transparent;
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-input-border);
      }
      button:disabled {
        opacity: 0.6;
        cursor: default;
      }
      #messages {
        flex: 1;
        overflow-y: auto;
        padding: 10px;
      }
      .msg {
        padding: 8px 10px;
        border-radius: 6px;
        margin-bottom: 8px;
        background: rgba(127, 127, 127, 0.12);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .msg .meta {
        font-size: 11px;
        opacity: 0.75;
        margin-bottom: 4px;
      }
      .msg.user {
        background: rgba(0, 122, 204, 0.18);
      }
      .msg.assistant {
        background: rgba(127, 127, 127, 0.12);
      }
      .msg.notice {
        background: transparent;
        border: 1px dashed var(--vscode-input-border);
      }
      .msg.notice.error {
        border-color: var(--vscode-inputValidation-errorBorder);
      }
      #composer {
        border-top: 1px solid var(--vscode-panel-border);
        padding: 10px;
        background: var(--vscode-sideBar-background);
        display: flex;
        gap: 8px;
        align-items: flex-end;
      }
      textarea {
        flex: 1;
        resize: vertical;
        min-height: 52px;
        max-height: 160px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        padding: 6px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }
    </style>
  </head>
  <body>
    <div id="container">
      <div id="top">
        <div id="status">Loading mux…</div>
        <div class="row">
          <select id="workspaceSelect"></select>
          <button id="refreshBtn" class="secondary" type="button">Refresh</button>
          <button id="openBtn" type="button">Open</button>
        </div>
        <div class="row">
          <button id="configureBtn" class="secondary" type="button">Configure Connection</button>
        </div>
      </div>

      <div id="messages"></div>

      <div id="composer">
        <textarea id="input" placeholder="Message mux…"></textarea>
        <button id="sendBtn" type="button">Send</button>
      </div>
    </div>

    <script nonce="${nonce}">
      (function () {
        const vscode = acquireVsCodeApi();

        const statusEl = document.getElementById('status');
        const workspaceSelectEl = document.getElementById('workspaceSelect');
        const refreshBtn = document.getElementById('refreshBtn');
        const openBtn = document.getElementById('openBtn');
        const configureBtn = document.getElementById('configureBtn');
        const messagesEl = document.getElementById('messages');
        const inputEl = document.getElementById('input');
        const sendBtn = document.getElementById('sendBtn');

        const state = {
          workspaces: [],
          selectedWorkspaceId: null,
          connectionStatus: { mode: 'file' },
        };

        const streamElsByMessageId = new Map();

        function setStatusText(text) {
          statusEl.textContent = text;
        }

        function updateControls() {
          const hasSelection = Boolean(state.selectedWorkspaceId);
          openBtn.disabled = !hasSelection;

          const canChat = state.connectionStatus && state.connectionStatus.mode === 'api' && hasSelection;
          sendBtn.disabled = !canChat;
          inputEl.disabled = !canChat;

          if (!canChat) {
            inputEl.placeholder = hasSelection
              ? 'Chat requires mux server connection.'
              : 'Select a mux workspace to chat.';
          } else {
            inputEl.placeholder = 'Message mux…';
          }
        }

        function renderWorkspaces() {
          while (workspaceSelectEl.firstChild) {
            workspaceSelectEl.removeChild(workspaceSelectEl.firstChild);
          }

          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = state.workspaces.length > 0 ? 'Select workspace…' : 'No workspaces found';
          workspaceSelectEl.appendChild(placeholder);

          for (const ws of state.workspaces) {
            const opt = document.createElement('option');
            opt.value = ws.id;
            opt.textContent = ws.label;
            workspaceSelectEl.appendChild(opt);
          }

          workspaceSelectEl.value = state.selectedWorkspaceId || '';
          updateControls();
        }

        function setConnectionStatus(status) {
          state.connectionStatus = status;

          if (status.mode === 'api') {
            setStatusText('Connected to mux server\n' + (status.baseUrl || ''));
          } else {
            const parts = [];
            parts.push('Using local file access');
            if (status.error) {
              parts.push(status.error);
            }
            if (status.baseUrl) {
              parts.push('Server: ' + status.baseUrl);
            }
            setStatusText(parts.join('\n'));
          }

          updateControls();
        }

        function appendNotice(level, message) {
          const el = document.createElement('div');
          el.className = 'msg notice ' + (level || 'info');
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = level === 'error' ? 'error' : 'info';
          const body = document.createElement('div');
          body.textContent = message;
          el.appendChild(meta);
          el.appendChild(body);
          messagesEl.appendChild(el);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function extractTextParts(parts) {
          if (!Array.isArray(parts)) {
            return '';
          }

          const out = [];
          for (const p of parts) {
            if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
              out.push(p.text);
            }
          }
          return out.join('');
        }

        function ensureStreamingMessage(messageId) {
          if (streamElsByMessageId.has(messageId)) {
            return streamElsByMessageId.get(messageId);
          }

          const el = document.createElement('div');
          el.className = 'msg assistant';

          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = 'assistant (streaming)';

          const body = document.createElement('div');
          body.textContent = '';

          el.appendChild(meta);
          el.appendChild(body);
          messagesEl.appendChild(el);

          streamElsByMessageId.set(messageId, { root: el, body });
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return streamElsByMessageId.get(messageId);
        }

        function handleChatEvent(event) {
          if (!event || typeof event !== 'object') {
            return;
          }

          if (event.type === 'message') {
            const role = event.role || 'unknown';
            const el = document.createElement('div');
            el.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');

            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = role;

            const body = document.createElement('div');
            body.textContent = extractTextParts(event.parts) || '';

            el.appendChild(meta);
            el.appendChild(body);
            messagesEl.appendChild(el);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return;
          }

          if (event.type === 'stream-start') {
            ensureStreamingMessage(event.messageId);
            return;
          }

          if (event.type === 'stream-delta') {
            const item = ensureStreamingMessage(event.messageId);
            if (typeof event.delta === 'string') {
              item.body.textContent += event.delta;
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            return;
          }

          if (event.type === 'stream-end') {
            const item = ensureStreamingMessage(event.messageId);
            const finalText = extractTextParts(event.parts);
            if (finalText) {
              item.body.textContent = finalText;
            }
            const meta = item.root.querySelector('.meta');
            if (meta) {
              meta.textContent = 'assistant';
            }
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return;
          }

          if (event.type === 'stream-error') {
            appendNotice('error', event.error || 'Stream error');
            return;
          }

          if (event.type === 'caught-up') {
            // No-op (history replay completed).
            return;
          }
        }

        function resetChat() {
          streamElsByMessageId.clear();
          while (messagesEl.firstChild) {
            messagesEl.removeChild(messagesEl.firstChild);
          }
        }

        workspaceSelectEl.addEventListener('change', () => {
          const id = workspaceSelectEl.value || null;
          vscode.postMessage({ type: 'selectWorkspace', workspaceId: id });
        });

        refreshBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'refreshWorkspaces' });
        });

        openBtn.addEventListener('click', () => {
          if (!state.selectedWorkspaceId) {
            return;
          }
          vscode.postMessage({ type: 'openWorkspace', workspaceId: state.selectedWorkspaceId });
        });

        configureBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'configureConnection' });
        });

        function sendCurrentInput() {
          const text = String(inputEl.value || '').trim();
          if (!text) {
            return;
          }
          if (!state.selectedWorkspaceId) {
            return;
          }
          vscode.postMessage({ type: 'sendMessage', workspaceId: state.selectedWorkspaceId, text });
          inputEl.value = '';
        }

        sendBtn.addEventListener('click', sendCurrentInput);
        inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendCurrentInput();
          }
        });

        window.addEventListener('message', (ev) => {
          const msg = ev.data;
          if (!msg || typeof msg !== 'object' || !msg.type) {
            return;
          }

          if (msg.type === 'connectionStatus') {
            setConnectionStatus(msg.status);
            return;
          }

          if (msg.type === 'workspaces') {
            state.workspaces = Array.isArray(msg.workspaces) ? msg.workspaces : [];
            renderWorkspaces();
            return;
          }

          if (msg.type === 'setSelectedWorkspace') {
            state.selectedWorkspaceId = msg.workspaceId || null;
            workspaceSelectEl.value = state.selectedWorkspaceId || '';
            updateControls();
            return;
          }

          if (msg.type === 'chatReset') {
            resetChat();
            return;
          }

          if (msg.type === 'chatEvent') {
            handleChatEvent(msg.event);
            return;
          }

          if (msg.type === 'uiNotice') {
            appendNotice(msg.level, msg.message);
            return;
          }
        });

        vscode.postMessage({ type: 'ready' });
      })();
    </script>
  </body>
</html>`;
}

class MuxChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private isWebviewReady = false;

  private connectionStatus: UiConnectionStatus = { mode: "file" };
  private workspaces: WorkspaceWithContext[] = [];
  private workspacesById = new Map<string, WorkspaceWithContext>();

  private selectedWorkspaceId: string | null;
  private subscribedWorkspaceId: string | null = null;
  private subscriptionAbort: AbortController | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.selectedWorkspaceId = context.workspaceState.get<string>(SELECTED_WORKSPACE_STATE_KEY) ?? null;
  }

  dispose(): void {
    this.subscriptionAbort?.abort();
    this.subscriptionAbort = null;
    this.subscribedWorkspaceId = null;
  }

  async setSelectedWorkspaceId(workspaceId: string | null): Promise<void> {
    if (workspaceId !== null) {
      assert(typeof workspaceId === "string", "workspaceId must be string or null");
    }

    if (workspaceId === this.selectedWorkspaceId) {
      this.postMessage({ type: "setSelectedWorkspace", workspaceId });
      await this.updateChatSubscription();
      return;
    }

    this.selectedWorkspaceId = workspaceId;
    await this.context.workspaceState.update(
      SELECTED_WORKSPACE_STATE_KEY,
      workspaceId ? workspaceId : undefined
    );

    this.postMessage({ type: "setSelectedWorkspace", workspaceId });
    await this.updateChatSubscription();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.isWebviewReady = false;

    view.webview.options = {
      enableScripts: true,
    };

    view.webview.html = renderChatViewHtml(view.webview);

    view.webview.onDidReceiveMessage((msg: unknown) => {
      void this.onWebviewMessage(msg);
    });

    view.onDidDispose(() => {
      this.view = undefined;
      this.isWebviewReady = false;
      this.dispose();
    });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    if (!this.view || !this.isWebviewReady) {
      return;
    }

    void this.view.webview.postMessage(message);
  }

  private async onWebviewMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null || !("type" in raw)) {
      return;
    }

    const msg = raw as { type: unknown; [key: string]: unknown };
    if (typeof msg.type !== "string") {
      return;
    }

    const type = msg.type as WebviewToExtensionMessage["type"];

    if (type === "ready") {
      this.isWebviewReady = true;
      await this.refreshWorkspaces();
      this.postMessage({ type: "setSelectedWorkspace", workspaceId: this.selectedWorkspaceId });
      await this.updateChatSubscription();
      return;
    }

    if (type === "refreshWorkspaces") {
      await this.refreshWorkspaces();
      return;
    }

    if (type === "selectWorkspace") {
      const workspaceId = typeof msg.workspaceId === "string" ? msg.workspaceId : null;
      await this.setSelectedWorkspaceId(workspaceId);
      return;
    }

    if (type === "openWorkspace") {
      if (typeof msg.workspaceId !== "string") {
        return;
      }
      await this.openWorkspaceFromView(msg.workspaceId);
      return;
    }

    if (type === "sendMessage") {
      if (typeof msg.workspaceId !== "string" || typeof msg.text !== "string") {
        return;
      }
      await this.sendMessage(msg.workspaceId, msg.text);
      return;
    }

    if (type === "configureConnection") {
      await configureConnectionCommand(this.context);
      await this.refreshWorkspaces();
      return;
    }
  }

  private async refreshWorkspaces(): Promise<void> {
    const result = await getWorkspacesForSidebar(this.context);

    this.connectionStatus = result.status;
    this.workspaces = result.workspaces;
    this.workspacesById = new Map(this.workspaces.map((w) => [w.id, w]));

    this.postMessage({ type: "connectionStatus", status: this.connectionStatus });
    this.postMessage({ type: "workspaces", workspaces: this.workspaces.map(toUiWorkspace) });

    if (!this.selectedWorkspaceId) {
      const match = findWorkspaceIdMatchingCurrentFolder(this.workspaces);
      if (match) {
        await this.setSelectedWorkspaceId(match);
      }
    }

    await this.updateChatSubscription();
  }

  private async updateChatSubscription(): Promise<void> {
    if (!this.isWebviewReady || !this.view) {
      return;
    }

    const workspaceId = this.selectedWorkspaceId;
    if (!workspaceId || this.connectionStatus.mode !== "api") {
      this.subscriptionAbort?.abort();
      this.subscriptionAbort = null;
      this.subscribedWorkspaceId = null;
      return;
    }

    if (this.subscribedWorkspaceId === workspaceId && this.subscriptionAbort && !this.subscriptionAbort.signal.aborted) {
      return;
    }

    this.subscriptionAbort?.abort();

    const controller = new AbortController();
    this.subscriptionAbort = controller;
    this.subscribedWorkspaceId = workspaceId;

    this.postMessage({ type: "chatReset", workspaceId });

    const api = await tryGetApiClient(this.context);
    if ("failure" in api) {
      // Drop back to file mode (chat disabled).
      this.connectionStatus = {
        mode: "file",
        baseUrl: api.failure.baseUrl,
        error: `${describeFailure(api.failure)}. (${api.failure.error})`,
      };
      this.postMessage({ type: "connectionStatus", status: this.connectionStatus });
      this.postMessage({
        type: "uiNotice",
        level: "error",
        message: this.connectionStatus.error ?? "mux server unavailable",
      });

      controller.abort();
      if (this.subscriptionAbort === controller) {
        this.subscriptionAbort = null;
        this.subscribedWorkspaceId = null;
      }
      return;
    }

    try {
      const iterator = await api.client.workspace.onChat({ workspaceId }, { signal: controller.signal });

      for await (const event of iterator) {
        if (controller.signal.aborted) {
          return;
        }

        // Defensive: selection could change without abort (rare race).
        if (this.selectedWorkspaceId !== workspaceId) {
          return;
        }

        this.postMessage({ type: "chatEvent", workspaceId, event });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }

      this.postMessage({
        type: "uiNotice",
        level: "error",
        message: `Chat subscription error: ${formatError(error)}`,
      });
    } finally {
      if (this.subscriptionAbort === controller) {
        this.subscriptionAbort = null;
        this.subscribedWorkspaceId = null;
      }
    }
  }

  private async sendMessage(workspaceId: string, text: string): Promise<void> {
    assert(typeof workspaceId === "string", "sendMessage requires workspaceId");
    assert(typeof text === "string", "sendMessage requires text");

    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    if (this.connectionStatus.mode !== "api") {
      this.postMessage({
        type: "uiNotice",
        level: "error",
        message: "Chat requires a running mux server.",
      });
      return;
    }

    const api = await tryGetApiClient(this.context);
    if ("failure" in api) {
      this.postMessage({
        type: "uiNotice",
        level: "error",
        message: `${describeFailure(api.failure)}. (${api.failure.error})`,
      });
      return;
    }

    const result = await api.client.workspace.sendMessage({
      workspaceId,
      message: trimmed,
    });

    if (!result.success) {
      const errorString =
        typeof result.error === "string" ? result.error : JSON.stringify(result.error, null, 2);
      this.postMessage({
        type: "uiNotice",
        level: "error",
        message: `Send failed: ${errorString}`,
      });
    }
  }

  private async openWorkspaceFromView(workspaceId: string): Promise<void> {
    assert(typeof workspaceId === "string", "openWorkspaceFromView requires workspaceId");

    const workspace = this.workspacesById.get(workspaceId);
    if (!workspace) {
      this.postMessage({
        type: "uiNotice",
        level: "error",
        message: "Workspace not found. Refresh and try again.",
      });
      return;
    }

    await setPendingAutoSelectWorkspace(this.context, workspace);
    await openWorkspace(workspace);
  }
}

async function maybeAutoRevealChatViewFromPendingSelection(
  context: vscode.ExtensionContext,
  provider: MuxChatViewProvider
): Promise<void> {
  const pending = await getPendingAutoSelectWorkspace(context);
  if (!pending) {
    return;
  }

  const folderUri = getPrimaryWorkspaceFolderUri();
  if (!folderUri) {
    return;
  }

  if (folderUri.toString() !== pending.expectedWorkspaceUri) {
    return;
  }

  await clearPendingAutoSelectWorkspace(context);
  await provider.setSelectedWorkspaceId(pending.workspaceId);
  await revealChatView();
}

/**
 * Activate the extension
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const chatViewProvider = new MuxChatViewProvider(context);

  context.subscriptions.push(chatViewProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("mux.chatView", chatViewProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mux.openWorkspace", () => openWorkspaceCommand(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mux.configureConnection", () => configureConnectionCommand(context))
  );

  await maybeAutoRevealChatViewFromPendingSelection(context, chatViewProvider);
}

/**
 * Deactivate the extension
 */
export function deactivate() {}

