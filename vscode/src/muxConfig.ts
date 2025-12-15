import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "mux/common/types/workspace";
import { Config } from "mux/node/config";
import { readExtensionMetadata } from "mux/node/utils/extensionMetadata";
import {
  createOrpcHttpClient,
  discoverMuxServer,
  type DiscoveredMuxServer,
} from "./orpcClient";

/**
 * Workspace with activity metadata for display in VS Code extension.
 */
export interface WorkspaceWithContext extends FrontendWorkspaceMetadata {
  extensionMetadata?: WorkspaceActivitySnapshot;
}

export class MuxServerConnectionError extends Error {
  readonly baseUrl: string;
  readonly innerError: unknown;

  constructor(baseUrl: string, innerError: unknown) {
    super(`Failed to connect to mux server at ${baseUrl}`);
    this.baseUrl = baseUrl;
    this.innerError = innerError;
  }
}

export interface GetAllWorkspacesOptions {
  /** Skip server discovery and read from local mux files directly. */
  forceFiles?: boolean;
}

export async function getAllWorkspaces(
  options: GetAllWorkspacesOptions = {}
): Promise<WorkspaceWithContext[]> {
  if (!options.forceFiles) {
    const server = await discoverMuxServer();
    if (server) {
      try {
        return await getAllWorkspacesViaOrpc(server);
      } catch (error) {
        throw new MuxServerConnectionError(server.baseUrl, error);
      }
    }
  }

  return getAllWorkspacesViaFiles();
}

async function getAllWorkspacesViaOrpc(
  server: DiscoveredMuxServer
): Promise<WorkspaceWithContext[]> {
  const api = createOrpcHttpClient(server);

  const [workspaces, activityByWorkspaceId] = await Promise.all([
    api.workspace.list(),
    api.workspace.activity.list(),
  ]);

  const enriched: WorkspaceWithContext[] = workspaces.map((ws) => ({
    ...ws,
    extensionMetadata: activityByWorkspaceId[ws.id],
  }));

  sortByRecency(enriched);
  return enriched;
}

async function getAllWorkspacesViaFiles(): Promise<WorkspaceWithContext[]> {
  const config = new Config();
  const workspaces = await config.getAllWorkspaceMetadata();
  const extensionMeta = readExtensionMetadata();

  const enriched: WorkspaceWithContext[] = workspaces.map((ws) => ({
    ...ws,
    extensionMetadata: extensionMeta.get(ws.id),
  }));

  sortByRecency(enriched);
  return enriched;
}

function sortByRecency(workspaces: WorkspaceWithContext[]): void {
  const recencyOf = (w: WorkspaceWithContext): number =>
    w.extensionMetadata?.recency ?? (w.createdAt ? Date.parse(w.createdAt) : 0);

  workspaces.sort((a, b) => {
    const aRecency = recencyOf(a);
    const bRecency = recencyOf(b);
    if (aRecency !== bRecency) return bRecency - aRecency;
    return a.name.localeCompare(b.name);
  });
}
