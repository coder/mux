import * as path from "path";
import assert from "@/common/utils/assert";
import { MAX_SVG_TEXT_CHARS, SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import { getErrorMessage } from "@/common/utils/errors";
import { getSupportedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import type { Runtime } from "@/node/runtime/Runtime";
import { resolvePathWithinCwd } from "@/node/services/tools/fileCommon";

// Attachment payloads need a larger cap than text-oriented file tools because common
// screenshots and PDFs regularly exceed 1MB before request-time rewriting runs.
export const MAX_ATTACH_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface ReadAttachmentFromPathArgs {
  path: string;
  mediaType?: string | null;
  filename?: string | null;
  cwd: string;
  runtime: Runtime;
  abortSignal?: AbortSignal;
}

export interface LoadedAttachmentFromPath {
  data: string;
  mediaType: string;
  filename?: string;
  resolvedPath: string;
  size: number;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : undefined;
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

function formatBytesAsMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function buildMissingFileError(resolvedPath: string, error: unknown): Error {
  const message = getErrorMessage(error);
  if (message.includes("ENOENT") || message.toLowerCase().includes("not found")) {
    return new Error(`File not found: ${resolvedPath}`);
  }
  if (message.includes("EACCES") || message.toLowerCase().includes("permission denied")) {
    return new Error(`Permission denied: ${resolvedPath}`);
  }
  return new Error(message);
}

export async function readAttachmentFromPath(
  args: ReadAttachmentFromPathArgs
): Promise<LoadedAttachmentFromPath> {
  assert(
    typeof args.path === "string" && args.path.trim().length > 0,
    "attach_file requires a path"
  );

  const { resolvedPath } = resolvePathWithinCwd(args.path, args.cwd, args.runtime);

  let fileStat;
  try {
    fileStat = await args.runtime.stat(resolvedPath, args.abortSignal);
  } catch (error) {
    throw buildMissingFileError(resolvedPath, error);
  }

  if (fileStat.isDirectory) {
    throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
  }

  const fallbackFilename = path.basename(resolvedPath);
  const filename =
    normalizeOptionalString(args.filename) ?? normalizeOptionalString(fallbackFilename);
  const mediaType = getSupportedAttachmentMediaType({
    mediaType: args.mediaType,
    // Infer the attachment type from the source path, not the display filename override.
    // Callers may intentionally rename the attachment to a presentation-only label.
    filename: resolvedPath,
  });
  if (mediaType == null) {
    throw new Error(`Unsupported attachment type: ${args.mediaType ?? resolvedPath}`);
  }

  if (fileStat.size > MAX_ATTACH_FILE_SIZE_BYTES) {
    throw new Error(
      `Attachment is too large (${formatBytesAsMegabytes(fileStat.size)}). The maximum supported size is ${formatBytesAsMegabytes(MAX_ATTACH_FILE_SIZE_BYTES)}.`
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readStreamToBuffer(args.runtime.readFile(resolvedPath, args.abortSignal));
  } catch (error) {
    throw buildMissingFileError(resolvedPath, error);
  }

  assert(
    bytes.length === fileStat.size,
    `Expected to read ${fileStat.size} bytes from '${resolvedPath}', got ${bytes.length}`
  );

  if (mediaType === SVG_MEDIA_TYPE) {
    const svgText = bytes.toString("utf8");
    if (svgText.length > MAX_SVG_TEXT_CHARS) {
      throw new Error(
        `SVG attachments must be ${MAX_SVG_TEXT_CHARS.toLocaleString()} characters or less (this one is ${svgText.length.toLocaleString()}).`
      );
    }
  }

  return {
    data: bytes.toString("base64"),
    mediaType,
    filename,
    resolvedPath,
    size: bytes.length,
  };
}
