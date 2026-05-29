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

/**
 * Convert an MSYS/Cygwin-style path to a native Windows path.
 * Recognizes the `/x/...` convention (single drive letter after leading slash).
 * Non-MSYS paths (already native, or relative) are returned unchanged.
 *
 * Use this when a command resolved in Git Bash needs to be written into
 * a context that runs under cmd.exe (e.g., SSH ProxyCommand).
 */
export function toWindowsPath(msysPath: string): string {
  // Match MSYS drive-letter convention: /c/Users/... → C:\Users\...
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(msysPath);
  if (!match) return msysPath;
  const drive = match[1].toUpperCase();
  const rest = match[2].replaceAll("/", "\\");
  return `${drive}:\\${rest}`;
}
