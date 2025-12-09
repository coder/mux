/**
 * Transform ModelMessages to ensure Anthropic API compliance.
 * This operates on already-converted ModelMessages from Vercel AI SDK.
 */

import type { ModelMessage, AssistantModelMessage, ToolModelMessage } from "ai";
import type { MuxMessage } from "@/common/types/message";
import type { EditedFileAttachment } from "@/node/services/agentSession";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import { renderAttachmentsToContent } from "./attachmentRenderer";

/**
 * Filter out assistant messages that are empty or only contain reasoning parts.
 * Empty messages (no parts or only empty text) and reasoning-only messages are
 * invalid for the API and provide no value to the model.
 *
 * Common scenarios:
 * 1. Placeholder messages with empty parts arrays (stream interrupted before any content)
 * 2. Messages interrupted during thinking phase before producing text
 *
 * EXCEPTION: When extended thinking is enabled, preserve reasoning-only messages.
 * The Extended Thinking API requires thinking blocks to be present in message history,
 * even if they were interrupted before producing text content.
 *
 * Note: This function filters out reasoning-only messages but does NOT strip reasoning
 * parts from messages that have other content. Reasoning parts are handled differently
 * per provider (see stripReasoningForOpenAI).
 *
 * @param messages - The messages to filter
 * @param preserveReasoningOnly - If true, keep reasoning-only messages (for Extended Thinking)
 */
export function filterEmptyAssistantMessages(
  messages: MuxMessage[],
  preserveReasoningOnly = false
): MuxMessage[] {
  return messages.filter((msg) => {
    // Keep all non-assistant messages
    if (msg.role !== "assistant") {
      return true;
    }

    // Filter out messages with no parts at all (placeholder messages)
    if (msg.parts?.length === 0) {
      return false;
    }

    // Keep assistant messages that have at least one text or tool part
    const hasContent = msg.parts.some(
      (part) => (part.type === "text" && part.text) || part.type === "dynamic-tool"
    );

    if (hasContent) {
      return true;
    }

    // If preserveReasoningOnly is enabled, keep messages with reasoning parts
    // (needed for Extended Thinking API compliance)
    if (preserveReasoningOnly) {
      const hasReasoning = msg.parts.some((part) => part.type === "reasoning");
      return hasReasoning;
    }

    return false;
  });
}

/**
 * Add [CONTINUE] sentinel to partial messages by inserting a user message.
 * This helps the model understand that a message was interrupted and to continue.
 * The sentinel is ONLY for model context, not shown in UI.
 *
 * OPTIMIZATION: If a user message already follows the partial assistant message,
 * we skip the sentinel - the user message itself provides the continuation signal.
 * This saves tokens and creates more natural conversation flow.
 *
 * We insert a separate user message instead of modifying the assistant message
 * because if the assistant message only has reasoning (no text), it will be
 * filtered out, and we'd lose the interruption context. A user message always
 * survives filtering.
 */
export function addInterruptedSentinel(messages: MuxMessage[]): MuxMessage[] {
  const result: MuxMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    result.push(msg);

    // If this is a partial assistant message, conditionally insert [CONTINUE] sentinel
    if (msg.role === "assistant" && msg.metadata?.partial) {
      const nextMsg = messages[i + 1];

      // Only add sentinel if there's NO user message following
      // If user message follows, it provides the continuation context itself
      if (!nextMsg || nextMsg.role !== "user") {
        result.push({
          id: `interrupted-${msg.id}`,
          role: "user",
          parts: [{ type: "text", text: "[CONTINUE]" }],
          metadata: {
            timestamp: msg.metadata.timestamp,
            // Mark as synthetic so it can be identified if needed
            synthetic: true,
          },
        });
      }
    }
  }

  return result;
}

/**
 * Inject mode transition context when mode changes mid-conversation.
 * Inserts a synthetic user message before the final user message to signal the mode switch.
 * This provides temporal context that helps models understand they should follow new mode instructions.
 *
 * When transitioning from plan → exec mode with plan content, includes the plan so the model
 * can evaluate its relevance to the current request.
 *
 * @param messages The conversation history
 * @param currentMode The mode for the upcoming assistant response (e.g., "plan", "exec")
 * @param toolNames Optional list of available tool names to include in transition message
 * @param planContent Optional plan content to include when transitioning plan → exec
 * @returns Messages with mode transition context injected if needed
 */
export function injectModeTransition(
  messages: MuxMessage[],
  currentMode?: string,
  toolNames?: string[],
  planContent?: string
): MuxMessage[] {
  // No mode specified, nothing to do
  if (!currentMode) {
    return messages;
  }

  // Need at least one message to have a conversation
  if (messages.length === 0) {
    return messages;
  }

  // Find the last assistant message to check its mode
  const lastAssistantMessage = [...messages].reverse().find((m) => m.role === "assistant");
  const lastMode = lastAssistantMessage?.metadata?.mode;

  // No mode transition if no previous mode or same mode
  if (!lastMode || lastMode === currentMode) {
    return messages;
  }

  // Mode transition detected! Inject a synthetic user message before the last user message
  // This provides temporal context: user says "switch modes" before their actual request

  // Find the index of the last user message
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  // If there's no user message, can't inject transition (nothing to inject before)
  if (lastUserIndex === -1) {
    return messages;
  }

  const result: MuxMessage[] = [];

  // Add all messages up to (but not including) the last user message
  for (let i = 0; i < lastUserIndex; i++) {
    result.push(messages[i]);
  }

  // Inject mode transition message right before the last user message
  let transitionText = `[Mode switched from ${lastMode} to ${currentMode}. Follow ${currentMode} mode instructions.`;

  // Append tool availability if provided
  if (toolNames && toolNames.length > 0) {
    transitionText += ` Available tools: ${toolNames.join(", ")}.]`;
  } else {
    transitionText += "]";
  }

  // When transitioning plan → exec with plan content, include the plan for context
  if (lastMode === "plan" && currentMode === "exec" && planContent) {
    transitionText += `

The following plan was developed in plan mode. Based on the user's message, determine if they have accepted the plan. If accepted and relevant, use it to guide your implementation:

<plan>
${planContent}
</plan>`;
  }

  const transitionMessage: MuxMessage = {
    id: `mode-transition-${Date.now()}`,
    role: "user",
    parts: [
      {
        type: "text",
        text: transitionText,
      },
    ],
    metadata: {
      timestamp: Date.now(),
      synthetic: true,
    },
  };
  result.push(transitionMessage);

  // Add the last user message and any remaining messages
  for (let i = lastUserIndex; i < messages.length; i++) {
    result.push(messages[i]);
  }

  return result;
}

/**
 * Inject file change notifications as a synthetic user message.
 * When files are modified externally (by user or linter), append a notification at the end
 * so the model is aware of changes without busting the system message cache.
 *
 * @param messages The conversation history
 * @param changedFileAttachments Files that were modified externally
 * @returns Messages with file change notification appended if any files changed
 */
export function injectFileChangeNotifications(
  messages: MuxMessage[],
  changedFileAttachments?: EditedFileAttachment[]
): MuxMessage[] {
  if (!changedFileAttachments || changedFileAttachments.length === 0) {
    return messages;
  }

  const notice = changedFileAttachments
    .map(
      (att) =>
        `Note: ${att.filename} was modified, either by the user or by a linter.\n` +
        `This change was intentional, so make sure to take it into account as you proceed ` +
        `(i.e., don't revert it unless the user asks you to). Here are the relevant changes:\n${att.snippet}`
    )
    .join("\n\n");

  const syntheticMessage: MuxMessage = {
    id: `file-change-${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text: `<system-file-update>\n${notice}\n</system-file-update>` }],
    metadata: {
      timestamp: Date.now(),
      synthetic: true,
    },
  };

  return [...messages, syntheticMessage];
}

/**
 * Inject post-compaction attachments as a synthetic user message.
 * When compaction occurs, this injects a message containing plan file content
 * and/or edited files to preserve context that would otherwise be lost.
 *
 * The message is inserted AFTER the compaction summary message to ensure
 * the model receives this context for the next turn.
 *
 * @param messages The conversation history
 * @param attachments Post-compaction attachments (plan file, edited files)
 * @returns Messages with attachments injected after compaction summary
 */
export function injectPostCompactionAttachments(
  messages: MuxMessage[],
  attachments?: PostCompactionAttachment[] | null
): MuxMessage[] {
  if (!attachments || attachments.length === 0) {
    return messages;
  }

  // Find the compaction summary message (marked with metadata.compacted)
  const compactionIndex = messages.findIndex((msg) => msg.metadata?.compacted);

  if (compactionIndex === -1) {
    // No compaction message found - this shouldn't happen if attachments are provided,
    // but append at end as a fallback
    const syntheticMessage: MuxMessage = {
      id: `post-compaction-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: renderAttachmentsToContent(attachments) }],
      metadata: {
        timestamp: Date.now(),
        synthetic: true,
      },
    };
    return [...messages, syntheticMessage];
  }

  // Insert the synthetic message immediately after the compaction summary
  const syntheticMessage: MuxMessage = {
    id: `post-compaction-${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text: renderAttachmentsToContent(attachments) }],
    metadata: {
      timestamp: messages[compactionIndex].metadata?.timestamp ?? Date.now(),
      synthetic: true,
    },
  };

  const result = [...messages];
  result.splice(compactionIndex + 1, 0, syntheticMessage);
  return result;
}

/**
 * Filter out assistant messages that only contain reasoning parts (no text or tool parts).
 * Anthropic API rejects messages that have reasoning but no actual content.
 * This happens when a message is interrupted during thinking before producing any text.
 */
/**
 * Split assistant messages with mixed text and tool calls into separate messages
 * to comply with Anthropic's requirement that tool_use blocks must be immediately
 * followed by their tool_result blocks without intervening text.
 */
function splitMixedContentMessages(messages: ModelMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== "assistant") {
      result.push(msg);
      continue;
    }

    const assistantMsg = msg;

    if (typeof assistantMsg.content === "string") {
      result.push(msg);
      continue;
    }

    const toolCallParts = assistantMsg.content.filter((c) => c.type === "tool-call");

    if (toolCallParts.length === 0) {
      result.push(msg);
      continue;
    }

    const nextMsg = messages[i + 1];
    const hasToolResults = nextMsg?.role === "tool";

    if (!hasToolResults) {
      result.push(msg);
      continue;
    }

    const toolMsg = nextMsg;

    type ContentArray = Exclude<typeof assistantMsg.content, string>;
    const groups: Array<{ type: "text" | "tool-call"; parts: ContentArray }> = [];
    let currentGroup: { type: "text" | "tool-call"; parts: ContentArray } | null = null;

    for (const part of assistantMsg.content) {
      const partType = part.type === "tool-call" ? "tool-call" : "text";

      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
      if (!currentGroup || currentGroup.type !== partType) {
        if (currentGroup) groups.push(currentGroup);
        currentGroup = { type: partType, parts: [] };
      }

      currentGroup.parts.push(part);
    }

    if (currentGroup) {
      groups.push(currentGroup);
    }

    if (groups.length <= 1) {
      result.push(msg);
      continue;
    }

    const toolResultsById = new Map<string, Array<ToolModelMessage["content"][number]>>();
    for (const content of toolMsg.content) {
      if (content.type === "tool-result") {
        const existing = toolResultsById.get(content.toolCallId);
        if (existing) {
          existing.push(content);
        } else {
          toolResultsById.set(content.toolCallId, [content]);
        }
      }
    }

    for (const group of groups) {
      if (group.parts.length === 0) {
        continue;
      }

      if (group.type === "tool-call") {
        const partsToInclude = group.parts.filter(
          (p) => p.type === "tool-call" && toolResultsById.has(p.toolCallId)
        );

        if (partsToInclude.length === 0) {
          continue;
        }

        const newAssistantMsg: AssistantModelMessage = {
          role: "assistant",
          content: partsToInclude,
        };
        result.push(newAssistantMsg);

        const relevantResults: ToolModelMessage["content"] = [];
        for (const part of partsToInclude) {
          if (part.type !== "tool-call") {
            continue;
          }
          const results = toolResultsById.get(part.toolCallId);
          if (results) {
            relevantResults.push(...results);
            toolResultsById.delete(part.toolCallId);
          }
        }

        if (relevantResults.length > 0) {
          const newToolMsg: ToolModelMessage = {
            role: "tool",
            content: relevantResults,
          };
          result.push(newToolMsg);
        }
      } else {
        const newAssistantMsg: AssistantModelMessage = {
          role: "assistant",
          content: group.parts,
        };
        result.push(newAssistantMsg);
      }
    }

    i++;
  }

  return result;
}
function filterReasoningOnlyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((msg) => {
    if (msg.role !== "assistant") {
      return true;
    }

    // Check if content is string or array
    if (typeof msg.content === "string") {
      return msg.content.trim().length > 0;
    }

    // For array content, check if there's at least one non-reasoning part
    const hasNonReasoningContent = msg.content.some((part) => part.type !== "reasoning");

    return hasNonReasoningContent;
  });
}

/**
 * Coalesce consecutive parts of the same type within each message.
 * Streaming creates many individual text/reasoning parts; merge them for easier debugging.
 * Also reduces JSON overhead when sending messages to the API.
 * Tool calls remain atomic (not merged).
 */
function coalesceConsecutiveParts(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    // Only process assistant messages with array content
    if (msg.role !== "assistant") {
      return msg;
    }

    const assistantMsg = msg;

    // Skip string content
    if (typeof assistantMsg.content === "string") {
      return msg;
    }

    // Now TypeScript knows content is an array
    type ContentArray = Exclude<typeof assistantMsg.content, string>;
    const coalesced: ContentArray = [];

    for (const part of assistantMsg.content) {
      const lastPart = coalesced[coalesced.length - 1];

      // Merge consecutive text parts
      if (part.type === "text" && lastPart?.type === "text") {
        lastPart.text += part.text;
        continue;
      }

      // Merge consecutive reasoning parts (extended thinking)
      if (part.type === "reasoning" && lastPart?.type === "reasoning") {
        lastPart.text += part.text;
        continue;
      }

      // Keep tool calls and first occurrence of each type
      coalesced.push(part);
    }

    return {
      ...assistantMsg,
      content: coalesced,
    };
  });
}

/**
 * Merge consecutive user messages with newline separators.
 * When filtering removes assistant messages, we can end up with consecutive user messages.
 * Anthropic requires alternating user/assistant, so we merge them.
 */
function mergeConsecutiveUserMessages(messages: ModelMessage[]): ModelMessage[] {
  const merged: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user" && merged.length > 0 && merged[merged.length - 1].role === "user") {
      // Consecutive user message - merge with previous
      const prevMsg = merged[merged.length - 1];

      // Get text content from both messages
      const prevText = Array.isArray(prevMsg.content)
        ? (prevMsg.content.find((c) => c.type === "text")?.text ?? "")
        : prevMsg.content;

      const currentText = Array.isArray(msg.content)
        ? (msg.content.find((c) => c.type === "text")?.text ?? "")
        : typeof msg.content === "string"
          ? msg.content
          : "";

      // Merge with newline prefix
      const mergedText = prevText + "\n" + currentText;

      // Collect file/image parts from both messages
      const prevImageParts = Array.isArray(prevMsg.content)
        ? prevMsg.content.filter((c) => c.type === "file")
        : [];
      const currentImageParts = Array.isArray(msg.content)
        ? msg.content.filter((c) => c.type === "file")
        : [];

      // Update the previous message with merged text and all image parts
      merged[merged.length - 1] = {
        role: "user",
        content: [
          { type: "text" as const, text: mergedText },
          ...prevImageParts,
          ...currentImageParts,
        ],
      };
    } else {
      // Not consecutive user message, add as-is
      merged.push(msg);
    }
  }

  return merged;
}

/**
 * Transform messages to ensure provider API compliance.
 * Applies multiple transformation passes based on provider requirements:
 * 0. Coalesce consecutive parts (text/reasoning) - all providers, reduces JSON overhead
 * 1. Split mixed content messages (text + tool calls) - all providers
 * 2. Filter reasoning-only messages:
 *    - OpenAI: Keep reasoning parts (managed via previousResponseId), filter reasoning-only messages
 *    - Anthropic: Filter out reasoning-only messages (API rejects them)
 * 3. Merge consecutive user messages - all providers
 *
 * Note: encryptedContent stripping happens earlier in streamManager when tool results
 * are first stored, not during message transformation.
 *
 * @param messages The messages to transform
 * @param provider The provider name (e.g., "anthropic", "openai")
 */
export function transformModelMessages(messages: ModelMessage[], provider: string): ModelMessage[] {
  // Pass 0: Coalesce consecutive parts to reduce JSON overhead from streaming (applies to all providers)
  const coalesced = coalesceConsecutiveParts(messages);

  // Pass 1: Split mixed content messages (applies to all providers)
  const split = splitMixedContentMessages(coalesced);

  // Pass 2: Provider-specific reasoning handling
  let reasoningHandled: ModelMessage[];
  if (provider === "openai") {
    // OpenAI: Keep reasoning parts - managed via previousResponseId
    // Only filter out reasoning-only messages (messages with no text/tool-call content)
    reasoningHandled = filterReasoningOnlyMessages(split);
  } else if (provider === "anthropic") {
    // Anthropic: Filter out reasoning-only messages (API rejects messages with only reasoning)
    reasoningHandled = filterReasoningOnlyMessages(split);
  } else {
    // Unknown provider: no reasoning handling
    reasoningHandled = split;
  }

  // Pass 3: Merge consecutive user messages (applies to all providers)
  const merged = mergeConsecutiveUserMessages(reasoningHandled);

  return merged;
}

/**
 * Validate that the transformed messages follow Anthropic's requirements:
 * - Every tool-call must be immediately followed by its tool-result message
 */
export function validateAnthropicCompliance(messages: ModelMessage[]): {
  valid: boolean;
  error?: string;
} {
  const pendingToolCalls = new Map<string, number>(); // toolCallId -> message index

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      const assistantMsg = msg;

      // Skip if content is just a string
      if (typeof assistantMsg.content === "string") {
        continue;
      }

      // Track any tool calls in this message
      for (const content of assistantMsg.content) {
        if (content.type === "tool-call") {
          pendingToolCalls.set(content.toolCallId, i);
        }
      }

      // If we have pending tool calls and encounter text or more tool calls,
      // check if the next message has the results
      if (pendingToolCalls.size > 0) {
        const nextMsg = messages[i + 1];

        // The next message MUST be a tool result message if we have pending calls
        if (nextMsg?.role !== "tool") {
          const pendingIds = Array.from(pendingToolCalls.keys()).join(", ");
          return {
            valid: false,
            error: `Message ${i}: tool_use blocks found without tool_result blocks immediately after: ${pendingIds}`,
          };
        }
      }
    } else if (msg.role === "tool") {
      const toolMsg = msg;

      // Process tool results and clear pending calls
      for (const content of toolMsg.content) {
        if (content.type === "tool-result") {
          const toolCallId = content.toolCallId;

          // Check if this result corresponds to a pending call
          if (!pendingToolCalls.has(toolCallId)) {
            return {
              valid: false,
              error: `Message ${i}: tool_result for ${toolCallId} has no corresponding tool_use`,
            };
          }

          // Check if the tool call was in the immediately previous assistant message
          const callIndex = pendingToolCalls.get(toolCallId);
          if (callIndex !== i - 1) {
            return {
              valid: false,
              error: `Message ${i}: tool_result for ${toolCallId} is not immediately after its tool_use (was in message ${callIndex ?? "unknown"})`,
            };
          }

          pendingToolCalls.delete(toolCallId);
        }
      }
    }
  }

  // Check for any remaining pending tool calls
  if (pendingToolCalls.size > 0) {
    const pendingIds = Array.from(pendingToolCalls.keys()).join(", ");
    return {
      valid: false,
      error: `Unresolved tool_use blocks without corresponding tool_result: ${pendingIds}`,
    };
  }

  return { valid: true };
}
