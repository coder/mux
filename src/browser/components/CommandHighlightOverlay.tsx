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

interface CommandPrefixTextProps {
  children: React.ReactNode;
  /** Additional className - use to add font-mono when not inheriting from parent */
  className?: string;
}

/**
 * Shared styling for command prefix text (e.g., "/compact" or "/skill-name").
 * Used in both the chat input overlay and sent message display.
 *
 * Font-family is inherited by default. When used outside of VimTextArea
 * (e.g., in UserMessageContent), pass className="font-mono" explicitly.
 */
export const CommandPrefixText: React.FC<CommandPrefixTextProps> = (props) => (
  <span className={`font-medium text-[var(--color-plan-mode-light)] ${props.className ?? ""}`}>
    {props.children}
  </span>
);

interface CommandHighlightOverlayProps {
  /** The current input text value */
  value: string;
  /** Additional className for the container */
  className?: string;
  /** Whether there's a command prefix (controls visibility) */
  hasCommand: boolean;
}

/**
 * Renders a highlight overlay for slash command prefixes.
 *
 * Uses the "transparent textarea text" pattern:
 * - Overlay is positioned BEHIND the textarea
 * - Textarea text is made transparent (via parent) so overlay shows through
 * - Caret remains visible via caret-color on textarea
 *
 * All typography is inherited from the parent wrapper container,
 * eliminating duplication and ensuring perfect alignment.
 */
export const CommandHighlightOverlay: React.FC<CommandHighlightOverlayProps> = (props) => {
  const commandPrefix = extractCommandPrefix(props.value);

  // Don't render if no command or parent says no command
  if (!props.hasCommand || !commandPrefix) {
    return null;
  }

  // Split the value into highlighted prefix and rest
  const rest = props.value.slice(commandPrefix.length);

  return (
    <div
      className={props.className}
      style={{
        // Inherit ALL typography from parent container
        font: "inherit",
        letterSpacing: "inherit",
        // Text handling - match textarea behavior
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
      {/* Rest of text in normal color - textarea is transparent so this shows */}
      <span className="text-light">{rest}</span>
    </div>
  );
};
