function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function stripImageGenerateThumbnailFromImage(image: unknown): unknown {
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

export function stripImageGenerateThumbnails(output: unknown): unknown {
  if (!isRecord(output)) {
    return output;
  }
  if (output.success !== true || !isUnknownArray(output.images)) {
    return output;
  }

  return {
    ...output,
    images: output.images.map(stripImageGenerateThumbnailFromImage),
  };
}
