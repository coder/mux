import assert from "node:assert/strict";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import { SLASH_COMMAND_HINTS } from "@/common/constants/slashCommandHints";
import {
  buildRuntimeConfig,
  parseRuntimeModeAndHost,
  type RuntimeConfig,
} from "@/common/types/runtime";
import {
  isValidModelFormat,
  normalizeGatewayModel,
  resolveModelAlias,
} from "@/common/utils/ai/models";
import minimist from "minimist";

const CLEAR_COMMAND_NAME = "clear";
const TRUNCATE_COMMAND_NAME = "truncate";
const COMPACT_COMMAND_NAME = "compact";
const FORK_COMMAND_NAME = "fork";
const NEW_COMMAND_NAME = "new";

const TRUNCATE_USAGE = `/truncate ${SLASH_COMMAND_HINTS.truncate}`;
const COMPACT_USAGE = `/compact ${SLASH_COMMAND_HINTS.compact}`;
const NEW_USAGE = `/new ${SLASH_COMMAND_HINTS.new}`;

interface ServerCommandDefinition {
  name: string;
  description: string;
  inputHint?: string;
}

const SERVER_COMMAND_DEFINITIONS: readonly ServerCommandDefinition[] = [
  {
    name: CLEAR_COMMAND_NAME,
    description: "Clear conversation history for this workspace.",
  },
  {
    name: TRUNCATE_COMMAND_NAME,
    description: "Truncate conversation history by percentage (0-100).",
    inputHint: SLASH_COMMAND_HINTS.truncate,
  },
  {
    name: COMPACT_COMMAND_NAME,
    description:
      "Compact conversation history using AI summarization. Supports -t <tokens>, -m <model>, and multiline continue messages.",
    inputHint: SLASH_COMMAND_HINTS.compact,
  },
  {
    name: FORK_COMMAND_NAME,
    description: "Fork the current workspace. Optionally include a start message.",
    inputHint: SLASH_COMMAND_HINTS.fork,
  },
  {
    name: NEW_COMMAND_NAME,
    description:
      "Create a new workspace from the current project. Supports -t <trunk-branch>, -r <runtime>, and multiline start messages.",
    inputHint: SLASH_COMMAND_HINTS.new,
  },
] as const;

const RESERVED_COMMAND_NAMES = new Set<string>(
  SERVER_COMMAND_DEFINITIONS.map((definition) => definition.name)
);

interface ParsedMultilineCommand {
  tokens: string[];
  message: string | undefined;
  hasMultiline: boolean;
}

export type ParsedAcpSlashCommand =
  | { kind: "clear" }
  | { kind: "truncate"; percentage: number }
  | {
      kind: "compact";
      rawCommand: string;
      maxOutputTokens?: number;
      model?: string;
      continueMessage?: string;
    }
  | { kind: "fork"; startMessage?: string }
  | {
      kind: "new";
      workspaceName: string;
      trunkBranch?: string;
      runtimeConfig?: RuntimeConfig;
      startMessage?: string;
    }
  | {
      kind: "skill";
      descriptor: AgentSkillDescriptor;
      rawCommand: string;
      commandPrefix: string;
      formattedMessage: string;
    }
  | { kind: "invalid"; message: string };

export function buildAcpAvailableCommands(skills: AgentSkillDescriptor[]): AvailableCommand[] {
  assert(Array.isArray(skills), "buildAcpAvailableCommands: skills must be an array");

  const commands: AvailableCommand[] = SERVER_COMMAND_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    ...(definition.inputHint == null ? {} : { input: { hint: definition.inputHint } }),
  }));

  const seenNames = new Set(commands.map((command) => command.name));

  for (const skill of skills) {
    if (skill.advertise === false) {
      continue;
    }

    if (RESERVED_COMMAND_NAMES.has(skill.name) || seenNames.has(skill.name)) {
      continue;
    }

    commands.push({
      name: skill.name,
      description: `${skill.description} (${formatSkillScope(skill.scope)})`,
      input: { hint: "Describe how to apply this skill" },
    });
    seenNames.add(skill.name);
  }

  return commands;
}

export function mapSkillsByName(skills: AgentSkillDescriptor[]): Map<string, AgentSkillDescriptor> {
  assert(Array.isArray(skills), "mapSkillsByName: skills must be an array");

  const byName = new Map<string, AgentSkillDescriptor>();
  for (const skill of skills) {
    byName.set(skill.name, skill);
  }

  return byName;
}

export function parseAcpSlashCommand(
  input: string,
  skillsByName: ReadonlyMap<string, AgentSkillDescriptor>
): ParsedAcpSlashCommand | null {
  assert(typeof input === "string", "parseAcpSlashCommand: input must be a string");
  assert(skillsByName != null, "parseAcpSlashCommand: skillsByName is required");

  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const tokens = tokenize(trimmed.slice(1));
  if (tokens.length === 0) {
    return null;
  }

  const [commandName, ...remainingTokens] = tokens;
  assert(
    commandName != null,
    "parseAcpSlashCommand: commandName should be present when tokens exist"
  );

  const rawInput = extractRawInput(trimmed, commandName);

  if (commandName === CLEAR_COMMAND_NAME) {
    if (remainingTokens.length > 0) {
      return {
        kind: "invalid",
        message: `Usage: /${CLEAR_COMMAND_NAME}`,
      };
    }
    return { kind: "clear" };
  }

  if (commandName === TRUNCATE_COMMAND_NAME) {
    return parseTruncateCommand(remainingTokens);
  }

  if (commandName === COMPACT_COMMAND_NAME) {
    return parseCompactCommand(rawInput, trimmed);
  }

  if (commandName === FORK_COMMAND_NAME) {
    return parseForkCommand(rawInput);
  }

  if (commandName === NEW_COMMAND_NAME) {
    return parseNewCommand(rawInput);
  }

  return parseSkillCommand(trimmed, commandName, skillsByName);
}

function parseTruncateCommand(remainingTokens: string[]): ParsedAcpSlashCommand {
  if (remainingTokens.length !== 1) {
    return {
      kind: "invalid",
      message: `Usage: ${TRUNCATE_USAGE}`,
    };
  }

  const percentageText = remainingTokens[0];
  // Require the entire token to be numeric so typos like "25oops" are rejected
  // instead of silently executing a destructive truncate command.
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(percentageText)) {
    return {
      kind: "invalid",
      message: `Invalid percentage "${percentageText}". Usage: ${TRUNCATE_USAGE}`,
    };
  }

  const percentageValue = Number(percentageText);
  if (!Number.isFinite(percentageValue) || percentageValue < 0 || percentageValue > 100) {
    return {
      kind: "invalid",
      message: `Invalid percentage "${percentageText}". Usage: ${TRUNCATE_USAGE}`,
    };
  }

  return {
    kind: "truncate",
    percentage: percentageValue / 100,
  };
}

function parseCompactCommand(rawInput: string, rawCommand: string): ParsedAcpSlashCommand {
  const { tokens: firstLineTokens, message: multilineMessage } = parseMultilineCommand(rawInput);

  const parsed = minimist(firstLineTokens, {
    string: ["t", "m", "c"],
    unknown: (arg: string) => {
      if (arg.startsWith("-")) {
        return false;
      }
      return true;
    },
  });

  const unknownFlags = firstLineTokens.filter(
    (token) => token.startsWith("-") && token !== "-t" && token !== "-m" && token !== "-c"
  );
  if (unknownFlags.length > 0) {
    return {
      kind: "invalid",
      message: `Unknown flag "${unknownFlags[0]}". Usage: ${COMPACT_USAGE}`,
    };
  }

  const inlineContinueMessage = joinPositionalMessageTokens(parsed._, COMPACT_USAGE);
  if (inlineContinueMessage.error != null) {
    return {
      kind: "invalid",
      message: inlineContinueMessage.error,
    };
  }

  let maxOutputTokens: number | undefined;
  if (parsed.t != null) {
    if (typeof parsed.t !== "string") {
      return {
        kind: "invalid",
        message: `-t expects a positive integer. Usage: ${COMPACT_USAGE}`,
      };
    }

    if (!/^\d+$/.test(parsed.t)) {
      return {
        kind: "invalid",
        message: `-t expects a positive integer. Usage: ${COMPACT_USAGE}`,
      };
    }

    const parsedTokens = Number(parsed.t);
    if (!Number.isSafeInteger(parsedTokens) || parsedTokens <= 0) {
      return {
        kind: "invalid",
        message: `-t expects a positive integer. Usage: ${COMPACT_USAGE}`,
      };
    }

    maxOutputTokens = parsedTokens;
  }

  let model: string | undefined;
  if (parsed.m != null) {
    if (typeof parsed.m !== "string" || parsed.m.trim().length === 0) {
      return {
        kind: "invalid",
        message: `-m expects a model id. Usage: ${COMPACT_USAGE}`,
      };
    }

    const normalizedModel = normalizeModelForCommand(parsed.m);
    if (normalizedModel == null) {
      return {
        kind: "invalid",
        message: `Invalid model "${parsed.m}". Expected "provider:model" or a known alias.`,
      };
    }

    model = normalizedModel;
  }

  let continueMessage: string | undefined;
  if (typeof parsed.c === "string" && parsed.c.trim().length > 0) {
    continueMessage = parsed.c.trim();
  } else {
    const combinedMessage = joinMultilineAndInlineMessage(
      multilineMessage,
      inlineContinueMessage.message
    );
    continueMessage = combinedMessage;
  }

  return {
    kind: "compact",
    rawCommand,
    maxOutputTokens,
    model,
    continueMessage,
  };
}

function parseForkCommand(rawInput: string): ParsedAcpSlashCommand {
  const startMessage = rawInput.trim();

  return {
    kind: "fork",
    startMessage: startMessage.length > 0 ? startMessage : undefined,
  };
}

function parseNewCommand(rawInput: string): ParsedAcpSlashCommand {
  const { tokens: firstLineTokens, message: multilineMessage } = parseMultilineCommand(rawInput);

  const parsed = minimist(firstLineTokens, {
    string: ["t", "r"],
    unknown: (arg: string) => {
      if (arg.startsWith("-")) {
        return false;
      }
      return true;
    },
  });

  const unknownFlags = firstLineTokens.filter(
    (token) => token.startsWith("-") && token !== "-t" && token !== "-r"
  );
  if (unknownFlags.length > 0) {
    return {
      kind: "invalid",
      message: `Unknown flag "${unknownFlags[0]}". Usage: ${NEW_USAGE}`,
    };
  }

  const workspaceNameToken = coercePositionalTokenToText(parsed._[0], NEW_USAGE);
  if (workspaceNameToken.error != null) {
    return {
      kind: "invalid",
      message: workspaceNameToken.error,
    };
  }

  if (workspaceNameToken.text == null) {
    return {
      kind: "invalid",
      message: `Missing workspace name. Usage: ${NEW_USAGE}`,
    };
  }

  const workspaceName = workspaceNameToken.text;
  const trunkBranch =
    typeof parsed.t === "string" && parsed.t.trim().length > 0 ? parsed.t.trim() : undefined;

  let startMessageTokens = parsed._.slice(1);
  let runtimeConfig: RuntimeConfig | undefined;
  if (parsed.r != null) {
    if (typeof parsed.r !== "string" || parsed.r.trim().length === 0) {
      return {
        kind: "invalid",
        message: `-r expects a runtime (e.g., "ssh user@host" or "docker ubuntu:22.04").`,
      };
    }

    const runtimeInput = parsed.r.trim();
    let parsedRuntime = parseRuntimeInput(runtimeInput);

    // Allow unquoted two-token runtime values (e.g., `-r ssh user@host`).
    // minimist captures only the first token for `-r`, so consume the first
    // positional token as a runtime suffix when doing so resolves parsing.
    const runtimeSuffixToken = coercePositionalTokenToText(startMessageTokens[0], NEW_USAGE);
    if (parsedRuntime.error != null && runtimeSuffixToken.text != null) {
      const combinedRuntimeInput = `${runtimeInput} ${runtimeSuffixToken.text}`;
      const combinedParsedRuntime = parseRuntimeInput(combinedRuntimeInput);
      if (combinedParsedRuntime.error == null) {
        parsedRuntime = combinedParsedRuntime;
        startMessageTokens = startMessageTokens.slice(1);
      }
    }

    if (parsedRuntime.error != null) {
      return {
        kind: "invalid",
        message: parsedRuntime.error,
      };
    }

    runtimeConfig = parsedRuntime.runtimeConfig;
  }

  const inlineStartMessage = joinPositionalMessageTokens(startMessageTokens, NEW_USAGE);
  if (inlineStartMessage.error != null) {
    return {
      kind: "invalid",
      message: inlineStartMessage.error,
    };
  }

  return {
    kind: "new",
    workspaceName,
    trunkBranch,
    runtimeConfig,
    startMessage: joinMultilineAndInlineMessage(multilineMessage, inlineStartMessage.message),
  };
}

function parseSkillCommand(
  trimmedInput: string,
  commandName: string,
  skillsByName: ReadonlyMap<string, AgentSkillDescriptor>
): ParsedAcpSlashCommand | null {
  const skill = skillsByName.get(commandName);
  if (skill == null) {
    return null;
  }

  const commandPrefix = `/${commandName}`;
  const afterPrefix = trimmedInput.slice(commandPrefix.length);
  const hasSeparator = afterPrefix.length === 0 || /^\s/.test(afterPrefix);
  if (!hasSeparator) {
    return null;
  }

  return {
    kind: "skill",
    descriptor: skill,
    rawCommand: trimmedInput,
    commandPrefix,
    formattedMessage: formatSkillInvocationText(commandName, afterPrefix.trimStart()),
  };
}

function parseRuntimeInput(runtime: string): { runtimeConfig?: RuntimeConfig; error?: string } {
  const parsed = parseRuntimeModeAndHost(runtime);
  if (parsed == null) {
    const trimmed = runtime.trim().toLowerCase();
    if (trimmed === "ssh" || trimmed.startsWith("ssh ")) {
      return {
        error: 'SSH runtime requires host (e.g., "ssh hostname" or "ssh user@host").',
      };
    }

    if (trimmed === "docker" || trimmed.startsWith("docker ")) {
      return {
        error: 'Docker runtime requires image (e.g., "docker ubuntu:22.04").',
      };
    }

    if (trimmed === "devcontainer" || trimmed.startsWith("devcontainer")) {
      return {
        error:
          'Dev container runtime requires a config path (e.g., "devcontainer .devcontainer/devcontainer.json").',
      };
    }

    return {
      error:
        "Unknown runtime type. Use one of: worktree, local, ssh <host>, docker <image>, devcontainer <config>",
    };
  }

  if (parsed.mode === "devcontainer" && parsed.configPath.trim().length === 0) {
    return {
      error:
        'Dev container runtime requires a config path (e.g., "devcontainer .devcontainer/devcontainer.json").',
    };
  }

  return {
    runtimeConfig: buildRuntimeConfig(parsed),
  };
}

function normalizeModelForCommand(modelInput: string): string | null {
  const trimmed = modelInput.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const resolved = resolveModelAlias(trimmed);
  const normalized = normalizeGatewayModel(resolved).trim();

  return isValidModelFormat(normalized) ? normalized : null;
}

function parseMultilineCommand(rawInput: string): ParsedMultilineCommand {
  const hasMultiline = rawInput.includes("\n");
  const lines = rawInput.split("\n");
  const firstLine = lines[0] ?? "";
  const remainingLines = lines.slice(1).join("\n").trim();

  const tokens = tokenize(firstLine);

  return {
    tokens,
    message: remainingLines.length > 0 ? remainingLines : undefined,
    hasMultiline,
  };
}

function formatUnexpectedPositionalToken(token: unknown): string {
  if (token === undefined) {
    return "undefined";
  }

  if (token === null) {
    return "null";
  }

  if (
    typeof token === "string" ||
    typeof token === "number" ||
    typeof token === "boolean" ||
    typeof token === "bigint" ||
    typeof token === "symbol"
  ) {
    return String(token);
  }

  return `<${typeof token}>`;
}

function coercePositionalTokenToText(
  token: unknown,
  usage: string
): { text?: string; error?: string } {
  assert(usage.trim().length > 0, "coercePositionalTokenToText: usage must be non-empty");

  if (token == null) {
    return {};
  }

  let tokenText: string;
  if (typeof token === "string") {
    tokenText = token;
  } else if (typeof token === "number") {
    if (!Number.isFinite(token)) {
      return {
        error: `Unexpected argument "${formatUnexpectedPositionalToken(token)}". Usage: ${usage}`,
      };
    }
    tokenText = String(token);
  } else if (typeof token === "boolean" || typeof token === "bigint") {
    tokenText = String(token);
  } else {
    return {
      error: `Unexpected argument "${formatUnexpectedPositionalToken(token)}". Usage: ${usage}`,
    };
  }

  const trimmedToken = tokenText.trim();
  if (trimmedToken.length === 0) {
    return {};
  }

  return { text: trimmedToken };
}

function joinPositionalMessageTokens(
  tokens: unknown[],
  usage: string
): { message?: string; error?: string } {
  assert(Array.isArray(tokens), "joinPositionalMessageTokens: tokens must be an array");
  assert(usage.trim().length > 0, "joinPositionalMessageTokens: usage must be non-empty");

  if (tokens.length === 0) {
    return {};
  }

  const normalizedTokens: string[] = [];
  for (const token of tokens) {
    const normalizedToken = coercePositionalTokenToText(token, usage);
    if (normalizedToken.error != null) {
      return { error: normalizedToken.error };
    }

    if (normalizedToken.text == null) {
      continue;
    }

    normalizedTokens.push(normalizedToken.text);
  }

  if (normalizedTokens.length === 0) {
    return {};
  }

  return { message: normalizedTokens.join(" ") };
}

function joinMultilineAndInlineMessage(
  multilineMessage: string | undefined,
  inlineMessage: string | undefined
): string | undefined {
  const normalizedMultiline = multilineMessage?.trim();
  const normalizedInline = inlineMessage?.trim();

  const parts = [normalizedInline, normalizedMultiline].filter(
    (part): part is string => part != null && part.length > 0
  );

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join("\n");
}

function tokenize(input: string): string[] {
  return (input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) =>
    token.replace(/^"(.*)"$/, "$1")
  );
}

function extractRawInput(trimmedInput: string, commandName: string): string {
  let rawInput = trimmedInput.slice(`/${commandName}`.length);
  while (rawInput.startsWith(" ")) {
    rawInput = rawInput.slice(1);
  }

  return rawInput;
}

function formatSkillInvocationText(skillName: string, userMessage: string): string {
  return userMessage.length > 0
    ? `Using skill ${skillName}: ${userMessage}`
    : `Use skill ${skillName}`;
}

function formatSkillScope(scope: AgentSkillDescriptor["scope"]): string {
  if (scope === "global") {
    return "user";
  }

  return scope;
}
