import * as crypto from "node:crypto";
import * as path from "node:path";

import assert from "@/common/utils/assert";
import { getMuxHome } from "@/common/constants/paths";
import { PlatformPaths } from "@/common/utils/paths";

// Keep memory filenames short and stable. This is part of the public storage format
// (stored under ~/.mux/memories/) so changing it should be treated as a migration.
const MAX_PROJECT_BASENAME_LENGTH = 32;

const PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9_-]*-[a-f0-9]{8}$/;

function sanitizeProjectBasename(name: string): string {
  assert(typeof name === "string", "sanitizeProjectBasename: name must be a string");

  const trimmed = name.trim();
  const raw = trimmed.length > 0 ? trimmed : "project";

  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "");

  const clamped = sanitized.slice(0, MAX_PROJECT_BASENAME_LENGTH);
  return clamped.length > 0 ? clamped : "project";
}

export function deriveProjectIdFromPath(projectPath: string): string {
  assert(typeof projectPath === "string", "deriveProjectIdFromPath: projectPath must be a string");
  assert(projectPath.trim().length > 0, "deriveProjectIdFromPath: projectPath must be non-empty");

  const normalizedAbsoluteProjectPath = path.resolve(projectPath);
  const hash8 = crypto
    .createHash("sha1")
    .update(normalizedAbsoluteProjectPath)
    .digest("hex")
    .slice(0, 8);

  const basename = sanitizeProjectBasename(PlatformPaths.getProjectName(projectPath));
  const projectId = `${basename}-${hash8}`;
  assert(
    PROJECT_ID_REGEX.test(projectId),
    `deriveProjectIdFromPath: generated projectId must be valid (got '${projectId}')`
  );
  return projectId;
}

export function getMuxMemoriesDir(): string {
  // Use getMuxHome() directly instead of runtime.getMuxHome(). Memories are always stored on
  // the local machine running mux (not on a remote runtime).
  return path.join(getMuxHome(), "memories");
}

export function getMemoryFilePathForProject(projectPath: string): {
  projectId: string;
  memoriesDir: string;
  memoryPath: string;
} {
  const projectId = deriveProjectIdFromPath(projectPath);
  const memoriesDir = getMuxMemoriesDir();
  const memoryPath = path.join(memoriesDir, `${projectId}.md`);

  // Defensive: ensure the computed path is within ~/.mux/memories.
  // Since projectId is computed server-side, this should never fail.
  const resolvedMemoriesDir = path.resolve(memoriesDir);
  const resolvedMemoryPath = path.resolve(memoryPath);
  const relative = path.relative(resolvedMemoriesDir, resolvedMemoryPath);
  assert(
    !relative.startsWith("..") && !path.isAbsolute(relative),
    "getMemoryFilePathForProject: memoryPath must be within memoriesDir"
  );

  return { projectId, memoriesDir: resolvedMemoriesDir, memoryPath: resolvedMemoryPath };
}
