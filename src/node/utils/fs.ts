import fs from "fs/promises";
import { mkdirSync } from "fs";

/**
 * Ensure a directory exists with owner-only permissions (0o700).
 * Defense-in-depth: the process umask should already enforce this,
 * but explicit mode makes the security intent clear at each callsite.
 */
export async function ensurePrivateDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
}

export function ensurePrivateDirSync(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}
