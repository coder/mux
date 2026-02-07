/**
 * Message pipeline: transforms MuxMessages into provider-ready ModelMessages.
 *
 * This module extracts the message preparation pipeline from `streamMessage()`,
 * making the sequential transform steps explicit and testable.
 *
 * The pipeline is purely functional — it has no service dependencies (`this.*`).
 * All contextual data is passed via the options object.
 */

import { convertToModelMessages, type ModelMessage } from "ai";
import { applyToolOutputRedaction } from "@/browser/utils/messages/applyToolOutputRedaction";
import { sanitizeToolInputs } from "@/browser/utils/messages/sanitizeToolInput";
import { inlineSvgAsTextForProvider } from "@/node/utils/messages/inlineSvgAsTextForProvider";
import { extractToolMediaAsUserMessages } from "@/node/utils/messages/extractToolMediaAsUserMessages";
import { sanitizeAnthropicPdfFilenames } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import type { MuxMessage } from "@/common/types/message";
import type { EditedFileAttachment } from "@/node/services/agentSession";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { Runtime } from "@/node/runtime/Runtime";
import { injectFileAtMentions } from "./fileAtMentions";
import {
  transformModelMessages,
  validateAnthropicCompliance,
  injectAgentTransition,
  injectFileChangeNotifications,
  injectPostCompactionAttachments,
} from "@/browser/utils/messages/modelMessageTransform";
import { applyCacheControl } from "@/common/utils/ai/cacheStrategy";
import { log } from "./log";

/** Options for the full message preparation pipeline. */
export interface PrepareMessagesOptions {
  /** Pre-filtered messages (with interrupted-sentinel already added). */
  messagesWithSentinel: MuxMessage[];
  /** Active agent ID for transition injection. */
  effectiveAgentId: string;
  /** Tool names for mode-transition sentinel detection. */
  toolNamesForSentinel: string[];
  /** Plan content for plan→exec handoff injection. */
  planContentForTransition?: string;
  /** Plan file path for transition context. */
  planFilePath?: string;
  /** File-change attachments for notification injection. */
  changedFileAttachments?: EditedFileAttachment[];
  /** Post-compaction attachments (plan file, edited files). */
  postCompactionAttachments?: PostCompactionAttachment[] | null;
  /** Runtime for file I/O (used by @file mention injection). */
  runtime: Runtime;
  /** Workspace path for file resolution. */
  workspacePath: string;
  /** Abort signal for async operations. */
  abortSignal: AbortSignal;
  /** Canonical provider name for provider-specific transforms. */
  providerForMessages: string;
  /** Thinking level for provider-specific behavior. */
  effectiveThinkingLevel: ThinkingLevel;
  /** Full model string (used for cache control). */
  modelString: string;
  /** Canonical model ID (used for noPrefill detection). */
  canonicalModelId?: string;
  /** Workspace ID (used only for debug logging). */
  workspaceId: string;
}

/**
 * Run the full message preparation pipeline.
 *
 * Transforms pre-filtered `MuxMessage[]` into provider-ready `ModelMessage[]` by:
 * 1. Injecting agent-transition context (plan→exec handoff)
 * 2. Injecting file-change notifications
 * 3. Injecting post-compaction attachments
 * 4. Expanding @file mentions into synthetic user messages
 * 5. Redacting heavy tool outputs
 * 6. Sanitizing tool inputs
 * 7. Inlining SVG attachments as text
 * 8. Sanitizing PDF filenames for Anthropic
 * 9. Extracting tool-result media as user message attachments
 * 10. Converting to Vercel AI SDK ModelMessage format
 * 11. Self-healing: filtering empty/whitespace assistant messages
 * 12. Applying provider-specific message transforms
 * 13. Applying cache control headers
 * 14. Validating Anthropic compliance (logs warnings only)
 */
export async function prepareMessagesForProvider(
  opts: PrepareMessagesOptions
): Promise<ModelMessage[]> {
  const {
    messagesWithSentinel,
    effectiveAgentId,
    toolNamesForSentinel,
    planContentForTransition,
    planFilePath,
    changedFileAttachments,
    postCompactionAttachments,
    runtime,
    workspacePath,
    abortSignal,
    providerForMessages,
    effectiveThinkingLevel,
    modelString,
    canonicalModelId,
    workspaceId,
  } = opts;

  // --- MuxMessage-level transforms ---

  // Inject agent transition context with plan content (for plan→exec handoff)
  const messagesWithAgentContext = injectAgentTransition(
    messagesWithSentinel,
    effectiveAgentId,
    toolNamesForSentinel,
    planContentForTransition,
    planContentForTransition ? planFilePath : undefined
  );

  // Inject file change notifications as user messages (preserves system message cache)
  const messagesWithFileChanges = injectFileChangeNotifications(
    messagesWithAgentContext,
    changedFileAttachments
  );

  // Inject post-compaction attachments (plan file, edited files) after compaction summary
  const messagesWithPostCompaction = injectPostCompactionAttachments(
    messagesWithFileChanges,
    postCompactionAttachments
  );

  // Expand @file mentions (e.g. @src/foo.ts#L1-20) into in-memory synthetic user messages.
  // Keeps chat history clean while giving the model immediate file context.
  const messagesWithFileAtMentions = await injectFileAtMentions(messagesWithPostCompaction, {
    runtime,
    workspacePath,
    abortSignal,
  });

  // Apply centralized tool-output redaction BEFORE converting to provider ModelMessages.
  // Keeps the persisted/UI history intact while trimming heavy fields for the request.
  const redactedForProvider = applyToolOutputRedaction(messagesWithFileAtMentions);
  log.debug_obj(`${workspaceId}/2a_redacted_messages.json`, redactedForProvider);

  // Sanitize tool inputs to ensure they are valid objects (not strings or arrays).
  // Fixes cases where corrupted data in history has malformed tool inputs
  // that would cause API errors like "Input should be a valid dictionary".
  const sanitizedMessages = sanitizeToolInputs(redactedForProvider);
  log.debug_obj(`${workspaceId}/2b_sanitized_messages.json`, sanitizedMessages);

  // Inline SVG user attachments as text (providers generally don't accept image/svg+xml).
  // Request-only — does not mutate persisted history.
  const messagesWithInlinedSvg = inlineSvgAsTextForProvider(sanitizedMessages);

  // Sanitize PDF filenames for Anthropic (request-only, preserves original in UI/history).
  // Anthropic rejects document names containing periods, underscores, etc.
  const messagesWithSanitizedPdf =
    providerForMessages === "anthropic"
      ? sanitizeAnthropicPdfFilenames(messagesWithInlinedSvg)
      : messagesWithInlinedSvg;

  // Rewrite MCP tool-result images (base64) to small text placeholders + file parts.
  // Prevents providers from treating large base64 payloads as text/JSON context.
  const messagesWithToolMediaExtracted = extractToolMediaAsUserMessages(messagesWithSanitizedPdf);

  // --- Convert to ModelMessage format ---

  // Type assertion needed because MuxMessage has custom tool parts for interrupted tools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  const rawModelMessages = await convertToModelMessages(messagesWithToolMediaExtracted as any, {
    // Drop unfinished tool calls (input-streaming/input-available) so downstream
    // transforms only see tool calls that actually produced outputs.
    ignoreIncompleteToolCalls: true,
  });

  // --- ModelMessage-level transforms ---

  const modelMessages = sanitizeAssistantModelMessages(rawModelMessages, workspaceId);

  log.debug_obj(`${workspaceId}/2_model_messages.json`, modelMessages);

  // Apply ModelMessage transforms based on provider requirements
  const transformedMessages = transformModelMessages(modelMessages, providerForMessages, {
    anthropicThinkingEnabled:
      providerForMessages === "anthropic" && effectiveThinkingLevel !== "off",
    // Opus 4.6 doesn't support assistant message prefill (returns 400 error).
    // Append a [CONTINUE] user sentinel if conversation ends with assistant.
    noPrefill: canonicalModelId?.includes("opus-4-6") ?? false,
  });

  // Apply cache control for Anthropic models AFTER transformation
  const finalMessages = applyCacheControl(transformedMessages, modelString);

  log.debug_obj(`${workspaceId}/3_final_messages.json`, finalMessages);

  // Validate the messages meet Anthropic requirements (Anthropic only)
  if (providerForMessages === "anthropic") {
    const validation = validateAnthropicCompliance(finalMessages);
    if (!validation.valid) {
      log.error(`Anthropic compliance validation failed: ${validation.error ?? "unknown error"}`);
      // Continue anyway, as the API might be more lenient
    }
  }

  return finalMessages;
}

/**
 * Self-healing: filter empty or whitespace-only assistant model messages.
 *
 * The SDK's `ignoreIncompleteToolCalls` can drop all parts from a message,
 * leaving an assistant with an empty content array. The API rejects these with
 * "all messages must have non-empty content except for the optional final
 * assistant message".
 *
 * Anthropic also rejects text content blocks that contain only whitespace
 * (e.g. "\n\n"). This can happen after an interrupted stream where we
 * persisted a whitespace-only text delta (often the first text after thinking).
 *
 * Kept provider-agnostic and request-only (does not mutate persisted history).
 */
export function sanitizeAssistantModelMessages(
  messages: ModelMessage[],
  workspaceId?: string
): ModelMessage[] {
  const result = messages.flatMap<ModelMessage>((msg): ModelMessage[] => {
    if (msg.role !== "assistant") {
      return [msg];
    }

    if (typeof msg.content === "string") {
      return msg.content.trim().length > 0 ? [msg] : [];
    }

    if (!Array.isArray(msg.content)) {
      return [];
    }

    const filteredContent = msg.content.filter(
      (part) => part.type !== "text" || part.text.trim().length > 0
    );

    if (filteredContent.length === 0) {
      return [];
    }

    // Avoid mutating the original message (which can be reused in debug logging).
    if (filteredContent.length === msg.content.length) {
      return [msg];
    }

    return [{ ...msg, content: filteredContent }];
  });

  if (result.length < messages.length) {
    log.debug(
      `Self-healing: Filtered ${messages.length - result.length} empty ModelMessage(s)${workspaceId ? ` [${workspaceId}]` : ""}`
    );
  }

  return result;
}
