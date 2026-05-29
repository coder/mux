import assert from "node:assert";
import type { MuxMessage } from "@/common/types/message";

const DATA_URI_PREFIX = "data:";

interface ParsedDataUri {
  mediaType?: string;
  base64Data: string;
}

function parseDataUriToBase64(dataUri: string): ParsedDataUri {
  assert(dataUri.toLowerCase().startsWith(DATA_URI_PREFIX), "Expected a data URI file part");

  const commaIndex = dataUri.indexOf(",");
  assert(commaIndex !== -1, "Malformed data URI in file part: missing comma");

  const metadata = dataUri.slice(DATA_URI_PREFIX.length, commaIndex);
  const payload = dataUri.slice(commaIndex + 1);

  const metadataTokens = metadata
    .split(";")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const mediaType = metadataTokens.find((token) => token.includes("/"));
  const hasBase64Flag = metadataTokens.some((token) => token.toLowerCase() === "base64");

  if (hasBase64Flag) {
    return {
      mediaType,
      base64Data: payload,
    };
  }

  let decodedPayload: string;
  try {
    decodedPayload = decodeURIComponent(payload);
  } catch (error) {
    assert.fail(
      `Malformed data URI in file part: invalid URL encoding (${error instanceof Error ? error.message : String(error)})`
    );
  }

  return {
    mediaType,
    base64Data: Buffer.from(decodedPayload, "utf8").toString("base64"),
  };
}

/**
 * Rewrites user file-part data URIs into raw base64 payloads in `url`.
 *
 * convertToModelMessages() maps FileUIPart.url -> FilePart.data. If url remains a data:
 * URI string, downstream prompt prep can treat it as a URL and attempt to download it.
 * Converting to raw base64 keeps the payload inline and avoids URL download validation.
 */
export function convertDataUriFilePartsForSdk(messages: MuxMessage[]): MuxMessage[] {
  let changedAnyMessage = false;

  const convertedMessages = messages.map((message) => {
    if (message.role !== "user") {
      return message;
    }

    let changedMessage = false;

    const convertedParts: MuxMessage["parts"] = message.parts.map((part) => {
      if (part.type !== "file" || !part.url.toLowerCase().startsWith(DATA_URI_PREFIX)) {
        return part;
      }

      const { mediaType, base64Data } = parseDataUriToBase64(part.url);

      changedMessage = true;
      return {
        ...part,
        mediaType: mediaType ?? part.mediaType,
        url: base64Data,
      };
    });

    if (!changedMessage) {
      return message;
    }

    changedAnyMessage = true;
    return {
      ...message,
      parts: convertedParts,
    };
  });

  return changedAnyMessage ? convertedMessages : messages;
}
