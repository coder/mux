import type { MuxMessage, MuxTextPart } from "@/common/types/message";

const SVG_MEDIA_TYPE = "image/svg+xml";

// Guardrail: prevent accidentally injecting a multi‑MB SVG into the prompt.
const DEFAULT_MAX_SVG_TEXT_BYTES = 200 * 1024; // 200 KiB

// Provider image support is not uniform. For now, we assume common vision endpoints accept
// only raster formats. SVG (vector markup) is handled by inlining the SVG XML as text.
const PROVIDER_SUPPORTED_IMAGE_TYPES: Partial<Record<string, ReadonlySet<string>>> = {
  openai: new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  anthropic: new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  // OpenRouter models generally proxy the same image constraints.
  openrouter: new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
};

function normalizeMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim();
}

function estimateBase64Bytes(base64: string): number {
  const trimmed = base64.trim();
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

function decodeSvgDataUrlToUtf8(svgDataUrl: string, maxBytes: number): string {
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

    return buf.toString("utf8");
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    throw new Error("SVG attachment data URL is malformed (invalid URL encoding).");
  }

  const byteLength = Buffer.byteLength(decoded, "utf8");
  if (byteLength > maxBytes) {
    throw new Error(
      `SVG attachment is too large to inline as text (${byteLength} bytes > ${maxBytes} bytes).`
    );
  }

  return decoded;
}

function providerSupportsImageType(providerName: string, mediaType: string): boolean {
  const supported = PROVIDER_SUPPORTED_IMAGE_TYPES[providerName];
  if (!supported) {
    // Unknown provider: be conservative and assume SVG is NOT supported.
    return false;
  }
  return supported.has(normalizeMediaType(mediaType));
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
  providerName: string,
  options?: { maxSvgTextBytes?: number }
): MuxMessage[] {
  // If the provider explicitly supports SVG images, we can pass them through.
  if (providerSupportsImageType(providerName, SVG_MEDIA_TYPE)) {
    return messages;
  }

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
        const svgText = decodeSvgDataUrlToUtf8(part.url, maxSvgTextBytes);
        const textPart: MuxTextPart = {
          type: "text",
          text:
            `[SVG attachment converted to text because the provider doesn't accept ${SVG_MEDIA_TYPE}.]\n\n` +
            `\`\`\`svg\n${svgText}\n\`\`\``,
        };
        newParts.push(textPart);
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
