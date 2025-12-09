import { execFileSync } from "child_process";

/**
 * Convert a path to POSIX format for Git Bash on Windows.
 * On non-Windows platforms, returns the path unchanged.
 *
 * Use this when building shell command strings that will run in Git Bash,
 * where Windows-style paths (C:\foo\bar) don't work.
 */
export function toPosixPath(windowsPath: string): string {
  if (process.platform !== "win32") return windowsPath;
  try {
    // cygpath converts Windows paths to POSIX format for Git Bash / MSYS2
    // Use execFileSync with args array to avoid shell injection
    return execFileSync("cygpath", ["-u", windowsPath], { encoding: "utf8" }).trim();
  } catch {
    // Fallback if cygpath unavailable (shouldn't happen with Git Bash)
    return windowsPath;
  }
}
