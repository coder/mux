/**
 * Utilities for reading workspace files via bash commands.
 */

/** Maximum file size for reading into the UI (10MB). */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Exit code for "file too large". */
export const EXIT_CODE_TOO_LARGE = 42;

/** Exit code for "file has too many lines for the current UI budget". */
export const EXIT_CODE_TOO_MANY_LINES = 43;

interface ReadFileScriptOptions {
  maxSizeBytes?: number;
  maxLineCount?: number;
}

/** Magic bytes for image type detection. */
const IMAGE_MAGIC_BYTES: Array<{ bytes: number[]; mime: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { bytes: [0x47, 0x49, 0x46], mime: "image/gif" },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" },
  { bytes: [0x42, 0x4d], mime: "image/bmp" },
  { bytes: [0x00, 0x00, 0x01, 0x00], mime: "image/x-icon" },
];

/** Escapes a path for safe use in shell commands. */
function shellEscape(s: string): string {
  return "'" + s.replaceAll("'", "'\"'\"'") + "'";
}

/** Decode a base64 string to bytes. */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/** Detect image type from magic bytes. */
function detectImageType(buffer: Uint8Array): string | undefined {
  for (const { bytes, mime } of IMAGE_MAGIC_BYTES) {
    if (buffer.length < bytes.length) continue;

    let matches = true;
    for (let i = 0; i < bytes.length; i++) {
      if (buffer[i] !== bytes[i]) {
        matches = false;
        break;
      }
    }

    if (!matches) continue;

    if (mime === "image/webp") {
      if (
        buffer.length >= 12 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
      ) {
        return mime;
      }
      continue;
    }

    return mime;
  }

  return undefined;
}

/** Check if file is an SVG by looking for XML/SVG markers in content. */
function detectSvg(buffer: Uint8Array): boolean {
  const sampleSize = Math.min(buffer.length, 1024);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    const text = decoder.decode(buffer.slice(0, sampleSize)).toLowerCase();
    return text.includes("<svg") || (text.includes("<?xml") && text.includes("<svg"));
  } catch {
    return false;
  }
}

/** Check if buffer contains binary content. */
function detectBinary(buffer: Uint8Array): boolean {
  const sampleSize = Math.min(buffer.length, 8192);

  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate bash script to read file contents with size and optional line-count checks.
 * Uses base64 encoding for all files to handle binary safely.
 */
export function buildReadFileScript(
  relativePath: string,
  options: ReadFileScriptOptions = {}
): string {
  const file = shellEscape(relativePath);
  const maxSizeBytes = Math.max(0, Math.trunc(options.maxSizeBytes ?? MAX_FILE_SIZE));
  const maxLineCount =
    options.maxLineCount == null ? null : Math.max(0, Math.trunc(options.maxLineCount));
  const lineLimitScript =
    maxLineCount == null
      ? ""
      : `
awk 'NR > ${maxLineCount} { exit ${EXIT_CODE_TOO_MANY_LINES} }' ${file}
awk_status=$?
[ "$awk_status" -ne 0 ] && exit "$awk_status"`;

  return `size=$(stat -c %s ${file} 2>/dev/null || stat -f %z ${file})
[ "$size" -gt ${maxSizeBytes} ] && exit ${EXIT_CODE_TOO_LARGE}${lineLimitScript}
echo "$size"
base64 < ${file}`;
}

/** Parse the read file script output (size on first line, base64 on remaining lines). */
function parseReadFileOutput(output: string): { size: number; base64: string } {
  const firstNewline = output.indexOf("\n");

  if (firstNewline === -1) {
    const size = parseInt(output, 10);
    if (isNaN(size)) {
      throw new Error("Invalid file output format");
    }
    return { size, base64: "" };
  }

  const size = parseInt(output.slice(0, firstNewline), 10);
  if (isNaN(size)) {
    throw new Error("Invalid file size");
  }
  const base64 = output.slice(firstNewline + 1).replace(/[\r\n]/g, "");
  return { size, base64 };
}

/** File contents response types for the client. */
export type FileContentsResult =
  | { type: "text"; content: string; size: number }
  | { type: "image"; base64: string; mimeType: string; size: number }
  | { type: "error"; message: string };

/** Decode and classify file contents returned by buildReadFileScript. */
export function processFileContents(output: string, exitCode: number): FileContentsResult {
  if (exitCode === EXIT_CODE_TOO_LARGE) {
    return { type: "error", message: "File is too large to display. Maximum: 10 MB." };
  }

  if (exitCode === EXIT_CODE_TOO_MANY_LINES) {
    return { type: "error", message: "File has too many lines to display." };
  }

  const { size, base64 } = parseReadFileOutput(output);

  let buffer: Uint8Array;
  try {
    buffer = base64ToUint8Array(base64);
  } catch {
    return { type: "error", message: "Unable to decode file contents" };
  }

  const mimeType = detectImageType(buffer);
  if (mimeType) {
    return { type: "image", base64, mimeType, size };
  }

  if (detectSvg(buffer)) {
    return { type: "image", base64, mimeType: "image/svg+xml", size };
  }

  if (detectBinary(buffer)) {
    return { type: "error", message: "Unable to display binary file" };
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  return { type: "text", content: decoder.decode(buffer), size };
}
