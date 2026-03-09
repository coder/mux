/**
 * Command registry - All slash commands are declared here
 */

import type {
  SlashCommandDefinition,
  ParsedCommand,
  SlashSuggestion,
  SuggestionDefinition,
  SlashSuggestionContext,
} from "./types";
import minimist from "minimist";
import { MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import { SLASH_COMMAND_HINTS } from "@/common/constants/slashCommandHints";
import { WORKSPACE_ONLY_COMMAND_KEYS } from "@/constants/slashCommands";
import { normalizeModelInput } from "@/browser/utils/models/normalizeModelInput";

/**
 * Parse multiline command input into first-line tokens and remaining message.
 * Used by commands that support messages on subsequent lines (/compact, /new).
 */
function parseMultilineCommand(rawInput: string): {
  firstLine: string;
  tokens: string[];
  message: string | undefined;
  hasMultiline: boolean;
} {
  const hasMultiline = rawInput.includes("\n");
  const lines = rawInput.split("\n");
  const firstLine = lines[0];
  const remainingLines = lines.slice(1).join("\n").trim();

  // Tokenize first line only (preserving quotes)
  const tokens = (firstLine.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) =>
    token.replace(/^"(.*)"$/, "$1")
  );

  return {
    firstLine,
    tokens,
    message: remainingLines.length > 0 ? remainingLines : undefined,
    hasMultiline,
  };
}

// Re-export MODEL_ABBREVIATIONS from constants for backwards compatibility
export { MODEL_ABBREVIATIONS };

// Suggestion helper functions
function filterAndMapSuggestions<T extends SuggestionDefinition>(
  definitions: readonly T[],
  partial: string,
  build: (definition: T) => SlashSuggestion
): SlashSuggestion[] {
  const normalizedPartial = partial.trim().toLowerCase();

  return definitions
    .filter((definition) =>
      normalizedPartial ? definition.key.toLowerCase().startsWith(normalizedPartial) : true
    )
    .map((definition) => build(definition));
}

const clearCommandDefinition: SlashCommandDefinition = {
  key: "clear",
  description: "Clear conversation history",
  appendSpace: false,
  handler: ({ cleanRemainingTokens }) => {
    if (cleanRemainingTokens.length > 0) {
      return {
        type: "unknown-command",
        command: "clear",
        subcommand: cleanRemainingTokens[0],
      };
    }

    return { type: "clear" };
  },
};

const TRUNCATE_USAGE = `/truncate ${SLASH_COMMAND_HINTS.truncate} (percentage to remove)`;

const truncateCommandDefinition: SlashCommandDefinition = {
  key: "truncate",
  description: "Truncate conversation history by percentage (0-100)",
  inputHint: SLASH_COMMAND_HINTS.truncate,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length === 0) {
      return {
        type: "command-missing-args",
        command: "truncate",
        usage: TRUNCATE_USAGE,
      };
    }

    if (cleanRemainingTokens.length > 1) {
      return {
        type: "command-invalid-args",
        command: "truncate",
        input: cleanRemainingTokens.join(" "),
        usage: TRUNCATE_USAGE,
      };
    }

    // Parse percentage (0-100)
    const pctStr = cleanRemainingTokens[0];
    const pct = parseFloat(pctStr);

    if (isNaN(pct) || pct < 0 || pct > 100) {
      return {
        type: "command-invalid-args",
        command: "truncate",
        input: pctStr,
        usage: TRUNCATE_USAGE,
      };
    }

    // Convert to 0.0-1.0
    return { type: "truncate", percentage: pct / 100 };
  },
};

const compactCommandDefinition: SlashCommandDefinition = {
  key: "compact",
  description:
    "Compact conversation history using AI summarization. Use -t <tokens> to set max output tokens, -m <model> to set compaction model. Add continue message on lines after the command.",
  inputHint: SLASH_COMMAND_HINTS.compact,
  handler: ({ rawInput }): ParsedCommand => {
    const {
      tokens: firstLineTokens,
      message: remainingLines,
      hasMultiline,
    } = parseMultilineCommand(rawInput);

    // Parse flags from first line using minimist
    const parsed = minimist(firstLineTokens, {
      string: ["t", "c", "m"],
      unknown: (arg: string) => {
        // Unknown flags starting with - are errors
        if (arg.startsWith("-")) {
          return false;
        }
        return true;
      },
    });

    // Check for unknown flags (only from first line)
    const unknownFlags = firstLineTokens.filter(
      (token) => token.startsWith("-") && token !== "-t" && token !== "-c" && token !== "-m"
    );
    if (unknownFlags.length > 0) {
      return {
        type: "unknown-command",
        command: "compact",
        subcommand: `Unknown flag: ${unknownFlags[0]}`,
      };
    }

    // Validate -t value if present
    let maxOutputTokens: number | undefined;
    if (parsed.t !== undefined) {
      const tokens = parseInt(parsed.t as string, 10);
      if (isNaN(tokens) || tokens <= 0) {
        return {
          type: "unknown-command",
          command: "compact",
          subcommand: `-t requires a positive number, got ${String(parsed.t)}`,
        };
      }
      maxOutputTokens = tokens;
    }

    // Handle -m (model) flag: resolve abbreviation if present, otherwise use as-is
    let model: string | undefined;
    if (parsed.m !== undefined && typeof parsed.m === "string" && parsed.m.trim().length > 0) {
      const normalized = normalizeModelInput(parsed.m.trim());
      model = normalized.model ?? parsed.m.trim();
    }

    // Reject extra positional arguments UNLESS they're from multiline content
    // (multiline content gets parsed as positional args by minimist since newlines become spaces)
    if (parsed._.length > 0 && !hasMultiline) {
      return {
        type: "unknown-command",
        command: "compact",
        subcommand: `Unexpected argument: ${parsed._[0]}`,
      };
    }

    // Determine continue message:
    // 1. If -c flag present (backwards compat), use it
    // 2. Otherwise, use multiline content (new behavior)
    let continueMessage: string | undefined;

    if (parsed.c !== undefined && typeof parsed.c === "string" && parsed.c.trim().length > 0) {
      // -c flag takes precedence (backwards compatibility)
      continueMessage = parsed.c.trim();
    } else if (remainingLines) {
      // Use multiline content
      continueMessage = remainingLines;
    }

    return { type: "compact", maxOutputTokens, continueMessage, model };
  },
};

const modelCommandDefinition: SlashCommandDefinition = {
  key: "model",
  description: "Select AI model",
  inputHint: SLASH_COMMAND_HINTS.model,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length === 0) {
      return { type: "model-help" };
    }

    if (cleanRemainingTokens.length === 1) {
      const token = cleanRemainingTokens[0];
      const normalized = normalizeModelInput(token);

      // Resolve abbreviation if present, otherwise use as full model string
      return {
        type: "model-set",
        modelString: normalized.model ?? token,
      };
    }

    // Too many arguments
    return {
      type: "unknown-command",
      command: "model",
      subcommand: cleanRemainingTokens[1],
    };
  },
  suggestions: ({ stage, partialToken }) => {
    // Stage 1: /model [abbreviation]
    if (stage === 1) {
      const abbreviationSuggestions = Object.entries(MODEL_ABBREVIATIONS).map(
        ([abbrev, fullModel]) => ({
          key: abbrev,
          description: fullModel,
        })
      );

      return filterAndMapSuggestions(abbreviationSuggestions, partialToken, (definition) => ({
        id: `command:model:${definition.key}`,
        display: definition.key,
        description: definition.description,
        replacement: `/model ${definition.key}`,
      }));
    }

    return null;
  },
};

const vimCommandDefinition: SlashCommandDefinition = {
  key: "vim",
  description: "Toggle Vim mode for the chat input",
  appendSpace: false,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length > 0) {
      return {
        type: "unknown-command",
        command: "vim",
        subcommand: cleanRemainingTokens[0],
      };
    }

    return { type: "vim-toggle" };
  },
};

const planOpenCommandDefinition: SlashCommandDefinition = {
  key: "open",
  description: "Open plan in external editor",
  appendSpace: false,
  handler: (): ParsedCommand => ({ type: "plan-open" }),
};

const planCommandDefinition: SlashCommandDefinition = {
  key: "plan",
  description: "Show or edit the current plan",
  appendSpace: false,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length > 0) {
      return { type: "unknown-command", command: "plan", subcommand: cleanRemainingTokens[0] };
    }
    return { type: "plan-show" };
  },
  children: [planOpenCommandDefinition],
};

const forkCommandDefinition: SlashCommandDefinition = {
  key: "fork",
  description: "Fork workspace. Optionally include a start message.",
  inputHint: SLASH_COMMAND_HINTS.fork,
  handler: ({ rawInput }): ParsedCommand => {
    const trimmed = rawInput.trim();
    if (trimmed.length === 0) {
      // No args → immediate fork with auto-generated name, no start message
      return { type: "fork" };
    }

    // Everything after /fork is the start message (name is auto-generated by backend)
    return {
      type: "fork",
      startMessage: trimmed,
    };
  },
};

const newCommandDefinition: SlashCommandDefinition = {
  key: "new",
  description:
    "Create new workspace with optional trunk branch and runtime. Use -t <branch> to specify trunk, -r <runtime> for remote execution (e.g., 'ssh hostname' or 'ssh user@host'). Add start message on lines after the command.",
  inputHint: SLASH_COMMAND_HINTS.new,
  handler: ({ rawInput }): ParsedCommand => {
    const {
      tokens: firstLineTokens,
      message: remainingLines,
      hasMultiline,
    } = parseMultilineCommand(rawInput);

    // Parse flags from first line using minimist
    const parsed = minimist(firstLineTokens, {
      string: ["t", "r"],
      unknown: (arg: string) => {
        // Unknown flags starting with - are errors
        if (arg.startsWith("-")) {
          return false;
        }
        return true;
      },
    });

    // Check for unknown flags - return undefined workspaceName to open modal
    const unknownFlags = firstLineTokens.filter(
      (token) => token.startsWith("-") && token !== "-t" && token !== "-r"
    );
    if (unknownFlags.length > 0) {
      return {
        type: "new",
        workspaceName: undefined,
        trunkBranch: undefined,
        runtime: undefined,
        startMessage: undefined,
      };
    }

    // No workspace name provided - return undefined to open modal
    if (parsed._.length === 0) {
      // Get trunk branch from -t flag
      let trunkBranch: string | undefined;
      if (parsed.t !== undefined && typeof parsed.t === "string" && parsed.t.trim().length > 0) {
        trunkBranch = parsed.t.trim();
      }

      // Get runtime from -r flag
      let runtime: string | undefined;
      if (parsed.r !== undefined && typeof parsed.r === "string" && parsed.r.trim().length > 0) {
        runtime = parsed.r.trim();
      }

      return {
        type: "new",
        workspaceName: undefined,
        trunkBranch,
        runtime,
        startMessage: remainingLines,
      };
    }

    // Get workspace name (first positional argument)
    const workspaceName = String(parsed._[0]);

    // Reject extra positional arguments - return undefined to open modal
    if (parsed._.length > 1 && !hasMultiline) {
      return {
        type: "new",
        workspaceName: undefined,
        trunkBranch: undefined,
        runtime: undefined,
        startMessage: undefined,
      };
    }

    // Get trunk branch from -t flag
    let trunkBranch: string | undefined;
    if (parsed.t !== undefined && typeof parsed.t === "string" && parsed.t.trim().length > 0) {
      trunkBranch = parsed.t.trim();
    }

    // Get runtime from -r flag
    let runtime: string | undefined;
    if (parsed.r !== undefined && typeof parsed.r === "string" && parsed.r.trim().length > 0) {
      runtime = parsed.r.trim();
    }

    return {
      type: "new",
      workspaceName,
      trunkBranch,
      runtime,
      startMessage: remainingLines,
    };
  },
};

const IDLE_USAGE = `/idle ${SLASH_COMMAND_HINTS.idle}`;

const idleCommandDefinition: SlashCommandDefinition = {
  key: "idle",
  description: `Configure idle compaction for this project. Usage: ${IDLE_USAGE}`,
  inputHint: SLASH_COMMAND_HINTS.idle,
  appendSpace: false,
  handler: ({ cleanRemainingTokens }): ParsedCommand => {
    if (cleanRemainingTokens.length === 0) {
      return {
        type: "command-missing-args",
        command: "idle",
        usage: IDLE_USAGE,
      };
    }

    const arg = cleanRemainingTokens[0].toLowerCase();

    // "off", "disable", or "0" all disable idle compaction
    if (arg === "off" || arg === "disable" || arg === "0") {
      return { type: "idle-compaction", hours: null };
    }

    const hours = parseInt(arg, 10);
    if (isNaN(hours) || hours < 1) {
      return {
        type: "command-invalid-args",
        command: "idle",
        input: arg,
        usage: IDLE_USAGE,
      };
    }

    return { type: "idle-compaction", hours };
  },
};

const debugLlmRequestCommandDefinition: SlashCommandDefinition = {
  key: "debug-llm-request",
  description: "Show the last LLM request sent (debug)",
  appendSpace: false,
  handler: (): ParsedCommand => ({ type: "debug-llm-request" }),
};

export const SLASH_COMMAND_DEFINITIONS: readonly SlashCommandDefinition[] = [
  clearCommandDefinition,
  truncateCommandDefinition,
  compactCommandDefinition,
  modelCommandDefinition,
  planCommandDefinition,

  forkCommandDefinition,
  newCommandDefinition,
  vimCommandDefinition,
  idleCommandDefinition,
  debugLlmRequestCommandDefinition,
];

export const SLASH_COMMAND_DEFINITION_MAP = new Map(
  SLASH_COMMAND_DEFINITIONS.map((definition) => [definition.key, definition])
);

const COMMAND_GHOST_HINT_PATTERN = /^\/(\S+) +$/;

export function getCommandGhostHint(
  input: string,
  showCommandSuggestions: boolean,
  variant?: SlashSuggestionContext["variant"]
): string | null {
  if (showCommandSuggestions) {
    return null;
  }

  const match = COMMAND_GHOST_HINT_PATTERN.exec(input);
  if (!match) {
    return null;
  }

  const commandKey = match[1];
  if (variant === "creation" && WORKSPACE_ONLY_COMMAND_KEYS.has(commandKey)) {
    return null;
  }

  return SLASH_COMMAND_DEFINITION_MAP.get(commandKey)?.inputHint ?? null;
}
