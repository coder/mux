function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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
  const record: Record<string, unknown> = stripsCurrentImageResult
    ? {
        ...output,
        images: images.map(stripThumbnailFromImage),
        ...(isRecord(output.source) ? { source: stripResolvedSourcePath(output.source) } : {}),
      }
    : output;
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    stripped[key] =
      stripsCurrentImageResult && key === "images" ? value : stripImageToolOutputForModel(value);
  }
  return stripped;
}

export const stripImageToolThumbnails = stripImageToolOutputForModel;
