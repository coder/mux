import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import {
  DEFAULT_TOOL_COLLAPSED_DISPLAY_MODE,
  isToolCollapsedDisplayMode,
} from "@/common/constants/storage";
import { capitalize } from "@/common/utils/capitalize";
import { formatDuration } from "@/common/utils/formatDuration";

export type BashCollapsedSummary =
  | { kind: "command"; command: string }
  | { kind: "compact-command"; command: string; commandSummary: string }
  | { kind: "intent-command"; intent: string; command: string; durationLabel?: string };

interface BuildBashCollapsedSummaryOptions {
  args: BashToolArgs;
  result?: BashToolResult;
  isBackground: boolean;
  displayMode: unknown;
}

const DURATION_TOKEN_PATTERN = String.raw`\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)`;
const TRAILING_DURATION_PATTERN = new RegExp(
  String.raw`\s+for\s+${DURATION_TOKEN_PATTERN}(?:\s+${DURATION_TOKEN_PATTERN})?\.?$`,
  "iu"
);
const TRAILING_USING_PATTERN = /^(?:(.*)\s+)?using\s+(.+?)\.?$/isu;
/** Two passes catch nested patterns, for example "doing work using cmd for 5s for 3m". */
const MAX_SANITIZE_PASSES = 2;

const SKIP_WHOLE_FRAGMENT_KEYWORDS = new Set([
  "case",
  "done",
  "esac",
  "fi",
  "for",
  "function",
  "select",
]);
const STRIP_PREFIX_KEYWORDS = new Set([
  "!",
  "(",
  ")",
  "{",
  "}",
  "do",
  "elif",
  "else",
  "if",
  "then",
  "until",
  "while",
]);
const SIMPLE_COMMAND_WRAPPERS = new Set(["builtin", "command", "exec", "time"]);
const ENV_OPTIONS_WITH_ARGUMENT = new Set([
  "-C",
  "-S",
  "-u",
  "--chdir",
  "--split-string",
  "--unset",
]);
const ENV_SHORT_OPTIONS_WITH_ARGUMENT = new Set(["C", "S", "u"]);
const REDIRECTION_OPERATOR_PATTERN = String.raw`(?:&>>|&>|<>|>>|>\||>|<<<|<<-?|>&|<&)`;
const REDIRECTION_TOKEN_PATTERN = new RegExp(
  String.raw`^(?:\d*)?${REDIRECTION_OPERATOR_PATTERN}$`,
  "u"
);
const ATTACHED_REDIRECTION_TOKEN_PATTERN = new RegExp(
  String.raw`^(?:\d*)?${REDIRECTION_OPERATOR_PATTERN}.+`,
  "u"
);
const CASE_ARM_LABEL_TOKEN_PATTERN = /^.+\)$/u;
const ASSIGNMENT_TOKEN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/u;

/** Intent improves scanability, command lets users verify what ran. */
export function buildBashCollapsedSummary(
  options: BuildBashCollapsedSummaryOptions
): BashCollapsedSummary {
  const command = typeof options.args.script === "string" ? options.args.script : "";
  const displayMode = isToolCollapsedDisplayMode(options.displayMode)
    ? options.displayMode
    : DEFAULT_TOOL_COLLAPSED_DISPLAY_MODE;

  if (displayMode === "command") {
    return { kind: "command", command };
  }

  if (displayMode === "compact") {
    return { kind: "compact-command", command, commandSummary: summarizeBashCommands(command) };
  }

  const intent = sanitizeModelIntent(options.args.model_intent, command);
  if (!intent || normalizeForComparison(intent) === normalizeForComparison(command)) {
    return { kind: "command", command };
  }

  const durationLabel =
    options.result && !options.isBackground
      ? formatDuration(options.result.wall_duration_ms, "decimal")
      : undefined;

  return {
    kind: "intent-command",
    intent,
    command,
    ...(durationLabel !== undefined ? { durationLabel } : {}),
  };
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

let lastSummarizedCommand: string | undefined;
let lastCommandSummary: string | undefined;

export function summarizeBashCommands(command: string): string {
  // Compact summaries are computed during BashToolCall renders, so avoid re-parsing
  // the same script while a command is streaming or its elapsed time updates.
  if (command === lastSummarizedCommand && lastCommandSummary !== undefined) {
    return lastCommandSummary;
  }

  const summary = summarizeBashCommandsUncached(command);
  lastSummarizedCommand = command;
  lastCommandSummary = summary;
  return summary;
}

function summarizeBashCommandsUncached(command: string): string {
  const commandNames: string[] = [];
  const seenCommandNames = new Set<string>();

  for (const fragment of splitShellCommandFragments(stripHeredocBodies(command))) {
    const commandName = extractCommandNameFromFragment(fragment);
    if (!commandName) {
      continue;
    }

    const normalizedCommandName = commandName.toLowerCase();
    if (seenCommandNames.has(normalizedCommandName)) {
      continue;
    }

    seenCommandNames.add(normalizedCommandName);
    commandNames.push(commandName);
  }

  return commandNames.length > 0 ? commandNames.join(", ") : command;
}

interface HeredocDelimiter {
  delimiter: string;
  allowLeadingTabs: boolean;
}

function stripHeredocBodies(command: string): string {
  const outputLines: string[] = [];
  const pendingDelimiters: HeredocDelimiter[] = [];

  for (const line of command.split("\n")) {
    const pendingDelimiter = pendingDelimiters[0];
    if (pendingDelimiter) {
      const terminatorLine = pendingDelimiter.allowLeadingTabs ? line.replace(/^\t+/u, "") : line;
      if (terminatorLine === pendingDelimiter.delimiter) {
        pendingDelimiters.shift();
      }
      continue;
    }

    outputLines.push(line);
    pendingDelimiters.push(...findHeredocDelimiters(line));
  }

  return outputLines.join("\n");
}

function findHeredocDelimiters(line: string): HeredocDelimiter[] {
  const delimiters: HeredocDelimiter[] = [];
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(" && line[i + 1] === "(") {
      i = skipArithmeticExpression(line, i + 2);
      continue;
    }

    if (char === "$" && line[i + 1] === "(" && line[i + 2] === "(") {
      i = skipArithmeticExpression(line, i + 3);
      continue;
    }

    if (char !== "<" || line[i + 1] !== "<" || line[i + 2] === "<") {
      continue;
    }

    const parsed = parseHeredocDelimiter(line, i + 2);
    if (!parsed) {
      continue;
    }

    delimiters.push({ delimiter: parsed.delimiter, allowLeadingTabs: parsed.allowLeadingTabs });
    i = parsed.endIndex - 1;
  }

  return delimiters;
}

function skipArithmeticExpression(line: string, startIndex: number): number {
  let parenDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let index = startIndex; index < line.length; index++) {
    const char = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      continue;
    }

    if (char !== ")") {
      continue;
    }

    if (parenDepth > 0) {
      parenDepth--;
      continue;
    }

    if (line[index + 1] === ")") {
      return index + 1;
    }
  }

  return line.length - 1;
}

function parseHeredocDelimiter(
  line: string,
  startIndex: number
): { delimiter: string; allowLeadingTabs: boolean; endIndex: number } | undefined {
  let index = startIndex;
  let allowLeadingTabs = false;

  if (line[index] === "-") {
    allowLeadingTabs = true;
    index++;
  }

  while (line[index] === " " || line[index] === "\t") {
    index++;
  }

  const quote = line[index];
  if (quote === "'" || quote === '"') {
    const endIndex = line.indexOf(quote, index + 1);
    if (endIndex === -1) {
      return undefined;
    }

    const delimiter = line.slice(index + 1, endIndex);
    return delimiter ? { delimiter, allowLeadingTabs, endIndex: endIndex + 1 } : undefined;
  }

  const delimiterStart = index;
  while (index < line.length && !/[\s;|&<>]/u.test(line[index])) {
    index++;
  }

  const delimiter = line.slice(delimiterStart, index).replace(/\\(.)/gu, "$1");
  return delimiter ? { delimiter, allowLeadingTabs, endIndex: index } : undefined;
}

// Case patterns use `|` before the closing label marker, not a pipeline command boundary.
function isCasePatternAlternativePipe(
  command: string,
  operatorIndex: number,
  fragment: string
): boolean {
  const currentPattern = fragment.slice(fragment.lastIndexOf("|") + 1).trim();
  if (!currentPattern || /\s/u.test(currentPattern)) {
    return false;
  }

  let sawPatternToken = false;
  let sawWhitespaceAfterPatternToken = false;
  for (let index = operatorIndex + 1; index < command.length; index++) {
    const char = command[index];

    if (char === ")") {
      return sawPatternToken;
    }

    if (char === "|") {
      if (!sawPatternToken) {
        return false;
      }
      sawPatternToken = false;
      sawWhitespaceAfterPatternToken = false;
      continue;
    }

    if (char === "\n" || char === ";" || char === "&") {
      return false;
    }

    if (/\s/u.test(char)) {
      sawWhitespaceAfterPatternToken ||= sawPatternToken;
      continue;
    }

    if (sawWhitespaceAfterPatternToken) {
      return false;
    }

    sawPatternToken = true;
    if (char === "\\") {
      index++;
    }
  }

  return false;
}

function splitShellCommandFragments(command: string): string[] {
  const fragments: string[] = [];
  let fragment = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  const flushFragment = () => {
    const trimmedFragment = fragment.trim();
    if (trimmedFragment) {
      fragments.push(trimmedFragment);
    }
    fragment = "";
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];
    const previousChar = command[i - 1];

    if (escaped) {
      fragment += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      fragment += char;
      escaped = true;
      continue;
    }

    if (quote) {
      fragment += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      fragment += char;
      continue;
    }

    // Arithmetic for-loop headers use semicolons as expression separators, not command boundaries.
    if (char === "(" && nextChar === "(") {
      const endIndex = skipArithmeticExpression(command, i + 2);
      fragment += command.slice(i, endIndex + 1);
      i = endIndex;
      continue;
    }

    if (char === "$" && nextChar === "(" && command[i + 2] === "(") {
      const endIndex = skipArithmeticExpression(command, i + 3);
      fragment += command.slice(i, endIndex + 1);
      i = endIndex;
      continue;
    }

    if (char === "#" && (fragment.length === 0 || /\s/u.test(fragment.at(-1) ?? ""))) {
      flushFragment();
      while (i + 1 < command.length && command[i + 1] !== "\n") {
        i++;
      }
      continue;
    }

    if (char === ";" || char === "\n") {
      flushFragment();
      continue;
    }

    if (char === "|" || char === "&") {
      const isDoubleOperator = nextChar === char;
      const isRedirection =
        (char === "|" && previousChar === ">") ||
        (char === "&" && !isDoubleOperator && (previousChar === ">" || nextChar === ">"));
      const isCaseAlternative =
        char === "|" && !isDoubleOperator && isCasePatternAlternativePipe(command, i, fragment);
      if (!isRedirection && !isCaseAlternative) {
        flushFragment();
        if (isDoubleOperator) {
          i++;
        }
        continue;
      }
    }

    fragment += char;
  }

  flushFragment();
  return fragments;
}

function extractCommandNameFromFragment(fragment: string): string | undefined {
  const tokens = tokenizeShellFragment(fragment);
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (SKIP_WHOLE_FRAGMENT_KEYWORDS.has(token) || token.startsWith("((")) {
      return undefined;
    }

    if (STRIP_PREFIX_KEYWORDS.has(token) || ASSIGNMENT_TOKEN_PATTERN.test(token)) {
      index++;
      continue;
    }

    const nextCaseArmIndex = skipCaseArmLabelTokens(tokens, index);
    if (nextCaseArmIndex !== undefined) {
      index = nextCaseArmIndex;
      continue;
    }

    const nextIndex = skipLeadingRedirection(tokens, index);
    if (nextIndex !== undefined) {
      index = nextIndex;
      continue;
    }

    break;
  }

  const commandToken = unwrapCommandWrapper(tokens, index);
  return commandToken ? normalizeCommandName(commandToken) : undefined;
}

function skipCaseArmLabelTokens(tokens: string[], startIndex: number): number | undefined {
  const firstToken = tokens[startIndex];
  if (!firstToken) {
    return undefined;
  }

  if (CASE_ARM_LABEL_TOKEN_PATTERN.test(firstToken)) {
    return startIndex + 1;
  }

  let sawAlternativeSeparator = false;
  for (let index = startIndex + 1; index < tokens.length; index++) {
    const token = tokens[index];

    if (token === "|") {
      sawAlternativeSeparator = true;
      continue;
    }

    if (token === ")" || CASE_ARM_LABEL_TOKEN_PATTERN.test(token)) {
      return sawAlternativeSeparator ? index + 1 : undefined;
    }

    if (!sawAlternativeSeparator) {
      return undefined;
    }
  }

  return undefined;
}

function skipLeadingRedirection(tokens: string[], index: number): number | undefined {
  const token = tokens[index];
  if (REDIRECTION_TOKEN_PATTERN.test(token)) {
    return index + 2;
  }

  if (ATTACHED_REDIRECTION_TOKEN_PATTERN.test(token)) {
    return index + 1;
  }

  return undefined;
}

function tokenizeShellFragment(fragment: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  const pushToken = () => {
    if (token) {
      tokens.push(token);
      token = "";
    }
  };

  for (const char of fragment) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      pushToken();
      continue;
    }

    token += char;
  }

  pushToken();
  return tokens;
}

function envShortOptionConsumesNext(token: string): boolean {
  if (!token.startsWith("-") || token.startsWith("--")) {
    return false;
  }

  const shortOptions = token.slice(1);
  const optionWithArgumentIndex = [...shortOptions].findIndex((option) =>
    ENV_SHORT_OPTIONS_WITH_ARGUMENT.has(option)
  );

  return optionWithArgumentIndex !== -1 && optionWithArgumentIndex === shortOptions.length - 1;
}

function execOptionConsumesNext(token: string): boolean {
  if (!token.startsWith("-") || token.startsWith("--")) {
    return false;
  }

  return token.endsWith("a");
}

function skipEnvWrapperTokens(tokens: string[], startIndex: number): number {
  let index = startIndex;

  while (index < tokens.length) {
    const token = tokens[index];

    if (ASSIGNMENT_TOKEN_PATTERN.test(token)) {
      index++;
      continue;
    }

    if (token === "--") {
      return index + 1;
    }

    if (ENV_OPTIONS_WITH_ARGUMENT.has(token)) {
      index += 2;
      continue;
    }

    if (
      token.startsWith("--chdir=") ||
      token.startsWith("--split-string=") ||
      token.startsWith("--unset=")
    ) {
      index++;
      continue;
    }

    if (token.startsWith("-")) {
      index += envShortOptionConsumesNext(token) ? 2 : 1;
      continue;
    }

    break;
  }

  return index;
}

function skipSimpleWrapperOptions(tokens: string[], startIndex: number, wrapper: string): number {
  let index = startIndex;

  while (index < tokens.length && tokens[index].startsWith("-")) {
    if (wrapper === "exec" && execOptionConsumesNext(tokens[index])) {
      index += 2;
      continue;
    }

    index++;
  }

  return index;
}

function unwrapCommandWrapper(tokens: string[], startIndex: number): string | undefined {
  let index = startIndex;

  while (index < tokens.length) {
    const token = tokens[index];

    if (SIMPLE_COMMAND_WRAPPERS.has(token)) {
      index = skipSimpleWrapperOptions(tokens, index + 1, token);
      continue;
    }

    if (token === "env") {
      index = skipEnvWrapperTokens(tokens, index + 1);
      continue;
    }

    if (token === "run_and_report") {
      index += 2;
      continue;
    }

    const nextIndex = skipLeadingRedirection(tokens, index);
    if (nextIndex !== undefined) {
      index = nextIndex;
      continue;
    }

    return token;
  }

  return undefined;
}

function normalizeCommandName(commandToken: string): string | undefined {
  const trimmedToken = commandToken.trim().replace(/^\(+/u, "").replace(/\)+$/u, "");
  if (!trimmedToken) {
    return undefined;
  }

  const pathParts = trimmedToken.split("/").filter(Boolean);
  return pathParts.at(-1) ?? trimmedToken;
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
