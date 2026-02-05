import { z } from "zod";

export const AgentSkillScopeSchema = z.enum(["project", "global", "built-in"]);

/**
 * Skill name per agentskills.io
 * - 1–64 chars
 * - lowercase letters/numbers/hyphens
 * - no leading/trailing hyphen
 * - no consecutive hyphens
 */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const AgentSkillFrontmatterSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),

  // When false, skill is NOT listed in the tool description's skill index.
  // Unadvertised skills can still be invoked via /skill-name or agent_skill_read({ name: "skill-name" }).
  // Use for internal orchestration skills, sub-agent-only skills, or power-user workflows.
  advertise: z.boolean().optional(),
});

export const AgentSkillDescriptorSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  scope: AgentSkillScopeSchema,
  advertise: z.boolean().optional(),
});

export const AgentSkillPackageSchema = z
  .object({
    scope: AgentSkillScopeSchema,
    directoryName: SkillNameSchema,
    frontmatter: AgentSkillFrontmatterSchema,
    body: z.string(),
  })
  .refine((value) => value.directoryName === value.frontmatter.name, {
    message: "SKILL.md frontmatter.name must match the parent directory name",
    path: ["frontmatter", "name"],
  });

// Diagnostics (invalid skill discovery)
export const AgentSkillIssueSchema = z.object({
  /** Directory name under the skills root (may be invalid / non-kebab-case). */
  directoryName: z.string().min(1),
  scope: AgentSkillScopeSchema,
  /** User-facing path to the problematic skill (typically .../<dir>/SKILL.md). */
  displayPath: z.string().min(1),
  /** What went wrong while trying to load the skill. */
  message: z.string().min(1),
  /** Optional fix suggestion. */
  hint: z.string().min(1).optional(),
});
