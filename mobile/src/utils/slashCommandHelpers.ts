import { buildContinueMessage, type MuxMessageMetadata } from "@/common/types/message";
import type { ParsedCommand, SlashSuggestion } from "@/browser/utils/slashCommands/types";
import type { InferClientInputs } from "@orpc/client";
import type { ORPCClient } from "../orpc/client";
import {
  DEFAULT_COMPACTION_WORD_TARGET,
  WORDS_TO_TOKENS_RATIO,
  buildCompactionPrompt,
} from "@/common/constants/ui";

type SendMessageOptions = NonNullable<
  InferClientInputs<ORPCClient>["workspace"]["sendMessage"]["options"]
>;

export const MOBILE_HIDDEN_COMMANDS = new Set(["telemetry", "vim"]);

export function extractRootCommand(replacement: string): string | null {
  if (typeof replacement !== "string") {
    return null;
  }
  const trimmed = replacement.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [firstToken] = trimmed.slice(1).split(/\s+/);
  return firstToken || null;
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
  metadata: MuxMessageMetadata;
  sendOptions: SendMessageOptions;
}

export function buildMobileCompactionPayload(
  parsed: Extract<ParsedCommand, { type: "compact" }>,
  baseOptions: SendMessageOptions
): MobileCompactionPayload {
  const targetWords = parsed.maxOutputTokens
    ? Math.round(parsed.maxOutputTokens / WORDS_TO_TOKENS_RATIO)
    : DEFAULT_COMPACTION_WORD_TARGET;

  let messageText = buildCompactionPrompt(targetWords);

  if (parsed.continueMessage) {
    messageText += `\n\nThe user wants to continue with: ${parsed.continueMessage}`;
  }

  const metadata: MuxMessageMetadata = {
    type: "compaction-request",
    rawCommand: formatCompactionCommand(parsed),
    parsed: {
      model: parsed.model,
      maxOutputTokens: parsed.maxOutputTokens,
      followUpContent: parsed.continueMessage
        ? {
            text: parsed.continueMessage,
            fileParts: [],
            model: baseOptions.model,
            agentId: baseOptions.agentId ?? "exec",
          }
        : undefined,
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
