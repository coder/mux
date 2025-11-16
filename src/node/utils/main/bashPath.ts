/**
 * Platform-specific bash path resolution
 *
 * On Unix/Linux/macOS, bash is in PATH by default.
 * On Windows, bash comes from Git Bash and needs to be located.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

let cachedBashPath: string | null = null;

/**
 * Find bash executable path on Windows
 * Checks common Git Bash installation locations
 */
function findWindowsBash(): string | null {
  // Common Git Bash installation paths
  const commonPaths = [
    // Git for Windows default paths
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    // User-local Git installation
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
    // Portable Git
    path.join(process.env.USERPROFILE ?? "", "scoop", "apps", "git", "current", "bin", "bash.exe"),
    // Chocolatey installation
    "C:\\tools\\git\\bin\\bash.exe",
  ];

  // Check if bash is in PATH first
  try {
    const result = execSync("where bash", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const firstPath = result.split("\n")[0].trim();
    if (firstPath && existsSync(firstPath)) {
      return firstPath;
    }
  } catch {
    // Not in PATH, continue to check common locations
  }

  // Check common installation paths
  for (const bashPath of commonPaths) {
    if (existsSync(bashPath)) {
      return bashPath;
    }
  }

  // Also check if Git is in PATH and derive bash path from it
  try {
    const gitPath = execSync("where git", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const firstGitPath = gitPath.split("\n")[0].trim();
    if (firstGitPath) {
      // Git is usually in Git/cmd/git.exe, bash is in Git/bin/bash.exe
      const gitDir = path.dirname(path.dirname(firstGitPath));
      const bashPath = path.join(gitDir, "bin", "bash.exe");
      if (existsSync(bashPath)) {
        return bashPath;
      }
      // Also try usr/bin/bash.exe (newer Git for Windows structure)
      const usrBashPath = path.join(gitDir, "usr", "bin", "bash.exe");
      if (existsSync(usrBashPath)) {
        return usrBashPath;
      }
    }
  } catch {
    // Git not in PATH
  }

  return null;
}

/**
 * Get the bash executable path for the current platform
 *
 * @returns Path to bash executable. On Unix/macOS returns "bash",
 *          on Windows returns full path to bash.exe if found.
 * @throws Error if bash cannot be found on Windows
 */
export function getBashPath(): string {
  // On Unix/Linux/macOS, bash is in PATH
  if (process.platform !== "win32") {
    return "bash";
  }

  // Use cached path if available
  if (cachedBashPath !== null) {
    return cachedBashPath;
  }

  // Find bash on Windows
  const bashPath = findWindowsBash();
  if (!bashPath) {
    throw new Error(
      "Git Bash not found. Please install Git for Windows from https://git-scm.com/download/win"
    );
  }

  cachedBashPath = bashPath;
  return bashPath;
}

/**
 * Check if bash is available on the system
 *
 * @returns true if bash is available, false otherwise
 */
export function isBashAvailable(): boolean {
  try {
    getBashPath();
    return true;
  } catch {
    return false;
  }
}
