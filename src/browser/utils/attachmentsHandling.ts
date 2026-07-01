import type { FilePart } from "@/common/orpc/types";
import { MAX_SVG_TEXT_CHARS, SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import { MAX_STAGED_ATTACHMENT_SIZE_BYTES } from "@/common/constants/stagedAttachments";
import {
  getSupportedAttachmentMediaType,
  getSupportedStagedAttachmentMediaType,
} from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import type { ChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";
import { resizeImageIfNeeded } from "@/browser/utils/imageResize";

/**
 * Generates a unique ID for a chat attachment.
 */
export function generateAttachmentId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export interface StageAttachmentResult {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  stagedPath: string;
}

export interface ProcessAttachmentOptions {
  stageAttachment?: (file: File, dataBase64: string) => Promise<StageAttachmentResult>;
}

function getSupportedMediaType(file: File): string | null {
  return getSupportedAttachmentMediaType({
    mediaType: file.type !== "" ? file.type : null,
    filename: file.name,
  });
}

/**
 * Convert ChatAttachment[] → FilePart[] for API calls.
 */
export function chatAttachmentsToFileParts(
  attachments: ChatAttachment[],
  options?: { validate?: boolean }
): FilePart[] {
  const validate = options?.validate ?? false;

  return attachments.flatMap((attachment, index) => {
    if (attachment.kind === "staged") {
      // Staged ZIPs live in the workspace filesystem and must never be sent as provider file parts.
      return [];
    }

    if (validate) {
      if (!attachment.url || typeof attachment.url !== "string") {
        console.error(
          `Attachment [${index}] has invalid url:`,
          typeof attachment.url,
          (attachment as { url?: unknown }).url
        );
      }
      if (typeof attachment.url === "string" && !attachment.url.startsWith("data:")) {
        console.error(`Attachment [${index}] url is not a data URL:`, attachment.url.slice(0, 100));
      }
      if (!attachment.mediaType || typeof attachment.mediaType !== "string") {
        console.error(
          `Attachment [${index}] has invalid mediaType:`,
          typeof attachment.mediaType,
          (attachment as { mediaType?: unknown }).mediaType
        );
      }
    }

    return [
      {
        url: attachment.url,
        mediaType: attachment.mediaType,
        filename: attachment.filename,
      },
    ];
  });
}

function getSupportedStagedMediaType(file: File): string | null {
  return getSupportedStagedAttachmentMediaType({
    mediaType: file.type !== "" ? file.type : null,
    filename: file.name,
  });
}

// True when a file is accepted as either a provider attachment or a staged (ZIP) attachment.
// Shared by the clipboard/drop extractors so both stay in sync on what counts as attachable.
// Both getters return a non-empty media-type string or null, so `!= null` matches the prior
// truthiness checks the extractors inlined.
function isSupportedAttachmentFile(file: File): boolean {
  return getSupportedMediaType(file) != null || getSupportedStagedMediaType(file) != null;
}

function fileBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function fileToStagedChatAttachment(
  file: File,
  stageAttachment: (file: File, dataBase64: string) => Promise<StageAttachmentResult>
): Promise<ChatAttachment> {
  const mediaType = getSupportedStagedMediaType(file);
  if (mediaType == null) {
    throw new Error(`Unsupported attachment type: ${file.type || file.name}`);
  }
  if (file.size > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
    throw new Error(
      `ZIP attachments must be ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes or less.`
    );
  }

  const dataBase64 = fileBytesToBase64(new Uint8Array(await file.arrayBuffer()));
  const staged = await stageAttachment(file, dataBase64);
  return {
    kind: "staged",
    id: generateAttachmentId(),
    filename: staged.filename,
    mediaType: staged.mediaType,
    sizeBytes: staged.sizeBytes,
    stagedPath: staged.stagedPath,
  };
}

/**
 * Converts a File to a ChatAttachment (data URL).
 */
export async function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  const mediaType = getSupportedMediaType(file);
  if (!mediaType) {
    throw new Error(`Unsupported attachment type: ${file.type || file.name}`);
  }

  // For SVGs we inline as text in provider requests. Large SVGs can error during send,
  // so fail fast here with a clear message.
  if (mediaType === SVG_MEDIA_TYPE) {
    const svgText = await file.text();
    if (svgText.length > MAX_SVG_TEXT_CHARS) {
      throw new Error(
        `SVG attachments must be ${MAX_SVG_TEXT_CHARS.toLocaleString()} characters or less (this one is ${svgText.length.toLocaleString()}).`
      );
    }

    return {
      kind: "provider",
      id: generateAttachmentId(),
      url: `data:${SVG_MEDIA_TYPE},${encodeURIComponent(svgText)}`,
      mediaType,
      filename: file.name.trim() ? file.name : undefined,
    };
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      if (result) {
        resolve(result);
      } else {
        reject(new Error("Failed to read file"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });

  const isRasterImage = mediaType.startsWith("image/") && mediaType !== SVG_MEDIA_TYPE;
  if (isRasterImage) {
    // Auto-resize large images before sending so providers don't reject oversized inputs.
    const resizeResult = await resizeImageIfNeeded(dataUrl, mediaType);

    return {
      kind: "provider",
      id: generateAttachmentId(),
      url: resizeResult.dataUrl,
      mediaType: resizeResult.mediaType,
      filename: file.name.trim() ? file.name : undefined,
      ...(resizeResult.resized
        ? {
            resizeInfo: {
              originalWidth: resizeResult.originalWidth,
              originalHeight: resizeResult.originalHeight,
              newWidth: resizeResult.width,
              newHeight: resizeResult.height,
            },
          }
        : {}),
    };
  }

  return {
    kind: "provider",
    id: generateAttachmentId(),
    url: dataUrl,
    mediaType,
    filename: file.name.trim() ? file.name : undefined,
  };
}

/**
 * Extract supported attachment files from clipboard items.
 */
export function extractAttachmentsFromClipboard(items: DataTransferItemList): File[] {
  const files: File[] = [];

  for (const item of Array.from(items)) {
    const file = item?.getAsFile();
    if (!file) continue;

    if (isSupportedAttachmentFile(file)) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Extract supported attachment files from drag and drop DataTransfer.
 */
export function extractAttachmentsFromDrop(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];

  for (const file of Array.from(dataTransfer.files)) {
    if (isSupportedAttachmentFile(file)) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Processes multiple attachment files and converts them to chat attachments.
 */
export async function processAttachmentFiles(
  files: File[],
  options: ProcessAttachmentOptions = {}
): Promise<ChatAttachment[]> {
  return await Promise.all(
    files.map((file) => {
      if (getSupportedStagedMediaType(file) != null) {
        if (!options.stageAttachment) {
          throw new Error("ZIP attachments can be added after opening a workspace.");
        }
        return fileToStagedChatAttachment(file, options.stageAttachment);
      }
      return fileToChatAttachment(file);
    })
  );
}
