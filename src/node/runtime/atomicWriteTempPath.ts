import * as crypto from "crypto";

function getSiblingDirectoryPrefix(filePath: string): string {
  const lastSeparatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSeparatorIndex === -1) {
    return "";
  }

  return filePath.slice(0, lastSeparatorIndex + 1);
}

/**
 * Use a short, collision-proof sibling temp path so concurrent writers never
 * race on the same intermediate file or exceed filesystem name limits.
 */
export function getAtomicWriteTempPath(filePath: string): string {
  const pidSuffix = process.pid.toString(36);
  const timestampSuffix = Date.now().toString(36);
  const randomSuffix = crypto.randomBytes(6).toString("hex");
  return `${getSiblingDirectoryPrefix(filePath)}.mux-tmp.${pidSuffix}.${timestampSuffix}.${randomSuffix}`;
}
