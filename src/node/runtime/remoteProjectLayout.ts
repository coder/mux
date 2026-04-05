import * as crypto from "crypto";
import * as path from "path";
import { getProjectName } from "@/node/utils/runtime/helpers";

export const REMOTE_BASE_REPO_DIR = ".mux-base.git";
const REMOTE_METADATA_DIR = ".mux-meta";
const REMOTE_WORKSPACE_METADATA_DIR = "workspaces";
const REMOTE_SNAPSHOT_MARKER_DIR = "snapshots";

export interface RemoteProjectLayout {
  projectId: string;
  projectRoot: string;
  baseRepoPath: string;
  workspaceMetadataDir: string;
  snapshotMarkerDir: string;
}

function sanitizeProjectSegment(segment: string): string {
  const sanitized = segment
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized.length > 0 ? sanitized : "project";
}

function hashText(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function createRemoteProjectId(projectPath: string): string {
  const normalizedPath = projectPath.replace(/\\/g, "/");
  const projectSlug = sanitizeProjectSegment(getProjectName(projectPath));
  return `${projectSlug}-${hashText(normalizedPath)}`;
}

export function buildRemoteProjectLayout(
  srcBaseDir: string,
  projectPath: string,
  projectRootOverride?: string
): RemoteProjectLayout {
  const projectId = createRemoteProjectId(projectPath);
  const projectRoot = projectRootOverride ?? path.posix.join(srcBaseDir, projectId);
  const metadataRoot = path.posix.join(projectRoot, REMOTE_METADATA_DIR);

  return {
    projectId,
    projectRoot,
    baseRepoPath: path.posix.join(projectRoot, REMOTE_BASE_REPO_DIR),
    workspaceMetadataDir: path.posix.join(metadataRoot, REMOTE_WORKSPACE_METADATA_DIR),
    snapshotMarkerDir: path.posix.join(metadataRoot, REMOTE_SNAPSHOT_MARKER_DIR),
  };
}

export function buildLegacyRemoteProjectLayout(
  srcBaseDir: string,
  projectPath: string
): RemoteProjectLayout {
  const legacyRoot = path.posix.join(srcBaseDir, getProjectName(projectPath));
  return buildRemoteProjectLayout(srcBaseDir, projectPath, legacyRoot);
}

export function getRemoteWorkspacePath(layout: RemoteProjectLayout, workspaceName: string): string {
  return path.posix.join(layout.projectRoot, workspaceName);
}

export function getWorkspaceMetadataPath(
  layout: RemoteProjectLayout,
  workspaceName: string
): string {
  return path.posix.join(layout.workspaceMetadataDir, `${hashText(workspaceName)}.json`);
}

export function getSnapshotMarkerPath(layout: RemoteProjectLayout, snapshotDigest: string): string {
  return path.posix.join(layout.snapshotMarkerDir, `${snapshotDigest}.json`);
}
