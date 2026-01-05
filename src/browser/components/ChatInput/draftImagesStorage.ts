import type { ImageAttachment } from "@/browser/components/ImageAttachments";
import { readPersistedState } from "@/browser/hooks/usePersistedState";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isImageAttachment(value: unknown): value is ImageAttachment {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    typeof value.mediaType === "string"
  );
}

export function parsePersistedImageAttachments(raw: unknown): ImageAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const attachments: ImageAttachment[] = [];
  for (const item of raw) {
    if (!isImageAttachment(item)) {
      return [];
    }
    attachments.push({ id: item.id, url: item.url, mediaType: item.mediaType });
  }

  return attachments;
}

export function readPersistedImageAttachments(imagesKey: string): ImageAttachment[] {
  return parsePersistedImageAttachments(readPersistedState<unknown>(imagesKey, []));
}

export function estimatePersistedImageAttachmentsChars(images: ImageAttachment[]): number {
  return JSON.stringify(images).length;
}
