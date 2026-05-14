function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

const IMAGE_TOOL_ERROR_MAX_CHARS = 4_096;
const IMAGE_TOOL_ERROR_PREFIX_CHARS = 700;

function isProbablyBinaryText(value: string): boolean {
  let suspiciousCharacters = 0;
  const sample = value.slice(0, IMAGE_TOOL_ERROR_MAX_CHARS);
  for (const char of sample) {
    const codePoint = char.codePointAt(0);
    if (codePoint == null) {
      continue;
    }
    if (char === "\ufffd" || (codePoint < 32 && char !== "\n" && char !== "\r" && char !== "\t")) {
      suspiciousCharacters += 1;
    }
  }
  return suspiciousCharacters >= 8;
}

// Provider/SDK response-shape bugs can decode image bytes as text; never replay
// megabyte-scale binary-looking errors back into model context or persisted tool output.
export function sanitizeImageToolErrorForModel(error: string): string {
  if (error.length <= IMAGE_TOOL_ERROR_MAX_CHARS) {
    return error;
  }

  const prefix = error.slice(0, IMAGE_TOOL_ERROR_PREFIX_CHARS).trimEnd();
  const reason = isProbablyBinaryText(error) ? "binary" : "oversized";
  return `${prefix}\n[omitted ${reason} image tool error: original length ${error.length} characters]`;
}

function stripFailedImageToolError(output: Record<string, unknown>): Record<string, unknown> {
  if (output.success !== false || typeof output.error !== "string") {
    return output;
  }

  const sanitizedError = sanitizeImageToolErrorForModel(output.error);
  if (sanitizedError === output.error) {
    return output;
  }

  return { ...output, error: sanitizedError };
}

function stripThumbnailFromImage(image: unknown): unknown {
  if (!isRecord(image)) {
    return image;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(image)) {
    if (key !== "thumbnail") {
      stripped[key] = value;
    }
  }
  return stripped;
}

function stripResolvedSourcePath(source: unknown): unknown {
  if (!isRecord(source)) {
    return source;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key !== "resolvedPath") {
      stripped[key] = value;
    }
  }
  return stripped;
}

export function stripImageToolOutputForModel(output: unknown): unknown {
  if (isUnknownArray(output)) {
    return output.map(stripImageToolOutputForModel);
  }
  if (!isRecord(output)) {
    return output;
  }

  const images = output.images;
  const stripsCurrentImageResult = output.success === true && isUnknownArray(images);
  const record: Record<string, unknown> = stripFailedImageToolError(
    stripsCurrentImageResult
      ? {
          ...output,
          images: images.map(stripThumbnailFromImage),
          ...(isRecord(output.source) ? { source: stripResolvedSourcePath(output.source) } : {}),
        }
      : output
  );
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    stripped[key] =
      stripsCurrentImageResult && key === "images" ? value : stripImageToolOutputForModel(value);
  }
  return stripped;
}

export const stripImageToolThumbnails = stripImageToolOutputForModel;
