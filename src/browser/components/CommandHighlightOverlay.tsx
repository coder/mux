import React from "react";

/**
 * Extract the command prefix from input text for highlighting.
 * Returns the prefix if the input starts with a valid slash command pattern,
 * otherwise returns null.
 *
 * The command prefix is the first line (everything before the first newline),
 * since slash commands use the first line for the command and subsequent lines
 * for the message body.
 *
 * Examples:
 * - "/compact" → "/compact"
 * - "/compact -t 5000" → "/compact -t 5000"
 * - "/compact\nContinue working" → "/compact"
 * - "/model sonnet" → "/model sonnet"
 * - "regular message" → null
 */
export function extractCommandPrefix(input: string): string | null {
  // Must start with slash (no leading whitespace allowed for commands)
  if (!input.startsWith("/")) {
    return null;
  }

  // Find where the command part ends (first newline)
  const firstLineEnd = input.indexOf("\n");
  const commandLine = firstLineEnd >= 0 ? input.slice(0, firstLineEnd) : input;

  // If the command line is just the slash, don't highlight yet
  if (commandLine.length <= 1) {
    return null;
  }

  return commandLine;
}

/**
 * Shared styling for command prefix text (e.g., "/compact" or "/skill-name").
 * Used in both the chat input overlay and sent message display.
 */
export const CommandPrefixText: React.FC<{ children: React.ReactNode }> = (props) => (
  <span className="font-mono text-[13px] font-medium text-[var(--color-plan-mode-light)]">
    {props.children}
  </span>
);

interface CommandHighlightOverlayProps {
  /** The current input text value */
  value: string;
  /** Whether vim mode is enabled (affects font) */
  vimEnabled?: boolean;
  /** Additional className for the container */
  className?: string;
}

/**
 * Renders a highlight overlay for slash command prefixes.
 * This component should be positioned absolutely ABOVE the textarea,
 * showing the highlighted command text while keeping the rest transparent
 * so the original textarea text shows through.
 *
 * The overlay mirrors the textarea's text layout exactly.
 */
export const CommandHighlightOverlay: React.FC<CommandHighlightOverlayProps> = (props) => {
  const commandPrefix = extractCommandPrefix(props.value);

  if (!commandPrefix) {
    return null;
  }

  // Split the value into highlighted prefix and rest
  const rest = props.value.slice(commandPrefix.length);

  return (
    <div
      className={props.className}
      style={{
        // Match textarea exactly - these match VimTextArea's styling
        padding: "6px 8px", // py-1.5 px-2
        fontSize: "13px",
        lineHeight: "1.5",
        whiteSpace: "pre-wrap",
        wordWrap: "break-word",
        overflowWrap: "break-word",
        // Prevent any interaction - clicks pass through to textarea
        pointerEvents: "none",
        userSelect: "none",
      }}
      aria-hidden="true"
    >
      {/* Command prefix in highlight color */}
      <CommandPrefixText>{commandPrefix}</CommandPrefixText>
      {/* Rest of text is transparent so textarea text shows through */}
      <span style={{ color: "transparent" }}>{rest}</span>
    </div>
  );
};
