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
    const muxHome = options.muxHome ?? getMuxHome();
    return path.join(muxHome, "user-data");
  }

  return undefined;
}
