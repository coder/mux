import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import { capitalize } from "@/common/utils/capitalize";
import { formatDuration } from "@/common/utils/formatDuration";

export type BashCollapsedSummary =
  | { kind: "command"; command: string }
  | { kind: "intent-command"; intent: string; command: string; durationLabel?: string };

interface BuildBashCollapsedSummaryOptions {
  args: BashToolArgs;
  result?: BashToolResult;
  isBackground: boolean;
}

const DURATION_TOKEN_PATTERN = String.raw`\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)`;
const TRAILING_DURATION_PATTERN = new RegExp(
  String.raw`\s+for\s+${DURATION_TOKEN_PATTERN}(?:\s+${DURATION_TOKEN_PATTERN})?\.?$`,
  "iu"
);
const TRAILING_USING_PATTERN = /^(?:(.*)\s+)?using\s+(.+?)\.?$/isu;
/** Two passes catch nested patterns, for example "doing work using cmd for 5s for 3m". */
const MAX_SANITIZE_PASSES = 2;

/** Intent improves scanability, command lets users verify what ran. */
export function buildBashCollapsedSummary(
  options: BuildBashCollapsedSummaryOptions
): BashCollapsedSummary {
  const command = typeof options.args.script === "string" ? options.args.script : "";

  const intent = sanitizeModelIntent(options.args.model_intent, command);
  if (!intent || normalizeForComparison(intent) === normalizeForComparison(command)) {
    return { kind: "command", command };
  }

  const durationLabel =
    options.result && !options.isBackground
      ? formatDuration(options.result.wall_duration_ms, "decimal")
      : undefined;

  // So users can verify what ran.
  return { kind: "intent-command", intent, command, durationLabel };
}

/** Models may echo `using <command>` and `for <duration>` despite schema guidance, so strip those since Mux appends them. */
export function sanitizeModelIntent(rawIntent: unknown, command: string): string | undefined {
  if (typeof rawIntent !== "string") {
    return undefined;
  }

  let intent = rawIntent.trim().replace(/\s+/gu, " ");
  if (!intent) {
    return undefined;
  }

  for (let i = 0; i < MAX_SANITIZE_PASSES; i++) {
    const before = intent;
    intent = stripTrailingDuration(intent);
    intent = stripTrailingUsingCommand(intent, command);
    intent = stripTrailingDuration(intent);
    if (intent === before) {
      break;
    }
  }

  intent = intent.trim();
  if (!intent) {
    return undefined;
  }

  return capitalize(intent);
}

function stripTrailingDuration(intent: string): string {
  return intent.replace(TRAILING_DURATION_PATTERN, "").trim();
}

function stripTrailingUsingCommand(intent: string, command: string): string {
  const match = TRAILING_USING_PATTERN.exec(intent);
  if (!match) {
    return intent;
  }

  const prefix = match[1]?.trim() ?? "";
  const candidate = stripWrappingQuotes(match[2] ?? "");
  if (normalizeForComparison(candidate) !== normalizeForComparison(command)) {
    return intent;
  }

  return prefix;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  const quoteMatch = /^([`'"])(.*)\1$/u.exec(trimmed);
  return quoteMatch?.[2]?.trim() ?? trimmed;
}

function normalizeForComparison(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
