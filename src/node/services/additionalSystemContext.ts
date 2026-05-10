import * as fs from "fs/promises";
import * as path from "path";

import { mergeAdditionalSystemInstructions } from "@/common/utils/additionalSystemInstructions";
import { ensurePrivateDir } from "@/node/utils/fs";

interface SessionDirProvider {
  getSessionDir(workspaceId: string): string;
}

export const ADDITIONAL_SYSTEM_CONTEXT_FILENAME = "additional-system-context.md";

function isErrnoWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export function getAdditionalSystemContextPath(
  config: SessionDirProvider,
  workspaceId: string
): string {
  return path.join(config.getSessionDir(workspaceId), ADDITIONAL_SYSTEM_CONTEXT_FILENAME);
}

export async function readAdditionalSystemContext(
  config: SessionDirProvider,
  workspaceId: string
): Promise<string> {
  try {
    return await fs.readFile(getAdditionalSystemContextPath(config, workspaceId), "utf-8");
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

export async function writeAdditionalSystemContext(
  config: SessionDirProvider,
  workspaceId: string,
  content: string
): Promise<void> {
  const filePath = getAdditionalSystemContextPath(config, workspaceId);
  await ensurePrivateDir(path.dirname(filePath));

  // Empty scratchpads should behave like missing files so fork/copy and prompt
  // injection don't carry around blank durable state.
  if (content.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }

  await fs.writeFile(filePath, content, "utf-8");
}

export { mergeAdditionalSystemInstructions };
