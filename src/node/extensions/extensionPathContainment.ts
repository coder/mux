import * as path from "node:path";

import {
  ensurePathContained,
  isAbsolutePathAny,
  lstatIfExists,
} from "@/node/services/tools/skillFileUtils";

export interface ContainedExtensionPath {
  resolvedPath: string;
  realPath: string;
  normalizedRelativePath: string;
}

export async function ensureExtensionPathContained(
  moduleRoot: string,
  contributedPath: string,
  options?: { allowMissingLeaf?: boolean }
): Promise<ContainedExtensionPath> {
  if (!contributedPath) {
    throw new Error("contributedPath is required");
  }

  if (isAbsolutePathAny(contributedPath) || contributedPath.startsWith("~")) {
    throw new Error(
      `Invalid contributed path (must be relative to the Extension Module): ${contributedPath}`
    );
  }

  const resolvedPath = path.resolve(moduleRoot, contributedPath);
  const lexicalRelative = path.relative(moduleRoot, resolvedPath);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(lexicalRelative)
  ) {
    throw new Error(`Invalid contributed path (path traversal): ${contributedPath}`);
  }

  await rejectInternalSymlinks(moduleRoot, lexicalRelative, contributedPath);

  const realPath = await ensurePathContained(moduleRoot, resolvedPath, {
    allowMissing: options?.allowMissingLeaf,
  });

  const normalizedRelativePath = lexicalRelative.replaceAll(path.sep, "/");

  return { resolvedPath, realPath, normalizedRelativePath };
}

async function rejectInternalSymlinks(
  moduleRoot: string,
  lexicalRelative: string,
  inputForError: string
): Promise<void> {
  const segments = lexicalRelative.split(path.sep).filter((s) => s.length > 0);
  let cursor = moduleRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stat = await lstatIfExists(cursor);
    if (stat == null) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Invalid contributed path (segment is a symlink): ${inputForError}`);
    }
  }
}
