import type { FilePart, ImagePart, ModelMessage, TextPart, ToolResultPart } from "ai";
import { SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import { sanitizeAnthropicDocumentFilename } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import {
  createInlineSvgAttachmentText,
  createToolAttachmentSummaryText,
  extractAttachmentsFromToolOutput,
  type ExtractedToolAttachment,
} from "@/node/utils/messages/toolResultAttachments";

// Extract the output type from ToolResultPart to ensure type compatibility with ai@6
type ToolResultOutput = ToolResultPart["output"];

/**
 * Request-only rewrite for *internal* streamText steps.
 *
 * streamText() can make multiple LLM calls (steps) when tools are enabled.
 * Tool results produced during the stream are included in subsequent step prompts.
 *
 * Some tools return attachments as base64 inside tool results (output.type === "content" with
 * media parts, or output.type === "json" containing a nested "content" container).
 * Providers can treat that as plain text/JSON and blow up context.
 *
 * This helper rewrites tool-result outputs to replace supported attachment payloads with small
 * text placeholders, and inserts a synthetic user message containing the extracted attachments.
 */
export function extractToolMediaAsUserMessagesFromModelMessages(
  messages: ModelMessage[]
): ModelMessage[] {
  let didChange = false;
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "tool") {
      result.push(message);
      continue;
    }

    let extractedAttachments: ExtractedToolAttachment[] = [];
    let changedMessage = false;

    if (message.role === "tool") {
      const newContent = message.content.map((part) => {
        if (part.type !== "tool-result") {
          return part;
        }

        const extracted = extractAttachmentsFromToolOutput(part.output as unknown);
        if (extracted == null) {
          return part;
        }

        didChange = true;
        changedMessage = true;
        extractedAttachments = [...extractedAttachments, ...extracted.attachments];

        return {
          ...part,
          output: extracted.newOutput as ToolResultOutput,
        };
      });

      result.push(changedMessage ? { ...message, content: newContent } : message);
      if (extractedAttachments.length > 0) {
        result.push(createSyntheticUserMessage(extractedAttachments));
      }
      continue;
    }

    if (!Array.isArray(message.content)) {
      result.push(message);
      continue;
    }

    const newContent = message.content.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }

      const extracted = extractAttachmentsFromToolOutput(part.output as unknown);
      if (extracted == null) {
        return part;
      }

      didChange = true;
      changedMessage = true;
      extractedAttachments = [...extractedAttachments, ...extracted.attachments];

      return {
        ...part,
        output: extracted.newOutput as ToolResultOutput,
      };
    });

    result.push(changedMessage ? { ...message, content: newContent } : message);
    if (extractedAttachments.length > 0) {
      result.push(createSyntheticUserMessage(extractedAttachments));
    }
  }

  return didChange ? result : messages;
}

function createSyntheticUserMessage(attachments: ExtractedToolAttachment[]): ModelMessage {
  const content: Array<TextPart | ImagePart | FilePart> = [
    {
      type: "text",
      text: createToolAttachmentSummaryText(attachments.length),
    },
  ];

  for (const attachment of attachments) {
    if (attachment.mediaType === SVG_MEDIA_TYPE) {
      try {
        content.push({
          type: "text",
          text: createInlineSvgAttachmentText(attachment),
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to inline SVG attachment.";
        content.push({
          type: "text",
          text: `[SVG attachment omitted from provider request: ${errorMessage}]`,
        });
      }
      continue;
    }

    if (attachment.mediaType.startsWith("image/")) {
      content.push({
        type: "image",
        image: attachment.data,
        mediaType: attachment.mediaType,
      });
      continue;
    }

    content.push({
      type: "file",
      data: attachment.data,
      mediaType: attachment.mediaType,
      ...(attachment.filename
        ? {
            filename: sanitizeAnthropicDocumentFilename(attachment.filename),
          }
        : {}),
    });
  }

  return {
    role: "user",
    content,
  };
}
