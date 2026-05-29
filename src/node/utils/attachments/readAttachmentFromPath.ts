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

// Markdown is intentionally display-only: agents should use file_read when they need
// the contents, while attach_file gives users a quick preview/download affordance.
const DISPLAY_ONLY_MARKDOWN_MEDIA_TYPES = new Set([MARKDOWN_MEDIA_TYPE, "text/x-markdown"]);

const TEXT_EXTENSIONS_REQUIRING_FILE_READ = new Set([
  "c",
  "cpp",
  "cs",
  "csv",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "htm",
  "java",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "mdx",
  "mjs",
  "py",
  "rs",
  "sh",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const TEXT_MEDIA_TYPES_REQUIRING_FILE_READ = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "text/csv",
]);

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

interface DisplayMediaTypeCandidate {
  mediaType: string;
  requireBinaryContent: boolean;
}

function getDisplayFileMediaTypeCandidate(
  args: ReadAttachmentFromPathArgs,
  resolvedPath: string
): DisplayMediaTypeCandidate | null {
  const override = normalizeOptionalString(args.mediaType);
  const extension = path.extname(resolvedPath).slice(1).toLowerCase();
  const rawMediaType = override ?? EXTENSION_TO_DISPLAY_MEDIA_TYPE[extension];

  if (rawMediaType != null) {
    const mediaType = normalizeAttachmentMediaType(rawMediaType);
    if (DISPLAY_ONLY_MARKDOWN_MEDIA_TYPES.has(mediaType)) {
      return { mediaType, requireBinaryContent: false };
    }
    if (mediaType.startsWith("text/") || TEXT_MEDIA_TYPES_REQUIRING_FILE_READ.has(mediaType)) {
      return null;
    }
    return { mediaType, requireBinaryContent: false };
  }

  if (TEXT_EXTENSIONS_REQUIRING_FILE_READ.has(extension)) {
    return null;
  }

  return { mediaType: "application/octet-stream", requireBinaryContent: true };
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

  const { resolvedPath } = resolvePathWithinCwd(args.path, args.cwd, args.runtime);
  const fileStat = await statRegularFile(args, resolvedPath);
  const filename = getFallbackFilename(resolvedPath, args.filename);
  const mediaType = getSupportedAttachmentMediaType({
    mediaType: args.mediaType,
    // Infer the attachment type from the source path, not the display filename override.
    // Callers may intentionally rename the attachment to a presentation-only label.
    filename: resolvedPath,
  });

  if (mediaType == null) {
    const displayMediaTypeCandidate = getDisplayFileMediaTypeCandidate(args, resolvedPath);
    if (displayMediaTypeCandidate == null) {
      throw createUnsupportedAttachmentError(args, resolvedPath);
    }
    if (fileStat.size > MAX_ATTACH_FILE_SIZE_BYTES) {
      throw new Error(
        `${getErrorMessage(createUnsupportedAttachmentError(args, resolvedPath))}. Could not show file to user: ${buildTooLargeMessage(fileStat.size)}`
      );
    }

    const bytes = await readRegularFileBytes(args, resolvedPath, fileStat.size);
    if (displayMediaTypeCandidate.requireBinaryContent && isLikelyTextFile(bytes)) {
      throw createUnsupportedAttachmentError(args, resolvedPath);
    }

    return {
      type: "display",
      file: createLoadedFile({
        data: bytes,
        mediaType: displayMediaTypeCandidate.mediaType,
        filename,
        resolvedPath,
      }),
    };
  }

  const bytes = await readRegularFileBytes(args, resolvedPath, fileStat.size);

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
