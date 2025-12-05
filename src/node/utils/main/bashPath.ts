/**
 * Platform-specific bash runtime detection and execution
 *
 * On Unix/Linux/macOS, bash is in PATH by default.
 * On Windows, we detect available runtimes (Git for Windows, WSL) and use
 * absolute paths to bash, always wrapping commands in `bash -c`.
 *
 * Priority on Windows: WSL > Git for Windows (if both available)
 * WSL provides a full Linux environment with better tool compatibility.
 * Windows paths are automatically translated (C:\Users\... -> /mnt/c/Users/...).
 * cwd is embedded in the script via 'cd' since WSL needs Linux paths.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";

// ============================================================================
// Types
// ============================================================================

/** Git for Windows bash runtime */
export interface GitBashRuntime {
  type: "git-bash";
  /** Absolute path to bash.exe */
  bashPath: string;
}

/** WSL (Windows Subsystem for Linux) runtime */
export interface WslRuntime {
  type: "wsl";
  /** WSL distro name, or null for default distro */
  distro: string | null;
}

/** Unix/Linux/macOS native bash */
export interface UnixBashRuntime {
  type: "unix";
}

export type BashRuntime = GitBashRuntime | WslRuntime | UnixBashRuntime;

export interface DetectedRuntimes {
  /** All available runtimes on this system */
  available: BashRuntime[];
  /** The preferred runtime to use (Git for Windows > WSL on Windows) */
  preferred: BashRuntime;
}

export interface SpawnConfig {
  /** Command to spawn */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Working directory (translated for WSL if needed) */
  cwd?: string;
}

// ============================================================================
// Path Translation
// ============================================================================

/**
 * Convert a Windows path to a WSL path
 * C:\Users\name -> /mnt/c/Users/name
 * D:\Projects -> /mnt/d/Projects
 */
export function windowsToWslPath(windowsPath: string): string {
  // Match drive letter paths like C:\ or C:/
  const driveMatch = /^([a-zA-Z]):[/\\](.*)$/.exec(windowsPath);
  if (driveMatch) {
    const driveLetter = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, "/");
    return `/mnt/${driveLetter}/${rest}`;
  }
  // Not a Windows path, return as-is
  return windowsPath;
}

/**
 * Translate Windows paths in a command string for WSL
 * Finds patterns like C:\... or "C:\..." and converts them
 */
export function translateWindowsPathsInCommand(command: string): string {
  // Match Windows paths with different quote styles:
  // 1. Double-quoted: "C:\Users\John Doe\repo" - can contain spaces
  // 2. Single-quoted: 'C:\Users\John Doe\repo' - can contain spaces
  // 3. Unquoted: C:\Users\name\repo - no spaces allowed
  return command.replace(
    /"([a-zA-Z]):[/\\]([^"]*)"|'([a-zA-Z]):[/\\]([^']*)'|([a-zA-Z]):[/\\]([^\s]*)/g,
    (
      _match: string,
      dqDrive: string | undefined,
      dqRest: string | undefined,
      sqDrive: string | undefined,
      sqRest: string | undefined,
      uqDrive: string | undefined,
      uqRest: string | undefined
    ) => {
      if (dqDrive !== undefined) {
        // Double-quoted path
        const wslPath = `/mnt/${dqDrive.toLowerCase()}/${dqRest!.replace(/\\/g, "/")}`;
        return `"${wslPath}"`;
      } else if (sqDrive !== undefined) {
        // Single-quoted path
        const wslPath = `/mnt/${sqDrive.toLowerCase()}/${sqRest!.replace(/\\/g, "/")}`;
        return `'${wslPath}'`;
      } else {
        // Unquoted path
        const wslPath = `/mnt/${uqDrive!.toLowerCase()}/${uqRest!.replace(/\\/g, "/")}`;
        return wslPath;
      }
    }
  );
}

/**
 * Translate a path for the given runtime
 */
export function translatePathForRuntime(pathStr: string, runtime: BashRuntime): string {
  if (runtime.type === "wsl" && process.platform === "win32") {
    return windowsToWslPath(pathStr);
  }
  return pathStr;
}

// ============================================================================
// Detection
// ============================================================================

let cachedRuntimes: DetectedRuntimes | null = null;

/**
 * Find Git for Windows bash.exe path
 * Checks common installation locations
 */
function findGitBash(): string | null {
  // Common Git Bash installation paths
  const commonPaths = [
    // Git for Windows default paths
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    // User-local Git installation
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
    // Portable Git (Scoop)
    path.join(process.env.USERPROFILE ?? "", "scoop", "apps", "git", "current", "bin", "bash.exe"),
    // Chocolatey installation
    "C:\\tools\\git\\bin\\bash.exe",
  ];

  // Check if bash is in PATH first (might be Git Bash added to PATH)
  try {
    const result = execSync("where bash", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const firstPath = result.split("\n")[0].trim();
    // Only use if it's not WSL bash (which would be in System32)
    if (firstPath && existsSync(firstPath) && !firstPath.toLowerCase().includes("system32")) {
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
 * Detect available WSL distros
 * Returns the default distro name if WSL is available
 */
function findWslDistro(): string | null {
  try {
    // Check if wsl.exe exists and works
    const result = execSync("wsl --list --quiet", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    // WSL outputs distro names, first one is typically the default
    // Output may have UTF-16 BOM and null bytes, clean it up
    const distros = result
      .replace(/\0/g, "") // Remove null bytes from UTF-16
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (distros.length > 0) {
      return distros[0]; // Return default/first distro
    }
  } catch {
    // WSL not available or no distros installed
  }

  return null;
}

/**
 * Find PowerShell executable path
 * We need the full path because Node.js spawn() may not have the same PATH as a user shell
 */
function findPowerShell(): string | null {
  // PowerShell Core (pwsh) locations - preferred as it's cross-platform
  const pwshPaths = [
    // PowerShell Core default installation
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Program Files\\PowerShell\\6\\pwsh.exe",
    // User-local installation
    path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "PowerShell", "pwsh.exe"),
  ];

  // Windows PowerShell (powershell.exe) - always present on Windows
  const windowsPowerShellPaths = [
    // 64-bit PowerShell
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    // 32-bit PowerShell (on 64-bit systems via SysWOW64)
    "C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe",
  ];

  // Try PowerShell Core first (better performance)
  for (const psPath of pwshPaths) {
    if (existsSync(psPath)) {
      return psPath;
    }
  }

  // Try to find pwsh in PATH
  try {
    const result = execSync("where pwsh", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const firstPath = result.split("\n")[0].trim();
    if (firstPath && existsSync(firstPath)) {
      return firstPath;
    }
  } catch {
    // pwsh not in PATH
  }

  // Fall back to Windows PowerShell
  for (const psPath of windowsPowerShellPaths) {
    if (existsSync(psPath)) {
      return psPath;
    }
  }

  // Last resort: try to find powershell in PATH
  try {
    const result = execSync("where powershell", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const firstPath = result.split("\n")[0].trim();
    if (firstPath && existsSync(firstPath)) {
      return firstPath;
    }
  } catch {
    // powershell not in PATH
  }

  return null;
}

// Cached PowerShell path (set during runtime detection)
let cachedPowerShellPath: string | null | undefined = undefined;

/**
 * Get the PowerShell path, detecting it if not yet cached
 */
function getPowerShellPath(): string | null {
  if (cachedPowerShellPath === undefined) {
    cachedPowerShellPath = findPowerShell();
  }
  return cachedPowerShellPath;
}

/**
 * Detect all available bash runtimes on the current system
 * Results are cached for performance
 */
export function detectBashRuntimes(): DetectedRuntimes {
  // Return cached result if available
  if (cachedRuntimes !== null) {
    return cachedRuntimes;
  }

  // On Unix/Linux/macOS, just use native bash
  if (process.platform !== "win32") {
    cachedRuntimes = {
      available: [{ type: "unix" }],
      preferred: { type: "unix" },
    };
    return cachedRuntimes;
  }

  // On Windows, detect WSL and Git for Windows
  const available: BashRuntime[] = [];

  // Check for WSL (preferred - full Linux environment, wrapped in PowerShell to hide console)
  const wslDistro = findWslDistro();
  if (wslDistro) {
    available.push({ type: "wsl", distro: wslDistro });
  }

  // Check for Git for Windows (fallback)
  const gitBashPath = findGitBash();
  if (gitBashPath) {
    available.push({ type: "git-bash", bashPath: gitBashPath });
  }

  // Determine preferred runtime (first in list - WSL if available, else Git for Windows)
  if (available.length === 0) {
    throw new Error(
      "No bash runtime found. Please install WSL (https://learn.microsoft.com/en-us/windows/wsl/install) or Git for Windows."
    );
  }
  const preferred = available[0];

  cachedRuntimes = { available, preferred };
  return cachedRuntimes;
}

// ============================================================================
// Execution
// ============================================================================

/**
 * Get spawn configuration for executing a script through the given runtime
 * Always wraps commands in `bash -c "script"`
 *
 * For WSL runtime, Windows paths in the script are automatically translated
 * to WSL paths (C:\... -> /mnt/c/...).
 *
 * @param runtime The bash runtime to use
 * @param script The bash script to execute
 * @param cwd Optional working directory (will be translated for WSL)
 * @returns Command, args, and cwd suitable for child_process.spawn()
 */
export function getSpawnConfig(runtime: BashRuntime, script: string, cwd?: string): SpawnConfig {
  switch (runtime.type) {
    case "unix":
      return {
        command: "bash",
        args: ["-c", script],
        cwd,
      };

    case "git-bash":
      return {
        command: runtime.bashPath,
        args: ["-c", script],
        cwd,
      };

    case "wsl": {
      // Translate Windows paths in the script for WSL
      const translatedScript = translateWindowsPathsInCommand(script);
      // Translate cwd for WSL - this goes INSIDE the bash script
      const translatedCwd = cwd ? windowsToWslPath(cwd) : undefined;

      // Build the script that cd's to the right directory and runs the command
      const cdPrefix = translatedCwd ? `cd '${translatedCwd}' && ` : "";
      const fullScript = cdPrefix + translatedScript;

      // Try to use PowerShell to hide WSL console window
      // Use base64 encoding to completely avoid escaping issues with special chars
      const psPath = getPowerShellPath();
      if (psPath) {
        // Base64 encode the script to avoid any PowerShell parsing issues
        // PowerShell will decode it and pass to WSL bash -c
        const base64Script = Buffer.from(fullScript, "utf8").toString("base64");

        // Build the PowerShell command that:
        // 1. Decodes the base64 script into variable $s
        // 2. Passes $s to WSL bash -c with proper quoting
        const wslArgs = runtime.distro ? `-d ${runtime.distro}` : "";
        // CRITICAL: Must quote $s with escaped double quotes (`"$s`") so the entire
        // script is passed as a single argument to bash -c. Without quotes, PowerShell
        // expands $s and bash only sees the first word as the -c argument.
        const psCommand =
          `$s=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Script}'));` +
          `wsl ${wslArgs} bash -c \`"$s\`"`.trim();

        return {
          command: psPath,
          args: ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psCommand],
          cwd: undefined, // cwd is embedded in the script
        };
      }

      // Fallback: direct WSL invocation (console window may flash)
      const wslArgs: string[] = [];
      if (runtime.distro) {
        wslArgs.push("-d", runtime.distro);
      }
      // Use -- to separate wsl args from bash args, avoiding parsing issues
      wslArgs.push("--", "bash", "-c", fullScript);

      return {
        command: "wsl",
        args: wslArgs,
        // cwd is handled via 'cd' inside the bash script since WSL needs Linux paths
        cwd: undefined,
      };
    }
  }
}

/**
 * Get spawn configuration using the preferred runtime
 * Convenience wrapper around detectBashRuntimes() + getSpawnConfig()
 *
 * @param script The bash script to execute
 * @param cwd Optional working directory (will be translated for WSL on Windows)
 */
export function getPreferredSpawnConfig(script: string, cwd?: string): SpawnConfig {
  const { preferred } = detectBashRuntimes();
  return getSpawnConfig(preferred, script, cwd);
}

// ============================================================================
// Legacy API (for backward compatibility)
// ============================================================================

/**
 * Get the bash executable path for the current platform
 *
 * @deprecated Use detectBashRuntimes() and getSpawnConfig() instead
 * @returns Path to bash executable. On Unix/macOS returns "bash",
 *          on Windows returns full path to bash.exe if found.
 * @throws Error if bash cannot be found on Windows
 */
export function getBashPath(): string {
  const { preferred } = detectBashRuntimes();

  switch (preferred.type) {
    case "unix":
      return "bash";
    case "git-bash":
      return preferred.bashPath;
    case "wsl":
      // For legacy API, return "wsl" - callers will need to update to new API
      // This is a breaking change signal
      return "wsl";
  }
}

/**
 * Check if bash is available on the system
 *
 * @returns true if bash is available, false otherwise
 */
export function isBashAvailable(): boolean {
  try {
    detectBashRuntimes();
    return true;
  } catch {
    return false;
  }
}
