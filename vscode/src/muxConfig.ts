import * as path from "path";
import * as os from "os";
import { Config } from "mux/config";
import type { WorkspaceMetadata } from "mux/types/workspace";
import { type ExtensionMetadata, readExtensionMetadata } from "mux/utils/extensionMetadata";
import { getProjectName } from "mux/utils/runtime/helpers";
import { createRuntime } from "mux/runtime/runtimeFactory";

/**
 * Workspace with extension metadata for display in VS Code extension.
 * Combines workspace metadata from main app with extension-specific data.
 */
export interface WorkspaceWithContext extends WorkspaceMetadata {
  projectPath: string;
  extensionMetadata?: ExtensionMetadata;
}

/**
 * Get all workspaces from mux config, enriched with extension metadata.
 * Uses main app's Config class to read workspace metadata, then enriches
 * with extension-specific data (recency, streaming status).
 */
export async function getAllWorkspaces(): Promise<WorkspaceWithContext[]> {
  const config = new Config();
  const workspaces = await config.getAllWorkspaceMetadata();
  const extensionMeta = readExtensionMetadata();

  console.log(`[mux] Read ${extensionMeta.size} entries from extension metadata`);

  // Enrich with extension metadata
  const enriched: WorkspaceWithContext[] = workspaces.map((ws) => {
    const meta = extensionMeta.get(ws.id);
    if (meta) {
      console.log(`[mux]   ${ws.id}: recency=${meta.recency}, streaming=${meta.streaming}`);
    }
    return {
      ...ws,
      extensionMetadata: meta,
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

/**
 * Get the workspace path for local or SSH workspaces
 * Uses Runtime to compute path using main app's logic
 */
export function getWorkspacePath(workspace: WorkspaceWithContext): string {
  const runtime = createRuntime(workspace.runtimeConfig);
  return runtime.getWorkspacePath(workspace.projectPath, workspace.name);
}
