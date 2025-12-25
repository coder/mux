import * as vscode from "vscode";
import assert from "node:assert";
import { createHash, randomBytes } from "node:crypto";

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
  | { type: "configureConnection" }
  | { type: "debugLog"; message: string; data?: unknown }
  | { type: "copyDebugLog"; text: string };

type ExtensionToWebviewMessage =
  | { type: "connectionStatus"; status: UiConnectionStatus }
  | { type: "workspaces"; workspaces: UiWorkspace[] }
  | { type: "setSelectedWorkspace"; workspaceId: string | null }
  | { type: "chatReset"; workspaceId: string }
  | { type: "chatEvent"; workspaceId: string; event: WorkspaceChatMessage }
  | { type: "uiNotice"; level: "info" | "error"; message: string }
  | { type: "debugProbe"; attempt: number; sentAtMs: number };

let muxLogChannel: vscode.LogOutputChannel | undefined;

function getMuxLogChannel(): vscode.LogOutputChannel {
  if (!muxLogChannel) {
    muxLogChannel = vscode.window.createOutputChannel("Mux", { log: true });
  }

  return muxLogChannel;
}

function formatLogData(data: unknown): string {
  if (data === undefined) {
    return "";
  }

  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function muxLog(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
  const channel = getMuxLogChannel();
  const suffix = data === undefined ? "" : ` ${formatLogData(data)}`;

  switch (level) {
    case "debug":
      channel.debug(message + suffix);
      return;
    case "info":
      channel.info(message + suffix);
      return;
    case "warn":
      channel.warn(message + suffix);
      return;
    case "error":
      channel.error(message + suffix);
      return;
  }
}

function muxLogDebug(message: string, data?: unknown): void {
  muxLog("debug", message, data);
}

function muxLogInfo(message: string, data?: unknown): void {
  muxLog("info", message, data);
}

function muxLogWarn(message: string, data?: unknown): void {
  muxLog("warn", message, data);
}

function muxLogError(message: string, data?: unknown): void {
  muxLog("error", message, data);
}

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
  // Use a CSP nonce format that is known to work well in VS Code webviews.
  // (Hex avoids characters like "+" and "/" that can be awkward to debug.)
  return randomBytes(16).toString("hex");
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

  muxLogDebug("mux: tryGetApiClient start");

  try {
    const discovery = await discoverServerConfig(context);

    muxLogDebug("mux: discovered server config", {
      baseUrl: discovery.baseUrl,
      baseUrlSource: discovery.baseUrlSource,
      authTokenSource: discovery.authTokenSource,
      hasAuthToken: Boolean(discovery.authToken),
    });

    const client = createApiClient({ baseUrl: discovery.baseUrl, authToken: discovery.authToken });

    const reachable = await checkServerReachable(discovery.baseUrl);
    muxLogDebug("mux: server reachable check", reachable);
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
    muxLogDebug("mux: auth check", auth);

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

    muxLogDebug("mux: tryGetApiClient success", { baseUrl: discovery.baseUrl });

    return {
      client,
      baseUrl: discovery.baseUrl,
    };
  } catch (error) {
    muxLogError("mux: tryGetApiClient threw", { error: formatError(error) });

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




async function debugConnectionCommand(context: vscode.ExtensionContext): Promise<void> {
  assert(context, "debugConnectionCommand requires context");

  const output = getMuxLogChannel();
  output.show(true);

  muxLogInfo("mux: debugConnection start");

  let discovery: Awaited<ReturnType<typeof discoverServerConfig>>;
  try {
    discovery = await discoverServerConfig(context);
  } catch (error) {
    muxLogError("mux: debugConnection discovery failed", { error: formatError(error) });
    void vscode.window.showErrorMessage(`mux: Failed to discover server config. (${formatError(error)})`);
    return;
  }

  muxLogInfo("mux: debugConnection discovered server config", {
    baseUrl: discovery.baseUrl,
    baseUrlSource: discovery.baseUrlSource,
    authTokenSource: discovery.authTokenSource,
    hasAuthToken: Boolean(discovery.authToken),
  });

  const reachable = await checkServerReachable(discovery.baseUrl, { timeoutMs: 2_000 });
  muxLogInfo("mux: debugConnection server reachable", reachable);

  if (reachable.status !== "ok") {
    void vscode.window.showErrorMessage(
      `mux: Server not reachable at ${discovery.baseUrl}. (${reachable.error})`
    );
    return;
  }

  const client = createApiClient({ baseUrl: discovery.baseUrl, authToken: discovery.authToken });

  const auth = await checkAuth(client, { timeoutMs: 2_000 });
  muxLogInfo("mux: debugConnection auth", auth);

  if (auth.status !== "ok") {
    const hint =
      auth.status === "unauthorized"
        ? " Run \"mux: Configure Connection\" to update the auth token."
        : "";

    void vscode.window.showErrorMessage(
      `mux: Failed to authenticate at ${discovery.baseUrl}. (${auth.error})${hint}`
    );
    return;
  }

  let workspaceCount: number | null = null;
  try {
    const workspaces = await getAllWorkspacesFromApi(client);
    workspaceCount = workspaces.length;
    muxLogInfo("mux: debugConnection listed workspaces", { count: workspaceCount });
  } catch (error) {
    muxLogWarn("mux: debugConnection list workspaces failed", { error: formatError(error) });
  }

  void vscode.window.showInformationMessage(
    workspaceCount === null
      ? `mux: Connected to ${discovery.baseUrl} (auth ok).`
      : `mux: Connected to ${discovery.baseUrl} (auth ok). Workspaces: ${workspaceCount}.`
  );
}

async function getWorkspacesForSidebar(
  context: vscode.ExtensionContext
): Promise<{ workspaces: WorkspaceWithContext[]; status: UiConnectionStatus }> {
  assert(context, "getWorkspacesForSidebar requires context");

  const modeSetting: ConnectionMode = getConnectionModeSetting();
  muxLogDebug("mux: getWorkspacesForSidebar", { modeSetting });

  const tryReadFromFiles = async (): Promise<
    { workspaces: WorkspaceWithContext[] } | { error: string }
  > => {
    try {
      return { workspaces: await getAllWorkspacesFromFiles() };
    } catch (error) {
      return { error: formatError(error) };
    }
  };

  if (modeSetting === "file-only") {
    const fileResult = await tryReadFromFiles();
    if ("error" in fileResult) {
      return {
        workspaces: [],
        status: {
          mode: "file",
          error: `Failed to read mux workspaces from local files. (${fileResult.error})`,
        },
      };
    }

    return { workspaces: fileResult.workspaces, status: { mode: "file" } };
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

    const fileResult = await tryReadFromFiles();
    if ("error" in fileResult) {
      return {
        workspaces: [],
        status: {
          mode: "file",
          baseUrl: failure.baseUrl,
          error: `${describeFailure(failure)}. ${getWarningSuffix(failure)} (${failure.error}). Additionally, reading local workspaces failed. (${fileResult.error})`,
        },
      };
    }

    return {
      workspaces: fileResult.workspaces,
      status: {
        mode: "file",
        baseUrl: failure.baseUrl,
        error: `${describeFailure(failure)}. ${getWarningSuffix(failure)} (${failure.error})`,
      },
    };
  }

  try {
    const workspaces = await getAllWorkspacesFromApi(api.client);
    return {
      workspaces,
      status: {
        mode: "api",
        baseUrl: api.baseUrl,
      },
    };
  } catch (error) {
    const apiError = formatError(error);

    if (modeSetting === "server-only") {
      return {
        workspaces: [],
        status: {
          mode: "api",
          baseUrl: api.baseUrl,
          error: `Failed to list mux workspaces from server. (${apiError})`,
        },
      };
    }

    const fileResult = await tryReadFromFiles();
    if ("error" in fileResult) {
      return {
        workspaces: [],
        status: {
          mode: "api",
          baseUrl: api.baseUrl,
          error: `Failed to list mux workspaces from server. (${apiError}). Additionally, reading local workspaces failed. (${fileResult.error})`,
        },
      };
    }

    return {
      workspaces: fileResult.workspaces,
      status: {
        mode: "api",
        baseUrl: api.baseUrl,
        error: `Failed to list mux workspaces from server; falling back to local file access. (${apiError})`,
      },
    };
  }
}

function findWorkspaceIdMatchingCurrentFolder(workspaces: WorkspaceWithContext[]): string | null {
  assert(Array.isArray(workspaces), "findWorkspaceIdMatchingCurrentFolder requires workspaces array");

  const folderUri = getPrimaryWorkspaceFolderUri();
  if (!folderUri) {
    return null;
  }

  const folderUriString = folderUri.toString();
  for (const workspace of workspaces) {
    try {
      const expected = getOpenFolderUri(workspace).toString();
      if (expected === folderUriString) {
        return workspace.id;
      }
    } catch {
      // Best-effort: ignore auto-detection failures.
    }
  }

  return null;
}

function renderChatViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, traceId: string): string {

  assert(typeof traceId === "string" && traceId.length > 0, "traceId must be a non-empty string");

  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "muxChatView.js"));
  const nonce = getNonce();

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
  ].join("; ");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style nonce="${nonce}">
      :root {
        color-scheme: dark;

        /* Minimal subset of mux theme tokens (mirrors src/browser/styles/globals.css). */
        --color-background: hsl(0 0% 12%);
        --color-background-secondary: hsl(60 1% 15%);
        --color-border: #262626;
        --color-foreground: hsl(0 0% 83%);
        --color-muted-foreground: hsl(0 0% 60%);

        --color-button-bg: hsl(0 0% 24%);
        --color-button-hover: hsl(0 0% 29%);
        --color-button-text: hsl(0 0% 80%);

        --color-input-bg: hsl(0 0% 12%);
        --color-input-border: hsla(0 0% 100% / 0.08);

        --color-user-surface: hsla(0 0% 100% / 0.06);
        --color-user-border: hsla(0 0% 100% / 0.1);

        --color-assistant-border: hsl(207 45% 40%);

        --color-message-debug-bg: rgba(0, 0, 0, 0.3);
        --color-message-debug-border: rgba(255, 255, 255, 0.1);
        --color-message-debug-text: rgba(255, 255, 255, 0.8);
      }
      body {
        padding: 0;
        margin: 0;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--color-foreground);
        background: var(--color-background);
      }
      #container {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }
      #top {
        padding: 10px;
        border-bottom: 1px solid var(--color-border);
        background: var(--color-background-secondary);
      }
      #debugPanel {
        margin-bottom: 8px;
      }
      #debugPanel > summary {
        cursor: pointer;
        user-select: none;
        font-size: 12px;
        color: var(--color-muted-foreground);
      }
      #debugLog {
        max-height: 140px;
        overflow-y: auto;
        white-space: pre-wrap;
      }
      #status {
        font-size: 12px;
        line-height: 1.3;
        margin-bottom: 8px;
        color: var(--color-muted-foreground);
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
        background: var(--color-input-bg);
        color: var(--color-foreground);
        border: 1px solid var(--color-input-border);
        border-radius: 8px;
        padding: 4px 6px;
      }
      button {
        background: var(--color-button-bg);
        color: var(--color-button-text);
        border: 1px solid var(--color-input-border);
        border-radius: 8px;
        padding: 4px 10px;
        cursor: pointer;
      }
      button:hover {
        background: var(--color-button-hover);
      }
      button.secondary {
        background: transparent;
      }
      button.secondary:hover {
        background: rgba(255, 255, 255, 0.05);
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
        max-width: 100%;
        margin-bottom: 14px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .msg .meta {
        font-size: 11px;
        color: var(--color-muted-foreground);
        margin-bottom: 6px;
      }
      .msg.user {
        margin-left: auto;
        background: var(--color-user-surface);
        border: 1px solid var(--color-user-border);
        border-radius: 12px;
        padding: 10px 12px;
      }
      .msg.assistant {
        border-left: 2px solid var(--color-assistant-border);
        padding-left: 12px;
        padding-top: 2px;
        padding-bottom: 2px;
      }
      .msg.notice {
        border: 1px dashed var(--color-input-border);
        border-radius: 12px;
        padding: 8px 10px;
      }
      .msg.notice.error {
        border-color: rgba(255, 120, 120, 0.7);
      }
      .part + .part {
        margin-top: 10px;
      }
      details.part {
        border: 1px solid var(--color-input-border);
        border-radius: 10px;
        padding: 6px 8px;
        background: rgba(255, 255, 255, 0.02);
      }
      details.part > summary {
        cursor: pointer;
        user-select: none;
        color: var(--color-foreground);
        font-size: 12px;
      }
      pre {
        margin: 8px 0 0;
        overflow-x: auto;
        border-radius: 8px;
        border: 1px solid var(--color-message-debug-border);
        background: var(--color-message-debug-bg);
        padding: 8px;
        font-size: 12px;
        line-height: 1.35;
        color: var(--color-message-debug-text);
      }
      #composer {
        border-top: 1px solid var(--color-border);
        padding: 10px;
        background: var(--color-background-secondary);
        display: flex;
        gap: 8px;
        align-items: flex-end;
      }
      textarea {
        flex: 1;
        resize: vertical;
        min-height: 52px;
        max-height: 160px;
        background: var(--color-input-bg);
        color: var(--color-foreground);
        border: 1px solid var(--color-input-border);
        border-radius: 8px;
        padding: 6px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }
    </style>
  </head>
  <body data-mux-trace-id="${traceId}">
    <div id="container">
      <div id="top">
        <div id="status">Loading mux… (trace ${traceId}). If this never changes, open Webview Developer Tools.</div>
        <details id="debugPanel">
          <summary>Debug</summary>
          <pre id="staticDebugInfo">traceId: ${traceId}
scriptUri: ${scriptUri}
cspSource: ${webview.cspSource}</pre>
          <div class="row">
            <button id="copyDebugBtn" class="secondary" type="button">Copy debug log</button>
          </div>
          <pre id="debugLog"></pre>
        </details>
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

    <script src="${scriptUri}"></script>

    <script nonce="${nonce}" type="text/plain" data-mux-disabled="1">
      (function () {
        const statusEl = document.getElementById('status');

        const debugLogEl = document.getElementById('debugLog');
        const debugLines = [];
        const DEBUG_MAX_LINES = 200;

        function safeStringify(value) {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        }

        function appendDebug(message, data) {
          const ts = new Date().toISOString();
          const suffix = data === undefined ? '' : ' ' + safeStringify(data);
          debugLines.push(ts + ' ' + message + suffix);
          if (debugLines.length > DEBUG_MAX_LINES) {
            debugLines.splice(0, debugLines.length - DEBUG_MAX_LINES);
          }
          if (debugLogEl) {
            debugLogEl.textContent = debugLines.join('\\n');
            debugLogEl.scrollTop = debugLogEl.scrollHeight;
          }
        }


        if (statusEl) {
          statusEl.textContent = 'mux webview: script started (waiting for extension)…';
        }
        appendDebug('script start');

        let vscode;
        try {
          vscode = acquireVsCodeApi();

          if (statusEl) {
            statusEl.textContent = 'mux webview: acquired VS Code API; sending ready…';
          }
          appendDebug('acquireVsCodeApi ok');
        } catch (error) {
          appendDebug('acquireVsCodeApi failed', String(error));
          if (statusEl) {
            statusEl.textContent = 'Failed to initialize VS Code API. ' + String(error);
          }
          return;
        }

        function postToExtension(payload) {
          try {
            vscode.postMessage(payload);
          } catch (error) {
            appendDebug('postMessage threw', String(error));
          }
        }

        window.addEventListener('error', (ev) => {
          appendDebug('window.error', { message: ev.message, filename: ev.filename, lineno: ev.lineno, colno: ev.colno });
          postToExtension({ type: 'debugLog', message: 'window.error', data: { message: ev.message, filename: ev.filename, lineno: ev.lineno, colno: ev.colno } });
        });

        window.addEventListener('unhandledrejection', (ev) => {
          appendDebug('unhandledrejection', { reason: String(ev.reason) });
          postToExtension({ type: 'debugLog', message: 'unhandledrejection', data: { reason: String(ev.reason) } });
        });

        appendDebug('webview boot');
        postToExtension({ type: 'debugLog', message: 'webview boot' });

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
        const toolElsByToolCallId = new Map();

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

          const parts = [];

          if (status.mode === 'api') {
            parts.push('Connected to mux server');
            if (status.baseUrl) {
              parts.push(status.baseUrl);
            }
          } else {
            parts.push('Using local file access');
            if (status.baseUrl) {
              parts.push('Server: ' + status.baseUrl);
            }
          }

          if (status.error) {
            parts.push(status.error);
          }

          setStatusText(parts.join('\n'));
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

        function clearEl(el) {
          while (el.firstChild) {
            el.removeChild(el.firstChild);
          }
        }

        function formatJson(value) {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        }

        function renderPartsInto(container, parts) {
          clearEl(container);

          if (!Array.isArray(parts)) {
            return;
          }

          if (parts.length === 0) {
            const textEl = document.createElement('div');
            textEl.className = 'part';
            textEl.textContent = '(no content)';
            container.appendChild(textEl);
            return;
          }

          let appended = false;
          let textBuffer = '';

          function flushText() {
            if (!textBuffer) {
              return;
            }

            const textEl = document.createElement('div');
            textEl.className = 'part';
            textEl.textContent = textBuffer;
            container.appendChild(textEl);
            appended = true;
            textBuffer = '';
          }

          for (const part of parts) {
            if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
              continue;
            }

            if (part.type === 'text' && typeof part.text === 'string') {
              textBuffer += part.text;
              continue;
            }

            flushText();

            if (part.type === 'reasoning' && typeof part.text === 'string') {
              const details = document.createElement('details');
              details.className = 'part';

              const summary = document.createElement('summary');
              summary.textContent = 'Reasoning';
              details.appendChild(summary);

              const pre = document.createElement('pre');
              pre.textContent = part.text;
              details.appendChild(pre);

              container.appendChild(details);
              appended = true;
              continue;
            }

            if (part.type === 'dynamic-tool' && typeof part.toolName === 'string') {
              const details = document.createElement('details');
              details.className = 'part';

              const summary = document.createElement('summary');
              summary.textContent = 'Tool: ' + part.toolName;
              details.appendChild(summary);

              const pre = document.createElement('pre');
              let text = 'input:\n' + formatJson(part.input);

              if (part.state === 'output-available') {
                text += '\n\noutput:\n' + formatJson(part.output);
              }

              if (Array.isArray(part.nestedCalls) && part.nestedCalls.length > 0) {
                text += '\n\nnestedCalls:\n' + formatJson(part.nestedCalls);
              }

              pre.textContent = text;
              details.appendChild(pre);

              container.appendChild(details);
              appended = true;
              continue;
            }

            if (part.type === 'file') {
              const fileEl = document.createElement('div');
              fileEl.className = 'part';

              const filename = typeof part.filename === 'string' ? part.filename : part.url;
              fileEl.textContent = 'File: ' + String(filename || '');

              container.appendChild(fileEl);
              appended = true;
              continue;
            }

            const fallback = document.createElement('details');
            fallback.className = 'part';

            const summary = document.createElement('summary');
            summary.textContent = 'Part: ' + part.type;
            fallback.appendChild(summary);

            const pre = document.createElement('pre');
            pre.textContent = formatJson(part);
            fallback.appendChild(pre);

            container.appendChild(fallback);
            appended = true;
          }

          flushText();

          if (!appended) {
            const pre = document.createElement('pre');
            pre.textContent = formatJson(parts);
            container.appendChild(pre);
          }
        }

        function ensureToolEvent(toolCallId, toolName) {
          if (toolElsByToolCallId.has(toolCallId)) {
            return toolElsByToolCallId.get(toolCallId);
          }

          const el = document.createElement('div');
          el.className = 'msg assistant';

          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = 'tool';

          const body = document.createElement('div');

          const details = document.createElement('details');
          details.className = 'part';

          const summary = document.createElement('summary');
          summary.textContent = 'Tool: ' + String(toolName || '');
          details.appendChild(summary);

          const pre = document.createElement('pre');
          pre.textContent = '';
          details.appendChild(pre);

          body.appendChild(details);

          el.appendChild(meta);
          el.appendChild(body);
          messagesEl.appendChild(el);

          const item = { root: el, pre };
          toolElsByToolCallId.set(toolCallId, item);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return item;
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

          const streamText = document.createElement('div');
          streamText.className = 'part';
          streamText.textContent = '';
          body.appendChild(streamText);

          el.appendChild(meta);
          el.appendChild(body);
          messagesEl.appendChild(el);

          const item = { root: el, body, streamText };
          streamElsByMessageId.set(messageId, item);
          messagesEl.scrollTop = messagesEl.scrollHeight;
          return item;
        }

        function handleChatEvent(event) {
          if (!event || typeof event !== 'object') {
            return;
          }

          if (event.type === 'message') {
            const role = typeof event.role === 'string' ? event.role : 'assistant';
            const variant = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'notice';

            const el = document.createElement('div');
            el.className = 'msg ' + variant;

            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = role;

            const body = document.createElement('div');
            renderPartsInto(body, event.parts);

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
              item.streamText.textContent += event.delta;
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
            return;
          }

          if (event.type === 'stream-end') {
            const item = ensureStreamingMessage(event.messageId);
            renderPartsInto(item.body, event.parts);

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

          if (event.type === 'error') {
            appendNotice('error', event.error || 'Error');
            return;
          }

          if (event.type === 'caught-up') {
            // No-op (history replay completed).
            return;
          }

          if (event.type === 'tool-call-start') {
            if (typeof event.toolCallId !== 'string') {
              return;
            }

            const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
            const item = ensureToolEvent(event.toolCallId, toolName);
            item.pre.textContent = 'input:\n' + formatJson(event.args);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return;
          }

          if (event.type === 'tool-call-delta') {
            if (typeof event.toolCallId !== 'string') {
              return;
            }

            const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
            const item = ensureToolEvent(event.toolCallId, toolName);
            const prefix = item.pre.textContent ? '\n\n' : '';
            item.pre.textContent += prefix + 'delta:\n' + formatJson(event.delta);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return;
          }

          if (event.type === 'tool-call-end') {
            if (typeof event.toolCallId !== 'string') {
              return;
            }

            const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
            const item = ensureToolEvent(event.toolCallId, toolName);
            const prefix = item.pre.textContent ? '\n\n' : '';
            item.pre.textContent += prefix + 'result:\n' + formatJson(event.result);
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return;
          }

          if (event.type === 'bash-output') {
            if (typeof event.toolCallId !== 'string') {
              return;
            }

            const item = ensureToolEvent(event.toolCallId, 'bash');
            const prefix = event.isError ? '[stderr] ' : '';
            item.pre.textContent += prefix + String(event.text || '');
            messagesEl.scrollTop = messagesEl.scrollHeight;
            return;
          }

          // Ignore other events (usage deltas, init events, etc.) for now.
        }

        function resetChat() {
          streamElsByMessageId.clear();
          toolElsByToolCallId.clear();
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

        let handshakeComplete = false;
        let readyAttempts = 0;

        const readyInterval = setInterval(() => {
          if (handshakeComplete) {
            return;
          }

          readyAttempts += 1;
          appendDebug('post ready', { attempt: readyAttempts, reason: 'retry' });
          postToExtension({ type: 'ready' });
        }, 1_000);

        function markHandshakeComplete(reason) {
          if (handshakeComplete) {
            return;
          }

          handshakeComplete = true;
          clearInterval(readyInterval);
          appendDebug('handshake complete', { reason, attempts: readyAttempts });
          postToExtension({ type: 'debugLog', message: 'handshake complete', data: { reason, attempts: readyAttempts } });
        }

        readyAttempts += 1;
        appendDebug('post ready', { attempt: readyAttempts, reason: 'initial' });
        postToExtension({ type: 'ready' });

        window.addEventListener('message', (ev) => {
          const msg = ev.data;
          if (!msg || typeof msg !== 'object' || !msg.type) {
            return;
          }

          if (typeof msg.type === 'string' && msg.type !== 'chatEvent') {

          if (msg.type === 'debugProbe') {
            appendDebug('rx debugProbe', msg);

            if (statusEl) {
              statusEl.textContent = 'mux webview: received debugProbe #' + String(msg.attempt ?? '?');
            }

            postToExtension({ type: 'debugLog', message: 'rx debugProbe', data: msg });
            // Re-send ready in case the bridge came up late.
            postToExtension({ type: 'ready' });
            return;
          }
            appendDebug('rx ' + msg.type);
          }

          if (msg.type === 'connectionStatus' || msg.type === 'workspaces' || msg.type === 'setSelectedWorkspace') {
            markHandshakeComplete(msg.type);
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

        // ready handshake is posted via postToExtension + retry timer above.
      })();
    </script>
  </body>
</html>`;

  const htmlHash = createHash("sha256").update(html).digest("hex").slice(0, 12);
  muxLogDebug("mux.chatView: renderChatViewHtml", {
    traceId,
    scriptUri: scriptUri.toString(),
    cspSource: webview.cspSource,
    nonceLength: nonce.length,
    noncePreview: nonce.slice(0, 8),
    htmlLength: html.length,
    htmlHash,
    csp,
  });

  return html;
}

class MuxChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;

  private nextWebviewMessageSeq = 1;

  private traceId: string | null = null;

  private readyProbeInterval: ReturnType<typeof setInterval> | null = null;
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

  private clearReadyProbeInterval(): void {
    if (!this.readyProbeInterval) {
      return;
    }

    clearInterval(this.readyProbeInterval);
    this.readyProbeInterval = null;
  }

  dispose(): void {
    this.clearReadyProbeInterval();

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
    muxLogDebug("mux.chatView: resolveWebviewView", { visible: view.visible });

    // New view instance; clear any previous timers.
    this.clearReadyProbeInterval();

    this.traceId = randomBytes(8).toString("hex");
    muxLogDebug("mux.chatView: traceId assigned", { traceId: this.traceId });

    this.view = view;
    this.isWebviewReady = false;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    muxLogDebug("mux.chatView: webview.options set", {
      enableScripts: view.webview.options.enableScripts ?? false,
      localResourceRoots: (view.webview.options.localResourceRoots ?? []).map((uri) => uri.toString()),
    });

    const visibilityDisposable = view.onDidChangeVisibility(() => {
      muxLogDebug("mux.chatView: view visibility changed", { visible: view.visible });
    });

    // Register the message handler before setting HTML to avoid losing the initial
    // "ready" handshake due to a race.
    const messageDisposable = view.webview.onDidReceiveMessage((msg: unknown) => {
      const msgType =
        typeof msg === "object" &&
        msg !== null &&
        "type" in msg &&
        typeof (msg as { type?: unknown }).type === "string"
          ? (msg as { type: string }).type
          : undefined;

      const meta =
        typeof msg === "object" && msg !== null && "__muxMeta" in msg
          ? (msg as { __muxMeta?: unknown }).__muxMeta
          : undefined;

      muxLogDebug("mux.chatView: <- webview message", {
        traceId: this.traceId,
        type: msgType,
        meta,
      });

      void this.onWebviewMessage(msg).catch((error) => {
        muxLogError("mux.chatView: error handling webview message", { error: formatError(error) });
        console.error("mux.chatView: error handling webview message", error);
        this.postMessage({
          type: "uiNotice",
          level: "error",
          message: `Webview message error: ${formatError(error)}`,
        });
      });
    });

    view.onDidDispose(() => {
      muxLogDebug("mux.chatView: disposed");
      visibilityDisposable.dispose();
      messageDisposable.dispose();
      this.traceId = null;
      this.view = undefined;
      this.isWebviewReady = false;
      this.dispose();
    });

    const traceId = this.traceId;
    assert(typeof traceId === "string" && traceId.length > 0, "mux.chatView: traceId must be set before rendering webview");

    const html = renderChatViewHtml(view.webview, this.context.extensionUri, traceId);
    muxLogDebug("mux.chatView: setting webview.html", { traceId, htmlLength: html.length });
    view.webview.html = html;

    // While debugging the stuck "Loading mux..." state, this sends a message to the webview
    // at a fixed interval until we get a "ready" message back.
    let probeAttempts = 0;
    this.readyProbeInterval = setInterval(() => {
      if (this.view !== view) {
        muxLogDebug("mux.chatView: stopping debugProbe (view changed)");
        this.clearReadyProbeInterval();
        return;
      }

      if (this.isWebviewReady) {
        muxLogDebug("mux.chatView: stopping debugProbe (ready received)");
        this.clearReadyProbeInterval();
        return;
      }

      probeAttempts += 1;
      const attempt = probeAttempts;
      const sentAtMs = Date.now();

      void view.webview.postMessage({ type: "debugProbe", attempt, sentAtMs }).then(
        (delivered) => {
          muxLogDebug("mux.chatView: -> debugProbe", { traceId: this.traceId, attempt, delivered });
        },
        (error) => {
          muxLogWarn("mux.chatView: debugProbe postMessage failed", {
            traceId: this.traceId,
            attempt,
            error: formatError(error),
          });
        }
      );

      if (attempt >= 15) {
        muxLogWarn("mux.chatView: stopping debugProbe after max attempts", { maxAttempts: attempt });
        this.clearReadyProbeInterval();
      }
    }, 1_000);

    setTimeout(() => {
      if (this.view !== view) {
        return;
      }

      if (this.isWebviewReady) {
        return;
      }

      muxLogWarn("mux.chatView: webview has not sent ready after 2s", {
        traceId: this.traceId,
        visible: view.visible,
        cspSource: view.webview.cspSource,
        hint: "Open Webview Developer Tools and look for CSP/script errors; also check Output > Mux.",
      });
    }, 2_000);

    setTimeout(() => {
      if (this.view !== view) {
        return;
      }

      if (this.isWebviewReady) {
        return;
      }

      muxLogError("mux.chatView: webview has not sent ready after 10s", {
        traceId: this.traceId,
        visible: view.visible,
        cspSource: view.webview.cspSource,
        hint: "Open Webview Developer Tools and look for CSP/script errors; also check Output > Mux.",
      });
    }, 10_000);
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    const shouldLog = message.type !== "chatEvent";

    if (!this.view) {
      if (shouldLog) {
        muxLogDebug("mux.chatView: -> drop postMessage (no view)", { traceId: this.traceId, type: message.type });
      }
      return;
    }

    if (!this.isWebviewReady) {
      if (shouldLog) {
        muxLogDebug("mux.chatView: -> drop postMessage (webview not ready)", { traceId: this.traceId, type: message.type });
      }
      return;
    }

    const seq = this.nextWebviewMessageSeq++;
    const meta = {
      traceId: this.traceId,
      seq,
      sentAtMs: Date.now(),
    };

    const envelope: Record<string, unknown> = { __muxMeta: meta, ...message };

    void this.view.webview.postMessage(envelope).then(
      (delivered) => {
        if (shouldLog) {
          muxLogDebug("mux.chatView: -> postMessage", {
            traceId: this.traceId,
            seq,
            type: message.type,
            delivered,
          });
        }
      },
      (error) => {
        muxLogWarn("mux.chatView: postMessage failed", {
          traceId: this.traceId,
          seq,
          type: message.type,
          error: formatError(error),
        });
      }
    );
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

    if (type === "debugLog") {
      if (typeof msg.message !== "string") {
        return;
      }

      muxLogDebug(`mux.chatView(webview): ${msg.message}`, msg.data);
      return;
    }

    if (type === "copyDebugLog") {
      if (typeof msg.text !== "string") {
        return;
      }

      const text = msg.text;
      muxLogInfo("mux.chatView: copyDebugLog requested", { traceId: this.traceId, length: text.length });

      await vscode.env.clipboard.writeText(text);
      this.postMessage({ type: "uiNotice", level: "info", message: "Copied mux debug log to clipboard." });
      return;
    }

    if (type === "ready") {
      muxLogDebug("mux.chatView: ready handshake received", { traceId: this.traceId });
      this.isWebviewReady = true;
      this.clearReadyProbeInterval();

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
    const startedAt = Date.now();
    muxLogDebug("mux.chatView: refreshWorkspaces start", { traceId: this.traceId });

    try {
      const result = await getWorkspacesForSidebar(this.context);

      this.connectionStatus = result.status;
      this.workspaces = result.workspaces;
      this.workspacesById = new Map(this.workspaces.map((w) => [w.id, w]));

      this.postMessage({ type: "connectionStatus", status: this.connectionStatus });
      this.postMessage({ type: "workspaces", workspaces: this.workspaces.map(toUiWorkspace) });

      if (this.selectedWorkspaceId && !this.workspacesById.has(this.selectedWorkspaceId)) {
        await this.setSelectedWorkspaceId(null);
      }

      if (!this.selectedWorkspaceId) {
        const match = findWorkspaceIdMatchingCurrentFolder(this.workspaces);
        if (match) {
          muxLogDebug("mux.chatView: auto-selected workspace", { workspaceId: match });
          await this.setSelectedWorkspaceId(match);
        }
      }

      await this.updateChatSubscription();

      muxLogDebug("mux.chatView: refreshWorkspaces done", {
        traceId: this.traceId,
        durationMs: Date.now() - startedAt,
        workspaceCount: this.workspaces.length,
        connectionMode: this.connectionStatus.mode,
        hasError: Boolean(this.connectionStatus.error),
      });
    } catch (error) {
      muxLogError("mux.chatView: refreshWorkspaces failed", {
        traceId: this.traceId,
        durationMs: Date.now() - startedAt,
        error: formatError(error),
      });

      const message = `Failed to load mux workspaces. (${formatError(error)})`;

      this.connectionStatus = { mode: "file", error: message };
      this.workspaces = [];
      this.workspacesById = new Map();

      this.subscriptionAbort?.abort();
      this.subscriptionAbort = null;
      this.subscribedWorkspaceId = null;

      this.selectedWorkspaceId = null;
      await this.context.workspaceState.update(SELECTED_WORKSPACE_STATE_KEY, undefined);

      this.postMessage({ type: "connectionStatus", status: this.connectionStatus });
      this.postMessage({ type: "workspaces", workspaces: [] });
      this.postMessage({ type: "setSelectedWorkspace", workspaceId: null });
      this.postMessage({ type: "uiNotice", level: "error", message });
    }
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
  muxLogInfo("mux: activate", {
    connectionMode: getConnectionModeSetting(),
    workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? null,
  });

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

  context.subscriptions.push(
    vscode.commands.registerCommand("mux.debugConnection", () => debugConnectionCommand(context))
  );

  await maybeAutoRevealChatViewFromPendingSelection(context, chatViewProvider);
}

/**
 * Deactivate the extension
 */
export function deactivate() {}

