import type { FilePart, ImagePart, ModelMessage, TextPart, ToolResultPart } from "ai";
import { sanitizeAnthropicDocumentFilename } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import {
  createToolAttachmentSummaryText,
  extractAttachmentsFromToolOutput,
  prepareExtractedToolAttachmentForProvider,
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
export async function extractToolMediaAsUserMessagesFromModelMessages(
  messages: ModelMessage[]
): Promise<ModelMessage[]> {
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
        result.push(await createSyntheticUserMessage(extractedAttachments));
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
      result.push(await createSyntheticUserMessage(extractedAttachments));
    }
  }

  return didChange ? result : messages;
}

async function createSyntheticUserMessage(
  attachments: ExtractedToolAttachment[]
): Promise<ModelMessage> {
  const content: Array<TextPart | ImagePart | FilePart> = [
    {
      type: "text",
      text: createToolAttachmentSummaryText(attachments.length),
    },
  ];

  for (const attachment of attachments) {
    const providerReadyAttachment = await prepareExtractedToolAttachmentForProvider(attachment);
    if (providerReadyAttachment.type === "text") {
      content.push({
        type: "text",
        text: providerReadyAttachment.text,
      });
      continue;
    }

    const preparedAttachment = providerReadyAttachment.attachment;
    if (preparedAttachment.mediaType.startsWith("image/")) {
      content.push({
        type: "image",
        image: preparedAttachment.data,
        mediaType: preparedAttachment.mediaType,
      });
      continue;
    }

    content.push({
      type: "file",
      data: preparedAttachment.data,
      mediaType: preparedAttachment.mediaType,
      ...(preparedAttachment.filename
        ? {
            filename: sanitizeAnthropicDocumentFilename(preparedAttachment.filename),
          }
        : {}),
    });
  }

  return {
    role: "user",
    content,
  };
}
