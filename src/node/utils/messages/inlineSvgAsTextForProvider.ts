import { MAX_SVG_TEXT_CHARS, SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import type { MuxMessage, MuxTextPart } from "@/common/types/message";

// Guardrail: prevent accidentally injecting a multi‑MB SVG into the prompt.
const DEFAULT_MAX_SVG_TEXT_BYTES = 200 * 1024; // 200 KiB

// Most provider image endpoints only accept raster formats. SVG is vector markup, and sending it as an
// image frequently fails validation. We inline the SVG XML as text in provider requests instead.

function normalizeMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim();
}

function estimateBase64Bytes(base64: string): number {
  const trimmed = base64.trim();
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

function decodeSvgDataUrlToUtf8(svgDataUrl: string, maxBytes: number, maxChars: number): string {
  if (!svgDataUrl.startsWith("data:")) {
    throw new Error("SVG attachment must be a data URL to inline as text.");
  }

  const commaIndex = svgDataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("SVG attachment data URL is malformed (missing comma).");
  }

  const meta = svgDataUrl.slice("data:".length, commaIndex).toLowerCase();
  const payload = svgDataUrl.slice(commaIndex + 1);
  const isBase64 = meta.includes(";base64");

  if (isBase64) {
    const estimatedBytes = estimateBase64Bytes(payload);
    if (estimatedBytes > maxBytes) {
      throw new Error(
        `SVG attachment is too large to inline as text (${estimatedBytes} bytes > ${maxBytes} bytes).`
      );
    }

    const buf = Buffer.from(payload, "base64");
    if (buf.length > maxBytes) {
      throw new Error(
        `SVG attachment is too large to inline as text (${buf.length} bytes > ${maxBytes} bytes).`
      );
    }

    const svgText = buf.toString("utf8");
    if (svgText.length > maxChars) {
      throw new Error(
        `SVG attachment is too long to inline as text (${svgText.length} chars > ${maxChars} chars).`
      );
    }

    return svgText;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    throw new Error("SVG attachment data URL is malformed (invalid URL encoding).");
  }

  if (decoded.length > maxChars) {
    throw new Error(
      `SVG attachment is too long to inline as text (${decoded.length} chars > ${maxChars} chars).`
    );
  }

  const byteLength = Buffer.byteLength(decoded, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(
      `SVG attachment is too large to inline as text (${byteLength} bytes > ${maxBytes} bytes).`
    );
  }

  return decoded;
}

/**
 * Convert SVG user attachments into SVG source text in the provider request.
 *
 * Why: many providers only accept raster images (jpeg/png/gif/webp). Sending SVG as an
 * image frequently fails validation. Inlining as text supports SVG editing workflows.
 *
 * Notes:
 * - Request-only: does not mutate persisted history/UI.
 * - Scope: user message `file` parts only.
 */
export function inlineSvgAsTextForProvider(
  messages: MuxMessage[],
  options?: { maxSvgTextBytes?: number; maxSvgTextChars?: number }
): MuxMessage[] {
  const maxSvgTextChars = options?.maxSvgTextChars ?? MAX_SVG_TEXT_CHARS;
  const maxSvgTextBytes = options?.maxSvgTextBytes ?? DEFAULT_MAX_SVG_TEXT_BYTES;

  let didChange = false;

  const result = messages.map((msg) => {
    if (msg.role !== "user") {
      return msg;
    }

    const hasSvg = msg.parts.some(
      (part) => part.type === "file" && normalizeMediaType(part.mediaType) === SVG_MEDIA_TYPE
    );
    if (!hasSvg) {
      return msg;
    }

    didChange = true;

    const newParts: MuxMessage["parts"] = [];

    for (const part of msg.parts) {
      if (part.type === "file" && normalizeMediaType(part.mediaType) === SVG_MEDIA_TYPE) {
        try {
          const svgText = decodeSvgDataUrlToUtf8(part.url, maxSvgTextBytes, maxSvgTextChars);
          const textPart: MuxTextPart = {
            type: "text",
            text:
              `[SVG attachment converted to text (providers generally don't accept ${SVG_MEDIA_TYPE} as an image input).]\n\n` +
              `\`\`\`svg\n${svgText}\n\`\`\``,
          };
          newParts.push(textPart);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Failed to decode SVG attachment.";
          const textPart: MuxTextPart = {
            type: "text",
            text: `[SVG attachment omitted from provider request: ${errorMessage}]`,
          };
          newParts.push(textPart);
        }
        continue;
      }

      newParts.push(part);
    }

    return {
      ...msg,
      parts: newParts,
    };
  });

  return didChange ? result : messages;
}
