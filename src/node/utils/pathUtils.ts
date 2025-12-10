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
 * Validate that a project path exists, is a directory, and is a git repository
 * Automatically expands tilde and normalizes the path
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
 *
 * await validateProjectPath("~/not-a-git-repo")
 * // => { valid: false, error: "Not a git repository: /home/user/not-a-git-repo" }
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

  // Check if it's a git repository
  const gitPath = path.join(normalizedPath, ".git");
  try {
    await fs.stat(gitPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        valid: false,
        error: `Not a git repository: ${normalizedPath}`,
      };
    }
    throw err;
  }

  return {
    valid: true,
    expandedPath: normalizedPath,
  };
}
