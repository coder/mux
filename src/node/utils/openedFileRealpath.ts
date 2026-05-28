import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

type FileStats = Awaited<ReturnType<FileHandle["stat"]>>;

function hasComparableFileIdentity(stats: FileStats): boolean {
  return stats.dev !== 0 || stats.ino !== 0;
}

function isSameFileIdentity(left: FileStats, right: FileStats): boolean {
  return (
    hasComparableFileIdentity(left) &&
    hasComparableFileIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

export async function realpathOpenedFile(
  handle: Pick<FileHandle, "fd" | "stat">,
  fallbackPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  for (const fdPath of [`/proc/self/fd/${handle.fd}`, `/dev/fd/${handle.fd}`]) {
    try {
      return await fs.realpath(fdPath);
    } catch {
      // Linux exposes /proc/self/fd; macOS exposes /dev/fd. If neither
      // handle-bound path exists, fail closed on POSIX rather than validating a
      // fallback path that may no longer identify the already-opened file.
    }
  }

  if (platform === "win32") {
    const [openedStat, pathStat, pathRealPath] = await Promise.all([
      handle.stat(),
      fs.stat(fallbackPath),
      fs.realpath(fallbackPath),
    ]);
    if (openedStat.isFile() && pathStat.isFile() && isSameFileIdentity(openedStat, pathStat)) {
      return pathRealPath;
    }
  }

  throw new Error(
    `Unable to resolve opened file descriptor realpath for ${fallbackPath}; refusing path fallback for TOCTOU safety.`
  );
}
