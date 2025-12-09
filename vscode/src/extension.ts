import * as vscode from "vscode";
import { getAllWorkspaces, WorkspaceWithContext } from "./muxConfig";
import { openWorkspace } from "./workspaceOpener";
import { formatRelativeTime } from "mux/browser/utils/ui/dateTime";

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
async function openWorkspaceCommand() {
  // Get all workspaces, this is intentionally not cached.
  const workspaces = await getAllWorkspaces();

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

/**
 * Activate the extension
 */
export function activate(context: vscode.ExtensionContext) {
  // Register the openWorkspace command
  const disposable = vscode.commands.registerCommand("mux.openWorkspace", openWorkspaceCommand);

  context.subscriptions.push(disposable);
}

/**
 * Deactivate the extension
 */
export function deactivate() {}
