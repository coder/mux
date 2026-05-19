import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export async function realpathOpenedFile(
  handle: Pick<FileHandle, "fd">,
  fallbackPath: string
): Promise<string> {
  for (const fdPath of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
    try {
      return await fs.realpath(fdPath);
    } catch {
      // Linux exposes /proc/self/fd; macOS exposes /dev/fd. If neither
      // handle-bound path exists, fail closed rather than validating a fallback
      // path that may no longer identify the already-opened file.
    }
  }
  throw new Error(
    `Unable to resolve opened file descriptor realpath for ${fallbackPath}; refusing path fallback for TOCTOU safety.`
  );
}
