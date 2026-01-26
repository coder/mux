import type { ChatAttachment } from "@/browser/components/ChatAttachments";
import { readPersistedState } from "@/browser/hooks/usePersistedState";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChatAttachment(value: unknown): value is ChatAttachment {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.url === "string" &&
    typeof value.mediaType === "string" &&
    (value.filename === undefined || typeof value.filename === "string")
  );
}

export function parsePersistedChatAttachments(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const attachments: ChatAttachment[] = [];
  for (const item of raw) {
    if (!isChatAttachment(item)) {
      return [];
    }

    attachments.push({
      id: item.id,
      url: item.url,
      mediaType: item.mediaType,
      filename: item.filename,
    });
  }

  return attachments;
}

export function readPersistedChatAttachments(attachmentsKey: string): ChatAttachment[] {
  return parsePersistedChatAttachments(readPersistedState<unknown>(attachmentsKey, []));
}

export function estimatePersistedChatAttachmentsChars(attachments: ChatAttachment[]): number {
  return JSON.stringify(attachments).length;
}
