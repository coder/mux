import type { MuxMessage } from "@/common/types/message";
import { SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import { sanitizeAnthropicDocumentFilename } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import {
  createDataUrlForExtractedAttachment,
  createInlineSvgAttachmentText,
  createToolAttachmentSummaryText,
  extractAttachmentsFromToolOutput,
} from "@/node/utils/messages/toolResultAttachments";

/**
 * Provider-request-only rewrite to avoid sending huge attachment payloads inside tool-result JSON.
 *
 * Some tools return attachments as base64 in the tool output.
 * If that payload is sent as tool-result JSON, providers can treat it as text, quickly
 * exceeding context limits.
 *
 * This helper:
 * - detects tool outputs shaped like { type: "content", value: [{ type: "media", data, mediaType }, ...] }
 * - replaces supported media items in the tool output with small text placeholders
 * - emits a synthetic *user* message immediately after the assistant message, attaching the files
 *   as proper multimodal file parts (MuxFilePart)
 *
 * NOTE: This is request-only: it should be applied to the in-memory message list right before
 * convertToModelMessages(...). Persisted history and UI still keep the original tool output.
 */
export function extractToolMediaAsUserMessages(messages: MuxMessage[]): MuxMessage[] {
  let didChangeAnyMessage = false;
  const result: MuxMessage[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      result.push(message);
      continue;
    }

    let extractedUserParts: MuxMessage["parts"] = [];
    let extractedAttachmentCount = 0;
    let changedMessage = false;

    const newParts = message.parts.map((part) => {
      if (part.type !== "dynamic-tool" || part.state !== "output-available") {
        return part;
      }

      const extracted = extractAttachmentsFromToolOutput(part.output);
      if (extracted == null) {
        return part;
      }

      changedMessage = true;
      extractedAttachmentCount += extracted.attachments.length;

      const nextExtractedUserParts: MuxMessage["parts"] = [];
      for (const attachment of extracted.attachments) {
        if (attachment.mediaType === SVG_MEDIA_TYPE) {
          try {
            nextExtractedUserParts.push({
              type: "text",
              text: createInlineSvgAttachmentText(attachment),
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : "Failed to inline SVG attachment.";
            nextExtractedUserParts.push({
              type: "text",
              text: `[SVG attachment omitted from provider request: ${errorMessage}]`,
            });
          }
          continue;
        }

        nextExtractedUserParts.push({
          type: "file",
          mediaType: attachment.mediaType,
          url: createDataUrlForExtractedAttachment(attachment),
          ...(attachment.filename
            ? {
                filename:
                  attachment.mediaType === "application/pdf"
                    ? sanitizeAnthropicDocumentFilename(attachment.filename)
                    : attachment.filename,
              }
            : {}),
        });
      }

      extractedUserParts = [...extractedUserParts, ...nextExtractedUserParts];

      return {
        ...part,
        output: extracted.newOutput,
      };
    });

    const rewrittenMessage = changedMessage
      ? ({ ...message, parts: newParts } satisfies MuxMessage)
      : message;
    if (changedMessage) {
      didChangeAnyMessage = true;
    }
    result.push(rewrittenMessage);

    if (extractedUserParts.length > 0) {
      didChangeAnyMessage = true;
      const timestamp = message.metadata?.timestamp ?? Date.now();
      result.push({
        id: `tool-media-${message.id}`,
        role: "user",
        parts: [
          {
            type: "text",
            text: createToolAttachmentSummaryText(extractedAttachmentCount),
          },
          ...extractedUserParts,
        ],
        metadata: {
          timestamp,
          synthetic: true,
        },
      });
    }
  }

  return didChangeAnyMessage ? result : messages;
}
