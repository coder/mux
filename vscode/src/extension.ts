import * as vscode from "vscode";

import { formatRelativeTime } from "mux/browser/utils/ui/dateTime";

import { getAllWorkspacesFromFiles, getAllWorkspacesFromApi, WorkspaceWithContext } from "./muxConfig";
import { checkAuth, checkServerReachable } from "./api/connectionCheck";
import { createApiClient } from "./api/client";
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

async function tryGetWorkspacesFromApi(
  context: vscode.ExtensionContext
): Promise<{ workspaces: WorkspaceWithContext[] } | { failure: ApiConnectionFailure }> {
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

    const workspaces = await getAllWorkspacesFromApi(client);
    return { workspaces };
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

/**
 * Activate the extension
 */
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("mux.openWorkspace", () => openWorkspaceCommand(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mux.configureConnection", () => configureConnectionCommand(context))
  );
}

/**
 * Deactivate the extension
 */
export function deactivate() {}

