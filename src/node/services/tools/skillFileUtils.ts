import * as fsPromises from "fs/promises";
import * as path from "path";
import type { Stats } from "node:fs";

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

/** Canonical filename for the skill definition file. */
export const SKILL_FILENAME = "SKILL.md";

/** Case-insensitive check whether a normalized relative path refers to the root SKILL.md file. */
export function isSkillMarkdownRootFile(relativePath: string): boolean {
  return relativePath.toLowerCase() === SKILL_FILENAME.toLowerCase();
}

/**
 * Rejects a skill directory that is itself a symbolic link.
 * Returns an error message string if the directory is a symlink, or null if it's safe.
 */
export async function rejectSymlinkedSkillDirectory(skillDir: string): Promise<string | null> {
  const stats = await lstatIfExists(skillDir);
  return stats?.isSymbolicLink()
    ? "Skill directory is a symbolic link and cannot be accessed."
    : null;
}
