import * as fs from "fs/promises";
import * as path from "path";
import { PlatformPaths } from "./paths.main";

/**
 * Result of path validation
 */
export interface PathValidationResult {
  valid: boolean;
  expandedPath?: string;
  error?: string;
}

/**
 * Expand tilde (~) in paths to the user's home directory
 *
 * @param inputPath - Path that may contain tilde
 * @returns Path with tilde expanded to home directory
 *
 * @example
 * expandTilde("~/Documents") // => "/home/user/Documents"
 * expandTilde("~") // => "/home/user"
 * expandTilde("/absolute/path") // => "/absolute/path"
 */
export function expandTilde(inputPath: string): string {
  return PlatformPaths.expandHome(inputPath);
}

/**
 * Strip trailing slashes from a path.
 * path.normalize() preserves a single trailing slash which breaks basename extraction.
 *
 * @param inputPath - Path that may have trailing slashes
 * @returns Path without trailing slashes
 *
 * @example
 * stripTrailingSlashes("/home/user/project/") // => "/home/user/project"
 * stripTrailingSlashes("/home/user/project//") // => "/home/user/project"
 */
export function stripTrailingSlashes(inputPath: string): string {
  return inputPath.replace(/[/\\]+$/, "");
}

/**
 * Validate that a project path exists and is a directory.
 * Git repository status is checked separately - non-git repos are valid
 * but will be restricted to local runtime only.
 * Automatically expands tilde and normalizes the path.
 *
 * @param inputPath - Path to validate (may contain tilde)
 * @returns Validation result with expanded path or error
 *
 * @example
 * await validateProjectPath("~/my-project")
 * // => { valid: true, expandedPath: "/home/user/my-project" }
 *
 * await validateProjectPath("~/nonexistent")
 * // => { valid: false, error: "Path does not exist: /home/user/nonexistent" }
 */
export async function validateProjectPath(inputPath: string): Promise<PathValidationResult> {
  // Expand tilde if present
  const expandedPath = expandTilde(inputPath);

  // Normalize to resolve any .. or . in the path, then strip trailing slashes
  const normalizedPath = stripTrailingSlashes(path.normalize(expandedPath));

  // Check if path exists
  try {
    const stats = await fs.stat(normalizedPath);

    // Check if it's a directory
    if (!stats.isDirectory()) {
      return {
        valid: false,
        error: `Path is not a directory: ${normalizedPath}`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        valid: false,
        error: `Path does not exist: ${normalizedPath}`,
      };
    }
    throw err;
  }

  return {
    valid: true,
    expandedPath: normalizedPath,
  };
}

/**
 * Check if a path is a git repository
 *
 * @param projectPath - Path to check (should be already validated/normalized)
 * @returns true if the path contains a .git directory
 */
export async function isGitRepository(projectPath: string): Promise<boolean> {
  const gitPath = path.join(projectPath, ".git");
  try {
    await fs.stat(gitPath);
    return true;
  } catch {
    return false;
  }
}
