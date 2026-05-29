import * as crypto from "crypto";
import * as path from "path";
import { getProjectName } from "@/node/utils/runtime/helpers";

export const REMOTE_BASE_REPO_DIR = ".mux-base.git";
const REMOTE_METADATA_DIR = ".mux-meta";
const REMOTE_CURRENT_SNAPSHOT_FILE = "current-snapshot";

export interface RemoteProjectLayout {
  projectId: string;
  projectRoot: string;
  baseRepoPath: string;
  currentSnapshotPath: string;
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

  return {
    projectId,
    projectRoot,
    baseRepoPath: path.posix.join(projectRoot, REMOTE_BASE_REPO_DIR),
    currentSnapshotPath: path.posix.join(
      projectRoot,
      REMOTE_METADATA_DIR,
      REMOTE_CURRENT_SNAPSHOT_FILE
    ),
  };
}

export function buildLegacyRemoteProjectLayout(
  srcBaseDir: string,
  projectPath: string
): RemoteProjectLayout {
  return buildRemoteProjectLayout(
    srcBaseDir,
    projectPath,
    path.posix.join(srcBaseDir, getProjectName(projectPath))
  );
}

export function getRemoteWorkspacePath(layout: RemoteProjectLayout, workspaceName: string): string {
  return path.posix.join(layout.projectRoot, workspaceName);
}
