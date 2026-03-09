import * as fsPromises from "fs/promises";
import * as path from "path";
import type { Stats } from "node:fs";

/**
 * Local filesystem-only skill file utilities.
 *
 * These helpers use Node's `fs/promises` directly and must NOT be called from
 * runtime-agnostic tool flows (where `skillDir` may be a remote path).
 *
 * For runtime-aware containment, use `runtimeSkillPathUtils.ts` instead.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function isAbsolutePathAny(filePath: string): boolean {
  if (filePath.startsWith("/") || filePath.startsWith("\\")) {
    return true;
  }

  return /^[A-Za-z]:[\\/]/.test(filePath);
}

export function resolveSkillFilePath(
  skillDir: string,
  filePath: string
): {
  resolvedPath: string;
  normalizedRelativePath: string;
} {
  if (!filePath) {
    throw new Error("filePath is required");
  }

  if (isAbsolutePathAny(filePath) || filePath.startsWith("~")) {
    throw new Error(`Invalid filePath (must be relative to the skill directory): ${filePath}`);
  }

  if (filePath.startsWith("..")) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  const resolvedPath = path.resolve(skillDir, filePath);
  const relativePath = path.relative(skillDir, resolvedPath);

  if (relativePath === "" || relativePath === ".") {
    throw new Error(`Invalid filePath (expected a file, got directory): ${filePath}`);
  }

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid filePath (path traversal): ${filePath}`);
  }

  return {
    resolvedPath,
    normalizedRelativePath: relativePath.replaceAll(path.sep, "/"),
  };
}

export async function lstatIfExists(targetPath: string): Promise<Stats | null> {
  try {
    return await fsPromises.lstat(targetPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

async function resolveRealPathAllowMissing(targetPath: string): Promise<string> {
  const missingSegments: string[] = [];
  let currentPath = targetPath;

  while (true) {
    try {
      const realPath = await fsPromises.realpath(currentPath);
      return missingSegments.length === 0 ? realPath : path.join(realPath, ...missingSegments);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }

      missingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

export async function resolveContainedSkillFilePath(
  skillDir: string,
  filePath: string,
  options?: { allowMissingLeaf?: boolean }
): Promise<{ resolvedPath: string; normalizedRelativePath: string }> {
  const { resolvedPath: requestedPath, normalizedRelativePath } = resolveSkillFilePath(
    skillDir,
    filePath
  );

  const rootReal = options?.allowMissingLeaf
    ? await resolveRealPathAllowMissing(skillDir)
    : await fsPromises.realpath(skillDir);
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;

  const targetReal = options?.allowMissingLeaf
    ? await resolveRealPathAllowMissing(requestedPath)
    : await fsPromises.realpath(requestedPath);

  if (targetReal !== rootReal && !targetReal.startsWith(rootPrefix)) {
    throw new Error(
      `Invalid filePath (path escapes skill directory after symlink resolution): ${filePath}`
    );
  }

  // Use the resolved real path only for containment checks; callers must mutate the lexical
  // requested path so lstat-based leaf symlink rejection checks inspect the requested alias.
  return {
    resolvedPath: requestedPath,
    normalizedRelativePath,
  };
}

/**
 * Unified directory-scope validation for local skill operations (write / delete).
 *
 * Checks (in order):
 * 1. Skills root (muxHomeReal/skills) is not a symlink.
 * 2. Skill directory is not a symlink.
 * 3. If skill directory exists, its realpath stays under muxHomeReal.
 *
 * Returns the lstat result of skillDir (null when it doesn't exist yet).
 * Throws a descriptive error string on any violation.
 */
export async function validateLocalSkillDirectory(
  skillDir: string,
  muxHomeReal: string
): Promise<{ skillDirStat: Stats | null }> {
  // 1) Reject symlinked ~/.mux/skills
  const skillsRoot = path.dirname(skillDir);
  const skillsRootStat = await lstatIfExists(skillsRoot);
  if (skillsRootStat?.isSymbolicLink()) {
    throw new Error(
      "Skills root directory (~/.mux/skills) is a symbolic link and cannot be used for skill operations."
    );
  }

  // 2) Reject symlinked skill directory
  const skillDirStat = await lstatIfExists(skillDir);
  if (skillDirStat?.isSymbolicLink()) {
    throw new Error("Skill directory is a symlink (symbolic link) and cannot be modified.");
  }

  // 3) If exists, verify realpath stays under muxHomeReal
  if (skillDirStat != null) {
    const muxHomePrefix = muxHomeReal.endsWith(path.sep)
      ? muxHomeReal
      : `${muxHomeReal}${path.sep}`;
    try {
      const skillDirReal = await fsPromises.realpath(skillDir);
      if (!skillDirReal.startsWith(muxHomePrefix)) {
        throw new Error("Skill directory resolves outside mux home after symlink resolution.");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("resolves outside")) {
        throw error;
      }
      // realpath failure for other reasons is non-fatal; symlink check above is primary guard
    }
  }

  return { skillDirStat };
}

/** Canonical filename for the skill definition file. */
export const SKILL_FILENAME = "SKILL.md";

/** Case-insensitive check whether a normalized relative path refers to the root SKILL.md file. */
export function isSkillMarkdownRootFile(relativePath: string): boolean {
  return relativePath.toLowerCase() === SKILL_FILENAME.toLowerCase();
}
