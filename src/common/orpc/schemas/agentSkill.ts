import { z } from "zod";

export const AgentSkillScopeSchema = z.enum(["project", "global"]);

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

/**
 * Glob pattern for include_files.
 * Patterns must be relative (no absolute paths, no ~, no ..).
 */
export const IncludeFileGlobSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (pattern) =>
      !pattern.startsWith("/") &&
      !pattern.startsWith("~") &&
      !pattern.includes("..") &&
      !/^[A-Za-z]:[\\/]/.test(pattern),
    { message: "Pattern must be relative (no absolute paths, ~, or ..)" }
  );

export const AgentSkillFrontmatterSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  /**
   * Glob patterns for files to automatically include in context when the skill is read.
   * Patterns are relative to the skill directory (where SKILL.md lives).
   * Example: ["examples/*.ts", "schemas/**\/*.json"]
   */
  include_files: z.array(IncludeFileGlobSchema).max(20).optional(),
});

export const AgentSkillDescriptorSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  scope: AgentSkillScopeSchema,
});

/**
 * Resolved file from include_files expansion.
 */
export const IncludedFileSchema = z.object({
  /** Path relative to skill directory */
  path: z.string(),
  /** File content (may be truncated) */
  content: z.string(),
  /** Whether content was truncated due to size/line limits */
  truncated: z.boolean(),
});

/**
 * Context representation for files included via include_files.
 * Rendered as XML using the `<@path>` tag format.
 */
export const IncludeFilesContextSchema = z.object({
  /** Successfully resolved files */
  files: z.array(IncludedFileSchema),
  /** Patterns/files that had errors during resolution */
  errors: z.array(z.object({ pattern: z.string(), error: z.string() })),
  /** Pre-rendered XML context (for direct injection) */
  rendered: z.string(),
});

export const AgentSkillPackageSchema = z
  .object({
    scope: AgentSkillScopeSchema,
    directoryName: SkillNameSchema,
    frontmatter: AgentSkillFrontmatterSchema,
    body: z.string(),
    /** Resolved include_files context (present when frontmatter.include_files is set) */
    includeFilesContext: IncludeFilesContextSchema.optional(),
  })
  .refine((value) => value.directoryName === value.frontmatter.name, {
    message: "SKILL.md frontmatter.name must match the parent directory name",
    path: ["frontmatter", "name"],
  });
