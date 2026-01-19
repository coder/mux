import * as path from "path";
import { getMuxHome } from "@/common/constants/paths";

export function resolveMuxUserDataDir(options: {
  muxUserDataDir?: string | undefined;
  muxRoot?: string | undefined;
  isE2E?: boolean | undefined;
  muxHome?: string | undefined;
}): string | undefined {
  if (options.muxUserDataDir) {
    return options.muxUserDataDir;
  }

  if (options.muxRoot || options.isE2E) {
    // Prefer explicit inputs (muxHome / muxRoot) so callers can compute a path
    // without mutating process.env before calling this helper.
    const muxHome = options.muxHome ?? options.muxRoot ?? getMuxHome();
    return path.join(muxHome, "user-data");
  }

  return undefined;
}
