import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { parseCommand, tokenizeSlashCommandArguments } from "@/browser/utils/slashCommands/parser";
import type { APIClient } from "@/browser/contexts/API";
import {
  extractInlineSkillReferenceCandidates,
  resolveInlineSkillReferences,
  type InlineSkillCandidate,
} from "@/browser/utils/agentSkills/inlineSkillReferences";
import { resolveSkillUserInvocable } from "@/common/orpc/schemas/agentSkill";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { MCPPromptDescriptor } from "@/common/orpc/schemas/mcp";
import { isMcpPromptCommandKey } from "@/common/utils/tools/mcpToolName";
import type { ParsedRuntime } from "@/common/types/runtime";
import {
  buildAgentSkillMetadata,
  dedupeAgentSkillRefs,
  dedupeMcpPromptRefs,
  type AgentSkillReference,
  type MCPPromptReference,
  type MuxMessageMetadata,
} from "@/common/types/message";
import type { FilePart } from "@/common/orpc/types";
import type { ChatAttachment } from "@/browser/features/ChatInput/ChatAttachments";

export type CreationRuntimeValidationError =
  | { mode: "docker"; kind: "missingImage" }
  | { mode: "ssh"; kind: "missingHost" }
  | { mode: "ssh"; kind: "missingCoderWorkspace" }
  | { mode: "ssh"; kind: "missingCoderTemplate" }
  | { mode: "ssh"; kind: "missingCoderPreset" };

export interface SkillInvocation {
  descriptor: AgentSkillDescriptor;
  userText: string;
  /** Trimmed text after the slash command (e.g. "123 high" for "/fix-issue 123 high"). */
  argumentText: string;
}

export interface MCPPromptInvocation {
  descriptor: MCPPromptDescriptor;
  userText: string;
  arguments: Record<string, string>;
}

function mapPromptArguments(
  descriptor: MCPPromptDescriptor,
  input: string
): { arguments: Record<string, string>; missingRequired?: string } {
  const definitions = descriptor.arguments ?? [];
  const tokens = tokenizeSlashCommandArguments(input);
  const values: Record<string, string> = {};
  for (const [index, definition] of definitions.entries()) {
    const value =
      index === definitions.length - 1 ? tokens.slice(index).join(" ") : (tokens[index] ?? "");
    if (!value) {
      if (definition.required) return { arguments: values, missingRequired: definition.name };
      continue;
    }
    values[definition.name] = value;
  }
  return { arguments: values };
}

export type SkillResolutionTarget =
  | { kind: "project"; projectPath: string }
  | { kind: "workspace"; workspaceId: string; disableWorkspaceAgents?: boolean };

type UnknownSlashCommand = Extract<ParsedCommand, { type: "unknown-command" }>;

function isUnknownSlashCommand(value: ParsedCommand): value is UnknownSlashCommand {
  return value !== null && value.type === "unknown-command";
}

export function buildSkillInvocationMetadata(
  rawCommand: string,
  descriptor: AgentSkillDescriptor,
  argumentText: string
): MuxMessageMetadata {
  return buildAgentSkillMetadata({
    rawCommand,
    commandPrefix: `/${descriptor.name}`,
    skillName: descriptor.name,
    scope: descriptor.scope,
    arguments: argumentText,
  });
}

/**
 * Format user message text for skill invocation.
 * Makes it explicit to the model that a skill was invoked.
 */
function formatSkillInvocationText(skillName: string, userMessage: string): string {
  return userMessage ? `Using skill ${skillName}: ${userMessage}` : `Use skill ${skillName}`;
}

async function loadMcpPromptDescriptors(options: {
  descriptors: MCPPromptDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
  commandKeys: string[];
}): Promise<MCPPromptDescriptor[] | null> {
  const hasAllDescriptors = options.commandKeys.every((commandKey) =>
    options.descriptors.some((descriptor) => descriptor.commandKey === commandKey)
  );
  if (hasAllDescriptors || !options.api || options.discovery?.kind !== "workspace") {
    return options.descriptors;
  }

  try {
    return await options.api.workspace.mcp.prompts.list({
      workspaceId: options.discovery.workspaceId,
    });
  } catch {
    return null;
  }
}

async function resolveMcpPromptInvocation(options: {
  messageText: string;
  parsed: ParsedCommand;
  descriptors: MCPPromptDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
}): Promise<{ invocation: MCPPromptInvocation | null; error?: string }> {
  if (!isUnknownSlashCommand(options.parsed) || !isMcpPromptCommandKey(options.parsed.command)) {
    return { invocation: null };
  }

  const command = options.parsed.command;
  const prefix = `/${command}`;
  const afterPrefix = options.messageText.slice(prefix.length);
  if (afterPrefix.length > 0 && !/^\s/.test(afterPrefix)) return { invocation: null };

  const descriptors = await loadMcpPromptDescriptors({
    descriptors: options.descriptors,
    api: options.api,
    discovery: options.discovery,
    commandKeys: [command],
  });
  const descriptor = descriptors?.find((candidate) => candidate.commandKey === command);
  if (!descriptor) return { invocation: null };

  const mapped = mapPromptArguments(descriptor, afterPrefix.trim());
  if (mapped.missingRequired) {
    return {
      invocation: null,
      error: `Missing required MCP prompt argument: ${mapped.missingRequired}`,
    };
  }
  const argumentText = afterPrefix.trimStart();
  return {
    invocation: {
      descriptor,
      userText: argumentText
        ? `Using MCP prompt ${descriptor.serverName}/${descriptor.promptName}: ${argumentText}`
        : `Using MCP prompt ${descriptor.serverName}/${descriptor.promptName}`,
      arguments: mapped.arguments,
    },
  };
}

async function resolveSkillInvocation(options: {
  messageText: string;
  parsed: ParsedCommand;
  agentSkillDescriptors: AgentSkillDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
}): Promise<SkillInvocation | null> {
  if (!isUnknownSlashCommand(options.parsed)) {
    return null;
  }

  const command = options.parsed.command;
  const prefix = `/${command}`;
  const afterPrefix = options.messageText.slice(prefix.length);
  const hasSeparator = afterPrefix.length === 0 || /^\s/.test(afterPrefix);

  if (!hasSeparator) {
    return null;
  }

  // user-invocable: false skills must be treated as nonexistent for typed /skill-name
  // invocation (they remain model-invocable via agent_skill_read).
  let skill: AgentSkillDescriptor | undefined = options.agentSkillDescriptors.find(
    (candidate) => candidate.name === command && candidate.userInvocable !== false
  );

  if (!skill && options.api && options.discovery) {
    try {
      const pkg =
        options.discovery.kind === "project"
          ? await options.api.agentSkills.get({
              projectPath: options.discovery.projectPath,
              skillName: command,
            })
          : await options.api.agentSkills.get({
              workspaceId: options.discovery.workspaceId,
              disableWorkspaceAgents: options.discovery.disableWorkspaceAgents,
              skillName: command,
            });
      // The remote fallback fetches raw frontmatter, so apply the same user-invocability
      // gate the local descriptor list already carries in normalized form.
      if (resolveSkillUserInvocable(pkg.frontmatter) !== false) {
        skill = {
          name: pkg.frontmatter.name,
          description: pkg.frontmatter.description,
          scope: pkg.scope,
        };
      }
    } catch {
      // Not a skill (or not available yet) - fall through.
    }
  }

  if (!skill) {
    return null;
  }

  return {
    descriptor: skill,
    userText: formatSkillInvocationText(skill.name, afterPrefix.trimStart()),
    argumentText: afterPrefix.trim(),
  };
}

export async function parseCommandWithSkillInvocation(options: {
  messageText: string;
  agentSkillDescriptors: AgentSkillDescriptor[];
  mcpPromptDescriptors?: MCPPromptDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
}): Promise<{
  parsed: ParsedCommand;
  skillInvocation: SkillInvocation | null;
  mcpPromptInvocation: MCPPromptInvocation | null;
  error?: string;
}> {
  const parsed = parseCommand(options.messageText);
  const promptResolution = await resolveMcpPromptInvocation({
    messageText: options.messageText,
    parsed,
    descriptors: options.mcpPromptDescriptors ?? [],
    api: options.api,
    discovery: options.discovery,
  });
  if (promptResolution.invocation || promptResolution.error) {
    return {
      parsed: promptResolution.invocation ? null : parsed,
      skillInvocation: null,
      mcpPromptInvocation: promptResolution.invocation,
      ...(promptResolution.error ? { error: promptResolution.error } : {}),
    };
  }

  const skillInvocation = await resolveSkillInvocation({
    messageText: options.messageText,
    parsed,
    agentSkillDescriptors: options.agentSkillDescriptors,
    api: options.api,
    discovery: options.discovery,
  });

  return {
    parsed: skillInvocation == null ? parsed : null,
    skillInvocation,
    mcpPromptInvocation: null,
  };
}

/**
 * Resolve inline `$skill` references found in the user's authored message text.
 *
 * - Parses `$skill` candidates from the original user text (not the slash-rewritten userText),
 *   so a mixed `/deep-review Please also follow $tdd` finds both refs.
 * - When `slashInvocation` is provided, its skill is included as a `source: "slash"` ref;
 *   it remains first in the returned list and wins on dedupe (same name → drop inline duplicate).
 * - Inline refs that don't resolve are silently dropped.
 * - Output is deduped (first-appearance wins; slash beats inline). Empty array when there are none.
 */
export async function resolveInlineSkillRefsForSend(options: {
  messageText: string;
  slashInvocation: SkillInvocation | null;
  agentSkillDescriptors: AgentSkillDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
  candidates?: InlineSkillCandidate[];
}): Promise<AgentSkillReference[]> {
  const refs: AgentSkillReference[] = [];

  if (options.slashInvocation) {
    const descriptor = options.slashInvocation.descriptor;
    refs.push({ skillName: descriptor.name, scope: descriptor.scope, source: "slash" });
  }

  const candidates = (
    options.candidates ?? extractInlineSkillReferenceCandidates(options.messageText)
  ).filter((candidate) => !isMcpPromptCommandKey(candidate.skillName));
  if (candidates.length > 0) {
    const inlineRefs = await resolveInlineSkillReferences({
      candidates,
      agentSkillDescriptors: options.agentSkillDescriptors,
      api: options.api,
      discovery: options.discovery,
    });
    refs.push(...inlineRefs);
  }

  return dedupeAgentSkillRefs(refs);
}

export async function resolveMcpPromptRefsForSend(options: {
  messageText: string;
  slashInvocation: MCPPromptInvocation | null;
  descriptors: MCPPromptDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
  candidates?: InlineSkillCandidate[];
}): Promise<MCPPromptReference[]> {
  const refs: MCPPromptReference[] = [];
  if (options.slashInvocation) {
    const invocation = options.slashInvocation;
    refs.push({
      serverName: invocation.descriptor.serverName,
      promptName: invocation.descriptor.promptName,
      commandKey: invocation.descriptor.commandKey,
      source: "slash",
      arguments: invocation.arguments,
    });
  }

  const candidates = (
    options.candidates ?? extractInlineSkillReferenceCandidates(options.messageText)
  ).filter((candidate) => isMcpPromptCommandKey(candidate.skillName));
  if (candidates.length === 0) return refs;

  const descriptors = await loadMcpPromptDescriptors({
    descriptors: options.descriptors,
    api: options.api,
    discovery: options.discovery,
    commandKeys: candidates.map((candidate) => candidate.skillName),
  });
  if (!descriptors) return refs;

  for (const candidate of candidates) {
    const prompt = descriptors.find(
      (descriptor) =>
        descriptor.commandKey === candidate.skillName &&
        !(descriptor.arguments ?? []).some((argument) => argument.required)
    );
    if (!prompt) continue;
    refs.push({
      serverName: prompt.serverName,
      promptName: prompt.promptName,
      commandKey: prompt.commandKey,
      source: "inline",
    });
  }
  return dedupeMcpPromptRefs(refs);
}

/** Returns true when any ref's scope is "project" (used by creation flow to force disableWorkspaceAgents). */
export function hasProjectScopedSkillRef(refs: AgentSkillReference[]): boolean {
  return refs.some((ref) => ref.scope === "project");
}

export function validateCreationRuntime(
  runtime: ParsedRuntime,
  coderPresetCount: number
): CreationRuntimeValidationError | null {
  if (runtime.mode === "docker") {
    return runtime.image.trim() ? null : { mode: "docker", kind: "missingImage" };
  }

  if (runtime.mode === "ssh") {
    if (runtime.coder) {
      if (runtime.coder.existingWorkspace) {
        // Existing mode: workspace name is required
        if (!(runtime.coder.workspaceName ?? "").trim()) {
          return { mode: "ssh", kind: "missingCoderWorkspace" };
        }
      } else {
        // New mode: template is required
        if (!(runtime.coder.template ?? "").trim()) {
          return { mode: "ssh", kind: "missingCoderTemplate" };
        }
        // Preset required when 2+ presets exist
        const requiresPreset = coderPresetCount >= 2;
        if (requiresPreset && !(runtime.coder.preset ?? "").trim()) {
          return { mode: "ssh", kind: "missingCoderPreset" };
        }
      }
      return null;
    }

    return runtime.host.trim() ? null : { mode: "ssh", kind: "missingHost" };
  }

  return null;
}

export function filePartsToChatAttachments(
  fileParts: FilePart[],
  idPrefix: string
): ChatAttachment[] {
  return fileParts.map((part, index) => ({
    kind: "provider",
    id: `${idPrefix}-${index}`,
    url: part.url,
    mediaType: part.mediaType,
    filename: part.filename,
  }));
}
