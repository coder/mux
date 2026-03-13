import { SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";

export const PDF_MEDIA_TYPE = "application/pdf";

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: SVG_MEDIA_TYPE,
  pdf: PDF_MEDIA_TYPE,
};

export function normalizeAttachmentMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0];
}

export function getAttachmentMediaTypeFromExtension(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop();
  return EXTENSION_TO_MEDIA_TYPE[ext ?? ""] ?? null;
}

export function isSupportedAttachmentMediaType(mediaType: string): boolean {
  const normalized = normalizeAttachmentMediaType(mediaType);
  return normalized.startsWith("image/") || normalized === PDF_MEDIA_TYPE;
}

export function getSupportedAttachmentMediaType(args: {
  mediaType?: string | null;
  filename?: string | null;
}): string | null {
  const trimmedMediaType = args.mediaType?.trim();
  const rawMediaType =
    trimmedMediaType != null && trimmedMediaType.length > 0
      ? trimmedMediaType
      : args.filename != null
        ? (getAttachmentMediaTypeFromExtension(args.filename) ?? "")
        : "";
  if (rawMediaType.length === 0) {
    return null;
  }

  const normalized = normalizeAttachmentMediaType(rawMediaType);
  return isSupportedAttachmentMediaType(normalized) ? normalized : null;
}
