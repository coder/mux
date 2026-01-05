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
});

export const AgentSkillDescriptorSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  scope: AgentSkillScopeSchema,
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
