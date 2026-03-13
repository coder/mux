import { MAX_SVG_TEXT_CHARS, SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import {
  isSupportedAttachmentMediaType,
  normalizeAttachmentMediaType,
} from "@/common/utils/attachments/supportedAttachmentMediaTypes";

export interface ExtractedToolAttachment {
  data: string;
  mediaType: string;
  filename?: string;
}

interface AISDKMediaPart {
  type: "media";
  data: string;
  mediaType: string;
  filename?: string;
}

interface AISDKTextPart {
  type: "text";
  text: string;
}

type AISDKContent = AISDKMediaPart | AISDKTextPart | { type: string; [key: string]: unknown };

interface AISDKContentContainer {
  type: "content";
  value: AISDKContent[];
}

interface JsonContainer {
  type: "json";
  value: unknown;
}

function isJsonContainer(value: unknown): value is JsonContainer {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "json" &&
    "value" in (value as Record<string, unknown>)
  );
}

function isContentContainer(value: unknown): value is AISDKContentContainer {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "content" &&
    Array.isArray((value as Record<string, unknown>).value)
  );
}

function isMediaPart(value: unknown): value is AISDKMediaPart {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "media" &&
    typeof record.data === "string" &&
    typeof record.mediaType === "string" &&
    (record.filename === undefined || typeof record.filename === "string")
  );
}

function normalizeOptionalFilename(filename: string | undefined): string | undefined {
  const trimmed = filename?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : undefined;
}

function buildAttachmentPlaceholder(item: AISDKMediaPart): AISDKTextPart {
  const normalizedMediaType = normalizeAttachmentMediaType(item.mediaType);
  const filename = normalizeOptionalFilename(item.filename);
  const label = filename != null ? `${filename} (${normalizedMediaType})` : normalizedMediaType;
  return {
    type: "text",
    text: `[Attachment attached: ${label} (base64 len=${item.data.length})]`,
  };
}

export function extractAttachmentsFromToolOutput(
  output: unknown
): { newOutput: unknown; attachments: ExtractedToolAttachment[] } | null {
  if (isJsonContainer(output)) {
    const extracted = extractAttachmentsFromToolOutput(output.value);
    if (extracted == null) {
      return null;
    }

    return {
      newOutput: { type: "json", value: extracted.newOutput },
      attachments: extracted.attachments,
    };
  }

  if (!isContentContainer(output)) {
    return null;
  }

  const attachments: ExtractedToolAttachment[] = [];
  const newValue: AISDKContent[] = [];

  for (const item of output.value) {
    if (isMediaPart(item) && isSupportedAttachmentMediaType(item.mediaType)) {
      attachments.push({
        data: item.data,
        mediaType: normalizeAttachmentMediaType(item.mediaType),
        ...(normalizeOptionalFilename(item.filename)
          ? { filename: normalizeOptionalFilename(item.filename) }
          : {}),
      });
      newValue.push(buildAttachmentPlaceholder(item));
      continue;
    }

    newValue.push(item);
  }

  if (attachments.length === 0) {
    return null;
  }

  return {
    newOutput: { type: "content", value: newValue },
    attachments,
  };
}

export function createToolAttachmentSummaryText(count: number): string {
  return `[Attached ${count} attachment(s) from tool output]`;
}

export function createDataUrlForExtractedAttachment(attachment: ExtractedToolAttachment): string {
  if (attachment.mediaType === SVG_MEDIA_TYPE) {
    const svgText = Buffer.from(attachment.data, "base64").toString("utf8");
    return `data:${SVG_MEDIA_TYPE},${encodeURIComponent(svgText)}`;
  }

  return `data:${attachment.mediaType};base64,${attachment.data}`;
}

export function createInlineSvgAttachmentText(attachment: ExtractedToolAttachment): string {
  if (attachment.mediaType !== SVG_MEDIA_TYPE) {
    throw new Error(`Expected an SVG attachment, got '${attachment.mediaType}'`);
  }

  const svgText = Buffer.from(attachment.data, "base64").toString("utf8");
  if (svgText.length > MAX_SVG_TEXT_CHARS) {
    throw new Error(
      `SVG attachment is too long to inline as text (${svgText.length} chars > ${MAX_SVG_TEXT_CHARS} chars).`
    );
  }

  return (
    `[SVG attachment converted to text (providers generally don't accept ${SVG_MEDIA_TYPE} as an image input).]\n\n` +
    `\`\`\`svg\n${svgText}\n\`\`\``
  );
}
