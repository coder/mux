import { tool } from "ai";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { STATUS_MESSAGE_MAX_LENGTH } from "@/common/constants/toolLimits";
import type { StatusSetToolResult } from "@/common/types/tools";

/**
 * Validates that a string is a single emoji character
 * Uses Intl.Segmenter to count grapheme clusters (handles variation selectors, skin tones, etc.)
 */
function isValidEmoji(str: string): boolean {
  if (!str) return false;

  // Use Intl.Segmenter to count grapheme clusters (what users perceive as single characters)
  // This properly handles emojis with variation selectors (like ✏️), skin tones, flags, etc.
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const segments = [...segmenter.segment(str)];

  // Must be exactly one grapheme cluster
  if (segments.length !== 1) {
    return false;
  }

  // Check if it's an emoji using Unicode properties
  const emojiRegex = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
  return emojiRegex.test(segments[0].segment);
}

/**
 * Truncates a message to a maximum length, adding an ellipsis if truncated
 */
function truncateMessage(message: string, maxLength: number): string {
  if (message.length <= maxLength) {
    return message;
  }
  // Truncate to maxLength-1 and add ellipsis (total = maxLength)
  return message.slice(0, maxLength - 1) + "…";
}

/**
 * Status set tool factory for AI assistant
 * Creates a tool that allows the AI to set status indicator showing current activity
 *
 * The status is displayed IMMEDIATELY when this tool is called, even before other
 * tool calls complete. This prevents agents from prematurely declaring success
 * (e.g., "PR checks passed") when operations are still pending. Agents should only
 * set success status after confirming the outcome of long-running operations.
 *
 * @param config Required configuration (not used for this tool, but required by interface)
 */
export const createStatusSetTool: ToolFactory = () => {
  return tool({
    description: TOOL_DEFINITIONS.status_set.description,
    inputSchema: TOOL_DEFINITIONS.status_set.schema,
    execute: ({ emoji, message, url }): Promise<StatusSetToolResult> => {
      // Validate emoji
      if (!isValidEmoji(emoji)) {
        return Promise.resolve({
          success: false,
          error: "emoji must be a single emoji character",
        });
      }

      // Truncate message if necessary
      const truncatedMessage = truncateMessage(message, STATUS_MESSAGE_MAX_LENGTH);

      // Tool execution is a no-op on the backend
      // The status is tracked by StreamingMessageAggregator and displayed in the frontend
      return Promise.resolve({
        success: true,
        emoji,
        message: truncatedMessage,
        ...(url && { url }),
      });
    },
  });
};
