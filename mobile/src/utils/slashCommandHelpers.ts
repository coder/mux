import type { MuxFrontendMetadata } from "@/common/types/message";
import type { ParsedCommand, SlashSuggestion } from "@/browser/utils/slashCommands/types";
import type { SendMessageOptions } from "../api/client";

export const MOBILE_HIDDEN_COMMANDS = new Set(["telemetry", "vim"]);
const WORDS_PER_TOKEN = 1.3;
const DEFAULT_WORD_TARGET = 2000;

export function extractRootCommand(replacement: string): string | null {
  if (typeof replacement !== "string") {
    return null;
  }
  const trimmed = replacement.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [firstToken] = trimmed.slice(1).split(/\s+/);
  return firstToken ?? null;
}

export function filterSuggestionsForMobile(
  suggestions: SlashSuggestion[],
  hiddenCommands: ReadonlySet<string> = MOBILE_HIDDEN_COMMANDS
): SlashSuggestion[] {
  return suggestions.filter((suggestion) => {
    const root = extractRootCommand(suggestion.replacement);
    return !root || !hiddenCommands.has(root);
  });
}

export interface MobileCompactionPayload {
  messageText: string;
  metadata: MuxFrontendMetadata;
  sendOptions: SendMessageOptions;
}

export function buildMobileCompactionPayload(
  parsed: Extract<ParsedCommand, { type: "compact" }>,
  baseOptions: SendMessageOptions
): MobileCompactionPayload {
  const targetWords = parsed.maxOutputTokens
    ? Math.round(parsed.maxOutputTokens / WORDS_PER_TOKEN)
    : DEFAULT_WORD_TARGET;

  let messageText =
    `Summarize this conversation into a compact form for a new Assistant to continue helping the user. ` +
    `Use approximately ${targetWords} words.`;

  if (parsed.continueMessage) {
    messageText += `\n\nThe user wants to continue with: ${parsed.continueMessage}`;
  }

  const metadata: MuxFrontendMetadata = {
    type: "compaction-request",
    rawCommand: formatCompactionCommand(parsed),
    parsed: {
      model: parsed.model,
      maxOutputTokens: parsed.maxOutputTokens,
      continueMessage: parsed.continueMessage,
    },
  };

  const sendOptions: SendMessageOptions = {
    ...baseOptions,
    model: parsed.model ?? baseOptions.model,
    maxOutputTokens: parsed.maxOutputTokens,
    mode: "compact",
    toolPolicy: [],
  };

  return { messageText, metadata, sendOptions };
}

function formatCompactionCommand(parsed: Extract<ParsedCommand, { type: "compact" }>): string {
  let cmd = "/compact";
  if (parsed.maxOutputTokens) {
    cmd += ` -t ${parsed.maxOutputTokens}`;
  }
  if (parsed.model) {
    cmd += ` -m ${parsed.model}`;
  }
  if (parsed.continueMessage) {
    cmd += `\n${parsed.continueMessage}`;
  }
  return cmd;
}
