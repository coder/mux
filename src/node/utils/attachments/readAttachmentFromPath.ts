import * as fsPromises from "node:fs/promises";
import * as path from "path";
import assert from "@/common/utils/assert";
import { MAX_SVG_TEXT_CHARS, SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import { getErrorMessage } from "@/common/utils/errors";
import {
  getSupportedAttachmentMediaType,
  MARKDOWN_MEDIA_TYPE,
  normalizeAttachmentMediaType,
} from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import type { FileStat, Runtime } from "@/node/runtime/Runtime";
import { resolvePathWithinCwd } from "@/node/services/tools/fileCommon";
import { isPathInsideDir } from "@/node/utils/pathUtils";
import {
  isRasterAttachmentMediaType,
  resizeRasterImageAttachmentBufferIfNeeded,
} from "@/node/utils/attachments/resizeRasterImageAttachment";

// This cap applies to both model attachments and display-only fallback files so
// chat history never persists unexpectedly large base64 payloads.
export const MAX_ATTACH_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface ReadAttachmentFromPathArgs {
  path: string;
  mediaType?: string | null;
  filename?: string | null;
  cwd: string;
  runtime: Runtime;
  abortSignal?: AbortSignal;
  /** Host-local owner-session artifact root, readable even when the workspace runtime is remote. */
  localArtifactRoot?: string;
}

export interface LoadedFileFromPath {
  data: string;
  mediaType: string;
  filename?: string;
  resolvedPath: string;
  size: number;
}

export type AttachFileFromPathResult =
  | { type: "attachment"; attachment: LoadedFileFromPath }
  | { type: "display"; file: LoadedFileFromPath };

const EXTENSION_TO_DISPLAY_MEDIA_TYPE: Record<string, string> = {
  webm: "video/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  md: MARKDOWN_MEDIA_TYPE,
  markdown: MARKDOWN_MEDIA_TYPE,
  mdown: MARKDOWN_MEDIA_TYPE,
};

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

function buildTooLargeMessage(bytes: number): string {
  return `Attachment is too large (${formatBytesAsMegabytes(bytes)}). The maximum supported size is ${formatBytesAsMegabytes(MAX_ATTACH_FILE_SIZE_BYTES)}.`;
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

async function statRegularFile(
  args: ReadAttachmentFromPathArgs,
  resolvedPath: string
): Promise<FileStat> {
  let fileStat: FileStat;
  try {
    fileStat = await args.runtime.stat(resolvedPath, args.abortSignal);
  } catch (error) {
    throw buildMissingFileError(resolvedPath, error);
  }

  if (fileStat.isDirectory) {
    throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
  }

  return fileStat;
}

async function readRegularFileBytes(
  args: ReadAttachmentFromPathArgs,
  resolvedPath: string,
  expectedSize: number
): Promise<Buffer> {
  if (expectedSize > MAX_ATTACH_FILE_SIZE_BYTES) {
    throw new Error(buildTooLargeMessage(expectedSize));
  }

  let bytes: Buffer;
  try {
    bytes = await readStreamToBuffer(args.runtime.readFile(resolvedPath, args.abortSignal));
  } catch (error) {
    throw buildMissingFileError(resolvedPath, error);
  }

  assert(
    bytes.length === expectedSize,
    `Expected to read ${expectedSize} bytes from '${resolvedPath}', got ${bytes.length}`
  );

  return bytes;
}

async function readLocalArtifactIfAllowed(
  args: ReadAttachmentFromPathArgs
): Promise<{ resolvedPath: string; bytes: Buffer } | null> {
  if (args.localArtifactRoot == null || !path.isAbsolute(args.path)) {
    return null;
  }

  const artifactRoot = path.resolve(args.localArtifactRoot);
  const resolvedPath = path.resolve(args.path);
  if (!isPathInsideDir(artifactRoot, resolvedPath)) {
    return null;
  }
  if (args.abortSignal?.aborted) {
    throw new Error("Interrupted");
  }

  let stat: Awaited<ReturnType<typeof fsPromises.lstat>>;
  try {
    stat = await fsPromises.lstat(resolvedPath);
  } catch (error) {
    throw buildMissingFileError(resolvedPath, error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Path is not a regular artifact file: ${resolvedPath}`);
  }
  if (stat.size > MAX_ATTACH_FILE_SIZE_BYTES) {
    throw new Error(buildTooLargeMessage(stat.size));
  }

  const bytes = await fsPromises.readFile(resolvedPath);
  assert(
    bytes.length === stat.size,
    `Expected to read ${stat.size} bytes from '${resolvedPath}', got ${bytes.length}`
  );
  return { resolvedPath, bytes };
}

function createUnsupportedAttachmentError(
  args: ReadAttachmentFromPathArgs,
  resolvedPath: string
): Error {
  return new Error(`Unsupported attachment type: ${args.mediaType ?? resolvedPath}`);
}

function getFallbackFilename(
  resolvedPath: string,
  filename: string | null | undefined
): string | undefined {
  return normalizeOptionalString(filename) ?? normalizeOptionalString(path.basename(resolvedPath));
}

// Pick the media type for a display-only file. Images/SVG/PDF never reach here
// (they become real model attachments); everything else is shown to the user for
// preview/download. A caller override wins, then known audio/video/markdown
// extensions keep their specific type, and anything else is classified as text or
// binary by sniffing the bytes so the download and inline preview behave sensibly.
function resolveDisplayMediaType(
  args: ReadAttachmentFromPathArgs,
  resolvedPath: string,
  bytes: Buffer
): string {
  const override = normalizeOptionalString(args.mediaType);
  if (override != null) {
    return normalizeAttachmentMediaType(override);
  }

  const extension = path.extname(resolvedPath).slice(1).toLowerCase();
  const mapped = EXTENSION_TO_DISPLAY_MEDIA_TYPE[extension];
  if (mapped != null) {
    return normalizeAttachmentMediaType(mapped);
  }

  return isLikelyTextFile(bytes) ? "text/plain" : "application/octet-stream";
}

function isLikelyTextFile(bytes: Buffer): boolean {
  if (bytes.length === 0) {
    return true;
  }
  if (bytes.includes(0)) {
    return false;
  }

  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) {
    return false;
  }

  let controlCharacterCount = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 && char !== "\n" && char !== "\r" && char !== "\t") {
      controlCharacterCount++;
    }
  }

  return controlCharacterCount / text.length < 0.05;
}

function createLoadedFile(args: {
  data: Buffer;
  mediaType: string;
  filename?: string;
  resolvedPath: string;
}): LoadedFileFromPath {
  return {
    data: args.data.toString("base64"),
    mediaType: args.mediaType,
    filename: args.filename,
    resolvedPath: args.resolvedPath,
    size: args.data.length,
  };
}

export async function readAttachFileFromPath(
  args: ReadAttachmentFromPathArgs
): Promise<AttachFileFromPathResult> {
  assert(
    typeof args.path === "string" && args.path.trim().length > 0,
    "attach_file requires a path"
  );

  const localArtifact = await readLocalArtifactIfAllowed(args);
  const { resolvedPath, fileSize, localBytes } = localArtifact
    ? {
        resolvedPath: localArtifact.resolvedPath,
        fileSize: localArtifact.bytes.length,
        localBytes: localArtifact.bytes,
      }
    : await (async () => {
        const resolved = resolvePathWithinCwd(args.path, args.cwd, args.runtime).resolvedPath;
        const fileStat = await statRegularFile(args, resolved);
        return { resolvedPath: resolved, fileSize: fileStat.size, localBytes: undefined };
      })();
  const filename = getFallbackFilename(resolvedPath, args.filename);
  const mediaType = getSupportedAttachmentMediaType({
    mediaType: args.mediaType,
    // Infer the attachment type from the source path, not the display filename override.
    // Callers may intentionally rename the attachment to a presentation-only label.
    filename: resolvedPath,
  });

  if (mediaType == null) {
    // Not an image/SVG/PDF, so it can't be a real model attachment. Show it to the
    // user for preview/download instead of rejecting it; the size cap still applies.
    if (fileSize > MAX_ATTACH_FILE_SIZE_BYTES) {
      throw new Error(buildTooLargeMessage(fileSize));
    }

    const bytes = localBytes ?? (await readRegularFileBytes(args, resolvedPath, fileSize));
    return {
      type: "display",
      file: createLoadedFile({
        data: bytes,
        mediaType: resolveDisplayMediaType(args, resolvedPath, bytes),
        filename,
        resolvedPath,
      }),
    };
  }

  const bytes = localBytes ?? (await readRegularFileBytes(args, resolvedPath, fileSize));

  if (mediaType === SVG_MEDIA_TYPE) {
    const svgText = bytes.toString("utf8");
    if (svgText.length > MAX_SVG_TEXT_CHARS) {
      throw new Error(
        `SVG attachments must be ${MAX_SVG_TEXT_CHARS.toLocaleString()} characters or less (this one is ${svgText.length.toLocaleString()}).`
      );
    }
  }

  let attachmentBytes = bytes;
  let attachmentMediaType = mediaType;
  if (isRasterAttachmentMediaType(mediaType)) {
    // Keep attach_file aligned with chat drag/drop attachments so oversized screenshots
    // don't get persisted into history as impossible-to-send provider inputs.
    const resizedAttachment = await resizeRasterImageAttachmentBufferIfNeeded(bytes, mediaType);
    attachmentBytes = resizedAttachment.data;
    attachmentMediaType = resizedAttachment.mediaType;
  }

  return {
    type: "attachment",
    attachment: createLoadedFile({
      data: attachmentBytes,
      mediaType: attachmentMediaType,
      filename,
      resolvedPath,
    }),
  };
}

export async function readAttachmentFromPath(
  args: ReadAttachmentFromPathArgs
): Promise<LoadedFileFromPath> {
  const result = await readAttachFileFromPath(args);
  if (result.type === "attachment") {
    return result.attachment;
  }

  throw createUnsupportedAttachmentError(args, result.file.resolvedPath);
}
