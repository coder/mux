import assert from "@/common/utils/assert";
import { MAX_AGENT_SKILL_SNAPSHOT_CHARS } from "@/common/constants/attachments";
import type { AgentSkillScope } from "@/common/types/agentSkill";

export const AGENT_SKILL_BODY_TRUNCATION_NOTE = `\n\n[Skill body truncated to ${MAX_AGENT_SKILL_SNAPSHOT_CHARS} characters]`;

const MAX_NORMALIZED_AGENT_SKILL_BODY_CHARS =
  MAX_AGENT_SKILL_SNAPSHOT_CHARS + AGENT_SKILL_BODY_TRUNCATION_NOTE.length;

export function isNormalizedAgentSkillBodyTruncated(body: string): boolean {
  assert(typeof body === "string", "isNormalizedAgentSkillBodyTruncated requires a string body");
  return body.endsWith(AGENT_SKILL_BODY_TRUNCATION_NOTE);
}

export function normalizeAgentSkillSnapshotBody(
  body: string,
  options?: { alreadyNormalized?: boolean; truncated?: boolean }
): { body: string; truncated: boolean } {
  assert(typeof body === "string", "normalizeAgentSkillSnapshotBody requires a string body");

  if (options?.alreadyNormalized === true) {
    const inferredTruncated =
      options.truncated === true || isNormalizedAgentSkillBodyTruncated(body) || false;

    if (
      body.length <= MAX_AGENT_SKILL_SNAPSHOT_CHARS ||
      (inferredTruncated && body.length <= MAX_NORMALIZED_AGENT_SKILL_BODY_CHARS)
    ) {
      return { body, truncated: inferredTruncated };
    }
  }

  if (body.length <= MAX_AGENT_SKILL_SNAPSHOT_CHARS) {
    return { body, truncated: false };
  }

  return {
    body: `${body.slice(0, MAX_AGENT_SKILL_SNAPSHOT_CHARS)}${AGENT_SKILL_BODY_TRUNCATION_NOTE}`,
    truncated: true,
  };
}

export function renderAgentSkillSnapshotText(skill: {
  name: string;
  scope: AgentSkillScope;
  body: string;
}): string {
  assert(typeof skill.name === "string" && skill.name.trim().length > 0, "skill name is required");
  assert(typeof skill.body === "string", "skill body must be a string");
  return `<agent-skill name="${skill.name}" scope="${skill.scope}">\n${skill.body}\n</agent-skill>`;
}

export function extractAgentSkillBodyFromSnapshotText(
  snapshotText: string,
  skill: { name: string; scope: AgentSkillScope }
): string | null {
  assert(
    typeof snapshotText === "string",
    "extractAgentSkillBodyFromSnapshotText requires snapshot text"
  );

  const prefix = `<agent-skill name="${skill.name}" scope="${skill.scope}">\n`;
  const suffix = "\n</agent-skill>";

  if (!snapshotText.startsWith(prefix) || !snapshotText.endsWith(suffix)) {
    return null;
  }

  return snapshotText.slice(prefix.length, snapshotText.length - suffix.length);
}
