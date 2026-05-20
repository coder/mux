import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import {
  DEFAULT_TOOL_COLLAPSED_DISPLAY_MODE,
  isToolCollapsedDisplayMode,
} from "@/common/constants/storage";
import { formatDuration } from "@/common/utils/formatDuration";

export type BashCollapsedSummary =
  | { kind: "command"; command: string }
  | { kind: "intent-command"; intent: string; command: string; durationLabel?: string };

interface BuildBashCollapsedSummaryOptions {
  args: BashToolArgs;
  result?: BashToolResult;
  isBackground: boolean;
  mode: unknown;
}

const DURATION_TOKEN_PATTERN = String.raw`\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)`;
const TRAILING_DURATION_PATTERN = new RegExp(
  String.raw`\s+for\s+${DURATION_TOKEN_PATTERN}(?:\s+${DURATION_TOKEN_PATTERN})?\.?$`,
  "iu"
);
const TRAILING_USING_PATTERN = /\s+using\s+(.+?)\.?$/iu;

export function buildBashCollapsedSummary(
  options: BuildBashCollapsedSummaryOptions
): BashCollapsedSummary {
  const command = typeof options.args.script === "string" ? options.args.script : "";
  const mode = isToolCollapsedDisplayMode(options.mode)
    ? options.mode
    : DEFAULT_TOOL_COLLAPSED_DISPLAY_MODE;

  if (mode === "command") {
    return { kind: "command", command };
  }

  const intent = sanitizeModelIntent(options.args.model_intent, command);
  if (!intent) {
    return { kind: "command", command };
  }

  const durationLabel =
    options.result && !options.isBackground
      ? formatDuration(options.result.wall_duration_ms, "decimal")
      : undefined;

  // Keep the raw command in the summary so users can audit what actually ran.
  return { kind: "intent-command", intent, command, durationLabel };
}

export function sanitizeModelIntent(rawIntent: unknown, command: string): string | undefined {
  if (typeof rawIntent !== "string") {
    return undefined;
  }

  let intent = rawIntent.trim().replace(/\s+/gu, " ");
  if (!intent) {
    return undefined;
  }

  for (let i = 0; i < 2; i++) {
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

  return capitalizeFirstCharacter(intent);
}

function stripTrailingDuration(intent: string): string {
  return intent.replace(TRAILING_DURATION_PATTERN, "").trim();
}

function stripTrailingUsingCommand(intent: string, command: string): string {
  const match = TRAILING_USING_PATTERN.exec(intent);
  if (!match) {
    return intent;
  }

  const candidate = stripWrappingQuotes(match[1] ?? "");
  if (normalizeForComparison(candidate) !== normalizeForComparison(command)) {
    return intent;
  }

  return intent.slice(0, match.index).trim();
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  const quoteMatch = /^([`'"])(.*)\1$/u.exec(trimmed);
  return quoteMatch?.[2]?.trim() ?? trimmed;
}

function normalizeForComparison(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function capitalizeFirstCharacter(value: string): string {
  return value.length > 0 ? value[0].toLocaleUpperCase() + value.slice(1) : value;
}
