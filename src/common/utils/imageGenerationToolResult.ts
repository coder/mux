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
  if (isUnknownArray(output)) {
    return output.map(stripImageGenerateThumbnails);
  }
  if (!isRecord(output)) {
    return output;
  }

  const images = output.images;
  const stripsCurrentImageResult = output.success === true && isUnknownArray(images);
  const record: Record<string, unknown> = stripsCurrentImageResult
    ? {
        ...output,
        images: images.map(stripImageGenerateThumbnailFromImage),
      }
    : output;
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    stripped[key] =
      stripsCurrentImageResult && key === "images" ? value : stripImageGenerateThumbnails(value);
  }
  return stripped;
}
