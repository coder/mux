import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  MAX_STAGED_ATTACHMENT_SIZE_BYTES,
  STAGED_ATTACHMENT_DIR,
  ZIP_MEDIA_TYPE,
} from "@/common/constants/stagedAttachments";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { getSupportedStagedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { ensureGitInfoExclude } from "@/node/utils/git/ensureGitInfoExclude";

export interface StagedWorkspaceAttachment {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  stagedPath: string;
}

export interface DownloadedStagedWorkspaceAttachment {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  dataBase64: string;
}

export async function stageWorkspaceAttachment(input: {
  runtime: Runtime;
  workspacePath: string;
  filename: string;
  mediaType?: string | null;
  sizeBytes: number;
  dataBase64: string;
}): Promise<Result<StagedWorkspaceAttachment, string>> {
  try {
    assert(input.workspacePath.trim().length > 0, "workspacePath is required");
    const mediaType = getSupportedStagedAttachmentMediaType({
      mediaType: input.mediaType,
      filename: input.filename,
    });
    if (mediaType == null) {
      return Err("Only .zip attachments can be staged.");
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
      return Err("Attachment size is invalid.");
    }
    if (input.sizeBytes > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return Err(
        `ZIP attachments must be ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes or less.`
      );
    }

    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.byteLength !== input.sizeBytes) {
      return Err("Attachment size did not match the uploaded data.");
    }
    if (bytes.byteLength > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return Err(
        `ZIP attachments must be ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes or less.`
      );
    }

    const filename = sanitizeZipFilename(input.filename);
    const excludeResult = await ensureGitInfoExclude({
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      relativeDir: STAGED_ATTACHMENT_DIR,
    });
    if (excludeResult.status === "failed") {
      return Err(`Could not mark staged attachments as ignored: ${excludeResult.error}`);
    }

    const stagedDir = `${STAGED_ATTACHMENT_DIR}/${randomUUID()}`;
    const stagedPath = `${stagedDir}/${filename}`;
    await input.runtime.ensureDir(`${input.workspacePath}/${stagedDir}`);
    await writeBytes(input.runtime, `${input.workspacePath}/${stagedPath}`, bytes);

    return Ok({ filename, mediaType: ZIP_MEDIA_TYPE, sizeBytes: bytes.byteLength, stagedPath });
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

export async function readStagedWorkspaceAttachment(input: {
  runtime: Runtime;
  workspacePath: string;
  stagedPath: string;
}): Promise<Result<DownloadedStagedWorkspaceAttachment, string>> {
  try {
    assert(input.workspacePath.trim().length > 0, "workspacePath is required");
    const stagedPath = normalizeReadableStagedPath(input.stagedPath);
    if (stagedPath == null) {
      return Err("Invalid staged attachment path.");
    }

    const bytes = await readStreamToBuffer(
      input.runtime.readFile(`${input.workspacePath}/${stagedPath}`)
    );
    if (bytes.byteLength > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return Err(
        `ZIP attachments must be ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes or less.`
      );
    }

    return Ok({
      filename: stagedPath.split("/").pop() ?? "attachment.zip",
      mediaType: ZIP_MEDIA_TYPE,
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

export async function copyStagedWorkspaceAttachments(input: {
  sourceRuntime: Runtime;
  targetRuntime: Runtime;
  sourceWorkspacePath: string;
  targetWorkspacePath: string;
  stagedPaths?: readonly string[];
}): Promise<Result<void, string>> {
  try {
    assert(input.sourceWorkspacePath.trim().length > 0, "sourceWorkspacePath is required");
    assert(input.targetWorkspacePath.trim().length > 0, "targetWorkspacePath is required");

    const stagedPaths = input.stagedPaths
      ? Ok(normalizeStagedAttachmentPaths(input.stagedPaths))
      : await listStagedAttachmentPaths(input.sourceRuntime, input.sourceWorkspacePath);
    if (!stagedPaths.success) {
      return stagedPaths;
    }
    if (stagedPaths.data.length === 0) {
      return Ok(undefined);
    }

    const excludeResult = await ensureGitInfoExclude({
      runtime: input.targetRuntime,
      workspacePath: input.targetWorkspacePath,
      relativeDir: STAGED_ATTACHMENT_DIR,
    });
    if (excludeResult.status === "failed") {
      return Err(`Could not mark staged attachments as ignored: ${excludeResult.error}`);
    }

    const shouldSkipUnreadableSource = input.stagedPaths != null;
    for (const stagedPath of stagedPaths.data) {
      let bytes: Buffer;
      try {
        bytes = await readStreamToBuffer(
          input.sourceRuntime.readFile(`${input.sourceWorkspacePath}/${stagedPath}`)
        );
      } catch (error) {
        // Fork history can contain stale generated attachment notices after users clean up
        // staged files manually. Preserve the fork rather than failing the whole workspace copy.
        if (shouldSkipUnreadableSource) {
          continue;
        }
        throw error;
      }
      if (bytes.byteLength > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
        return Err(
          `ZIP attachments must be ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes or less.`
        );
      }
      await input.targetRuntime.ensureDir(
        `${input.targetWorkspacePath}/${stagedPath.split("/").slice(0, -1).join("/")}`
      );
      await writeBytes(input.targetRuntime, `${input.targetWorkspacePath}/${stagedPath}`, bytes);
    }

    return Ok(undefined);
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

export function extractStagedAttachmentPathsFromText(text: string): string[] {
  const paths = new Set<string>();
  const pattern = /`(?<path>\.mux\/user-attachments\/[^`]+?\.zip)`/giu;
  for (const match of text.matchAll(pattern)) {
    const stagedPath = match.groups?.path ? normalizeReadableStagedPath(match.groups.path) : null;
    if (stagedPath != null) {
      paths.add(stagedPath);
    }
  }
  return [...paths];
}

export function sanitizeZipFilename(filename: string): string {
  const rawBase = filename.split(/[\\/]/u).pop()?.trim() ?? "";
  const withoutControls = Array.from(rawBase)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
  const safeChars = withoutControls.replace(/[^A-Za-z0-9._ -]/gu, "-").replace(/^\.+/u, "");
  const withExtension = safeChars.toLowerCase().endsWith(".zip") ? safeChars : `${safeChars}.zip`;
  const fallback =
    withExtension === ".zip" || withExtension.trim().length === 0
      ? "attachment.zip"
      : withExtension;
  if (fallback.length <= 120) {
    return fallback;
  }
  const stem = fallback.slice(0, 116).replace(/\.+$/u, "") || "attachment";
  return `${stem}.zip`;
}

function normalizeReadableStagedPath(stagedPath: string): string | null {
  const normalized = stagedPath.replace(/\\/gu, "/").replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.includes("//") ||
    normalized.split("/").includes("..") ||
    !normalized.startsWith(`${STAGED_ATTACHMENT_DIR}/`) ||
    !normalized.toLowerCase().endsWith(".zip")
  ) {
    return null;
  }
  return normalized;
}

function normalizeStagedAttachmentPaths(stagedPaths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const stagedPath of stagedPaths) {
    const readablePath = normalizeReadableStagedPath(stagedPath);
    if (readablePath != null) {
      normalized.add(readablePath);
    }
  }
  return [...normalized];
}

async function listStagedAttachmentPaths(
  runtime: Runtime,
  workspacePath: string
): Promise<Result<string[], string>> {
  const result = await execBuffered(
    runtime,
    `if [ ! -d ${shellQuote(STAGED_ATTACHMENT_DIR)} ]; then exit 0; fi; find ${shellQuote(STAGED_ATTACHMENT_DIR)} -type f -iname '*.zip' -print`,
    { cwd: workspacePath, timeout: 30 }
  );
  if (result.exitCode !== 0) {
    return Err(result.stderr.trim() || "Failed to list staged attachments.");
  }

  const stagedPaths: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const stagedPath = normalizeReadableStagedPath(line.trim());
    if (stagedPath != null) {
      stagedPaths.push(stagedPath);
    }
  }
  return Ok(stagedPaths);
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function writeBytes(runtime: Runtime, path: string, bytes: Uint8Array): Promise<void> {
  const writer = runtime.writeFile(path).getWriter();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch (error) {
    writer.releaseLock();
    throw error;
  }
}
