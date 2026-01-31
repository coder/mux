import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import { parseCommand } from "@/browser/utils/slashCommands/parser";
import type { APIClient } from "@/browser/contexts/API";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type { SendMessageError } from "@/common/types/errors";
import type { ParsedRuntime } from "@/common/types/runtime";
import {
  buildAgentSkillMetadata,
  buildAgentSkillSetMetadata,
  type MuxFrontendMetadata,
} from "@/common/types/message";
import type { FilePart } from "@/common/orpc/types";
import type { ChatAttachment } from "../ChatAttachments";
import type { Review } from "@/common/types/review";

/**
 * Extract error message from SendMessageError or string
 * Handles both string errors and structured error objects
 */
export function extractErrorMessage(error: SendMessageError | string): string {
  if (typeof error === "string") {
    return error;
  }
  return "raw" in error ? error.raw : error.type;
}

// -----------------------------------------------------------------------------
// Skill Invocation Helpers
// -----------------------------------------------------------------------------

export type CreationRuntimeValidationError =
  | { mode: "docker"; kind: "missingImage" }
  | { mode: "ssh"; kind: "missingHost" }
  | { mode: "ssh"; kind: "missingCoderWorkspace" }
  | { mode: "ssh"; kind: "missingCoderTemplate" }
  | { mode: "ssh"; kind: "missingCoderPreset" };

export interface SkillInvocation {
  descriptor: AgentSkillDescriptor;
  userText: string;
}

export type SkillResolutionTarget =
  | { kind: "project"; projectPath: string }
  | { kind: "workspace"; workspaceId: string; disableWorkspaceAgents?: boolean };

// Unknown slash commands are used for agent-skill invocations (/{skillName} ...).
type UnknownSlashCommand = Extract<ParsedCommand, { type: "unknown-command" }>;

function isUnknownSlashCommand(value: ParsedCommand): value is UnknownSlashCommand {
  return value !== null && value.type === "unknown-command";
}

export function buildSkillInvocationMetadata(
  rawCommand: string,
  descriptor: AgentSkillDescriptor
): MuxFrontendMetadata {
  return buildAgentSkillMetadata({
    rawCommand,
    commandPrefix: `/${descriptor.name}`,
    skillName: descriptor.name,
    scope: descriptor.scope,
  });
}

export function buildHashSkillInvocationMetadata(
  rawCommand: string,
  descriptors: AgentSkillDescriptor[],
  mentions: Array<{ name: string }>
): MuxFrontendMetadata | undefined {
  const descriptorByName = new Map(descriptors.map((d) => [d.name.toLowerCase(), d] as const));

  const skills: Array<{ skillName: string; scope: AgentSkillDescriptor["scope"] }> = [];
  const seen = new Set<string>();

  for (const mention of mentions) {
    const key = mention.name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    const descriptor = descriptorByName.get(key);
    if (!descriptor) {
      continue;
    }
    seen.add(key);
    skills.push({ skillName: descriptor.name, scope: descriptor.scope });
  }

  if (skills.length === 0) {
    return undefined;
  }

  return buildAgentSkillSetMetadata({ rawCommand, skills });
}

/**
 * Format user message text for skill invocation.
 * Makes it explicit to the model that a skill was invoked.
 */
function formatSkillInvocationText(skillName: string, userMessage: string): string {
  return userMessage ? `Using skill ${skillName}: ${userMessage}` : `Use skill ${skillName}`;
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

  let skill: AgentSkillDescriptor | undefined = options.agentSkillDescriptors.find(
    (candidate) => candidate.name === command
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
      skill = {
        name: pkg.frontmatter.name,
        description: pkg.frontmatter.description,
        scope: pkg.scope,
      };
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
  };
}

export async function parseCommandWithSkillInvocation(options: {
  messageText: string;
  agentSkillDescriptors: AgentSkillDescriptor[];
  api: APIClient | null;
  discovery: SkillResolutionTarget | null;
}): Promise<{ parsed: ParsedCommand; skillInvocation: SkillInvocation | null }> {
  const parsed = parseCommand(options.messageText);
  const skillInvocation = await resolveSkillInvocation({
    messageText: options.messageText,
    parsed,
    agentSkillDescriptors: options.agentSkillDescriptors,
    api: options.api,
    discovery: options.discovery,
  });

  return { parsed: skillInvocation ? null : parsed, skillInvocation };
}

// -----------------------------------------------------------------------------
// Runtime Validation
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Attachment Conversion Helpers
// -----------------------------------------------------------------------------

export function filePartsToChatAttachments(
  fileParts: FilePart[],
  idPrefix: string
): ChatAttachment[] {
  return fileParts.map((part, index) => ({
    id: `${idPrefix}-${index}`,
    url: part.url,
    mediaType: part.mediaType,
    filename: part.filename,
  }));
}

// -----------------------------------------------------------------------------
// Review Helpers
// -----------------------------------------------------------------------------

/**
 * Extract review data from attached reviews for sending.
 * Returns undefined if no reviews attached.
 */
export function getReviewData(reviews: Review[]): Array<Review["data"]> | undefined {
  return reviews.length > 0 ? reviews.map((r) => r.data) : undefined;
}

/**
 * Extract review IDs from attached reviews.
 */
export function getReviewIds(reviews: Review[]): string[] {
  return reviews.map((r) => r.id);
}
