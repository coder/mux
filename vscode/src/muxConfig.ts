import { Config } from "mux/node/config";
import type { FrontendWorkspaceMetadata, WorkspaceActivitySnapshot } from "mux/common/types/workspace";
import { type ExtensionMetadata, readExtensionMetadata } from "mux/node/utils/extensionMetadata";
import { createRuntime } from "mux/node/runtime/runtimeFactory";

import type { ApiClient } from "./api/client";

/**
 * Workspace with extension metadata for display in VS Code extension.
 */
export interface WorkspaceWithContext extends FrontendWorkspaceMetadata {
  extensionMetadata?: ExtensionMetadata;
}

function enrichAndSort(
  workspaces: FrontendWorkspaceMetadata[],
  extensionMeta: Map<string, ExtensionMetadata>
): WorkspaceWithContext[] {
  const enriched: WorkspaceWithContext[] = workspaces.map((ws) => {
    return {
      ...ws,
      extensionMetadata: extensionMeta.get(ws.id),
    };
  });

  // Sort by recency (extension metadata > createdAt > name)
  const recencyOf = (w: WorkspaceWithContext): number =>
    w.extensionMetadata?.recency ?? (w.createdAt ? Date.parse(w.createdAt) : 0);

  enriched.sort((a, b) => {
    const aRecency = recencyOf(a);
    const bRecency = recencyOf(b);
    if (aRecency !== bRecency) return bRecency - aRecency;
    return a.name.localeCompare(b.name);
  });

  return enriched;
}

export async function getAllWorkspacesFromFiles(): Promise<WorkspaceWithContext[]> {
  const config = new Config();
  const workspaces = await config.getAllWorkspaceMetadata();
  const extensionMeta = readExtensionMetadata();
  return enrichAndSort(workspaces, extensionMeta);
}

export async function getAllWorkspacesFromApi(client: ApiClient): Promise<WorkspaceWithContext[]> {
  const workspaces = await client.workspace.list();
  const activityById: Record<string, WorkspaceActivitySnapshot> = await client.workspace.activity.list();

  const extensionMeta = new Map<string, ExtensionMetadata>();
  for (const [workspaceId, activity] of Object.entries(activityById)) {
    extensionMeta.set(workspaceId, {
      recency: activity.recency,
      streaming: activity.streaming,
      lastModel: activity.lastModel,
    });
  }

  return enrichAndSort(workspaces, extensionMeta);
}

/**
 * Get the workspace path for local or SSH workspaces.
 * Uses Runtime to compute path using main app's logic.
 */
export function getWorkspacePath(workspace: WorkspaceWithContext): string {
  const runtime = createRuntime(workspace.runtimeConfig, { projectPath: workspace.projectPath });
  return runtime.getWorkspacePath(workspace.projectPath, workspace.name);
}

