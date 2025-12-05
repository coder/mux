import { existsSync, renameSync, symlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LEGACY_MUX_DIR_NAME = ".cmux";
const MUX_DIR_NAME = ".mux";

/**
 * Migrate from the legacy ~/.cmux directory into ~/.mux for rebranded installs.
 * Called on startup to preserve data created by earlier releases.
 *
 * If .mux exists, nothing happens (already migrated).
 * If .cmux exists but .mux doesn't, moves .cmux → .mux and creates symlink.
 * This ensures old scripts/tools referencing ~/.cmux continue working.
 */
export function migrateLegacyMuxHome(): void {
  const oldPath = join(homedir(), LEGACY_MUX_DIR_NAME);
  const newPath = join(homedir(), MUX_DIR_NAME);

  // If .mux exists, we're done (already migrated or fresh install)
  if (existsSync(newPath)) {
    return;
  }

  // If .cmux exists, move it and create symlink for backward compatibility
  if (existsSync(oldPath)) {
    renameSync(oldPath, newPath);
    symlinkSync(newPath, oldPath, "dir");
  }

  // If neither exists, nothing to do (will be created on first use)
}

/**
 * Get the root directory for all mux configuration and data.
 * Can be overridden with MUX_ROOT environment variable.
 * Appends '-dev' suffix when NODE_ENV=development (explicit dev mode).
 *
 * This is a getter function to support test mocking of os.homedir().
 *
 * Note: This file is only used by main process code, but lives in constants/
 * for organizational purposes. The process.env access is safe.
 */
export function getMuxHome(): string {
  // eslint-disable-next-line no-restricted-syntax, no-restricted-globals
  if (process.env.MUX_ROOT) {
    // eslint-disable-next-line no-restricted-syntax, no-restricted-globals
    return process.env.MUX_ROOT;
  }

  const baseName = MUX_DIR_NAME;
  // Use -dev suffix only when explicitly in development mode
  // eslint-disable-next-line no-restricted-syntax, no-restricted-globals
  const suffix = process.env.NODE_ENV === "development" ? "-dev" : "";
  return join(homedir(), baseName + suffix);
}

/**
 * Get the directory where workspace git worktrees are stored.
 * Example: ~/.mux/src/my-project/feature-branch
 *
 * @param rootDir - Optional root directory (defaults to getMuxHome())
 */
export function getMuxSrcDir(rootDir?: string): string {
  const root = rootDir ?? getMuxHome();
  return join(root, "src");
}

/**
 * Get the directory where session chat histories are stored.
 * Example: ~/.mux/sessions/workspace-id/chat.jsonl
 *
 * @param rootDir - Optional root directory (defaults to getMuxHome())
 */
export function getMuxSessionsDir(rootDir?: string): string {
  const root = rootDir ?? getMuxHome();
  return join(root, "sessions");
}

/**
 * Get the directory where plan files are stored.
 * Example: ~/.mux/plans/workspace-id.md
 *
 * @param rootDir - Optional root directory (defaults to getMuxHome())
 */
export function getMuxPlansDir(rootDir?: string): string {
  const root = rootDir ?? getMuxHome();
  return join(root, "plans");
}

/**
 * Get the main configuration file path.
 *
 * @param rootDir - Optional root directory (defaults to getMuxHome())
 */
export function getMuxConfigFile(rootDir?: string): string {
  const root = rootDir ?? getMuxHome();
  return join(root, "config.json");
}

/**
 * Get the providers configuration file path.
 *
 * @param rootDir - Optional root directory (defaults to getMuxHome())
 */
export function getMuxProvidersFile(rootDir?: string): string {
  const root = rootDir ?? getMuxHome();
  return join(root, "providers.jsonc");
}

/**
 * Get the secrets file path.
 *
 * @param rootDir - Optional root directory (defaults to getMuxHome())
 */
export function getMuxSecretsFile(rootDir?: string): string {
  const root = rootDir ?? getMuxHome();
  return join(root, "secrets.json");
}

/**
 * Get the extension metadata file path (shared with VS Code extension).
 *
 * @param rootDir - Optional root directory (defaults to getMuxHome())
 */
export function getMuxExtensionMetadataPath(rootDir?: string): string {
  const root = rootDir ?? getMuxHome();
  return join(root, "extensionMetadata.json");
}
