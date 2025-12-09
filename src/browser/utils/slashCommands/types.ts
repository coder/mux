/**
 * Shared types for slash command system
 *
 * NOTE: `/<command>-help` types are an anti-pattern. Commands should prefer opening
 * a modal when misused or called with no arguments, rather than showing help toasts.
 * This provides a better UX by guiding users through the UI instead of showing text.
 *
 * Existing `-help` types are kept for backward compatibility but should not be added
 * for new commands.
 */

export type ParsedCommand =
  | { type: "providers-set"; provider: string; keyPath: string[]; value: string }
  | { type: "providers-help" }
  | { type: "providers-invalid-subcommand"; subcommand: string }
  | { type: "providers-missing-args"; subcommand: string; argCount: number }
  | { type: "model-set"; modelString: string }
  | { type: "model-help" }
  | { type: "clear" }
  | { type: "truncate"; percentage: number }
  | { type: "compact"; maxOutputTokens?: number; continueMessage?: string; model?: string }
  | { type: "fork"; newName: string; startMessage?: string }
  | { type: "fork-help" }
  | {
      type: "new";
      workspaceName?: string;
      trunkBranch?: string;
      runtime?: string;
      startMessage?: string;
    }
  | { type: "vim-toggle" }
  | { type: "mcp-add"; name: string; command: string }
  | { type: "mcp-edit"; name: string; command: string }
  | { type: "mcp-remove"; name: string }
  | { type: "mcp-open" }
  | { type: "plan-show" }
  | { type: "plan-open" }
  | { type: "unknown-command"; command: string; subcommand?: string }
  | null;

export interface SuggestionsHandlerArgs {
  stage: number;
  partialToken: string;
  definitionPath: readonly SlashCommandDefinition[];
  completedTokens: string[];
  context: SlashSuggestionContext;
}

export type SuggestionsHandler = (args: SuggestionsHandlerArgs) => SlashSuggestion[] | null;

export interface SlashCommandDefinition {
  key: string;
  description: string;
  appendSpace?: boolean;
  handler?: SlashCommandHandler;
  children?: readonly SlashCommandDefinition[];
  suggestions?: SuggestionsHandler;
}

interface SlashCommandHandlerArgs {
  definition: SlashCommandDefinition;
  path: readonly SlashCommandDefinition[];
  remainingTokens: string[];
  cleanRemainingTokens: string[];
  rawInput: string; // Raw input after command name, preserving newlines
}

export type SlashCommandHandler = (input: SlashCommandHandlerArgs) => ParsedCommand;

export interface SlashSuggestion {
  id: string;
  display: string;
  description: string;
  replacement: string;
}

export interface SlashSuggestionContext {
  providerNames?: string[];
  /** Variant determines which commands are available */
  variant?: "workspace" | "creation";
}

export interface SuggestionDefinition {
  key: string;
  description: string;
  appendSpace?: boolean;
}
