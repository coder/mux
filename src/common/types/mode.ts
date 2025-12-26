import { z } from "zod";

/**
 * UI Mode types - now extensible via mode definition files.
 * Built-in modes are "exec" and "plan", but users can define custom modes.
 */

/** Backwards compat: the original enum for built-in modes */
export const BuiltinModeSchema = z.enum(["plan", "exec"]);
export type BuiltinMode = z.infer<typeof BuiltinModeSchema>;

/** UIMode is now a string to support custom modes */
export const UIModeSchema = z.string().min(1).max(64);
export type UIMode = z.infer<typeof UIModeSchema>;

/** Source of a mode definition */
export const ModeSourceSchema = z.enum(["builtin", "global", "project"]);
export type ModeSource = z.infer<typeof ModeSourceSchema>;

/** Tool policy entry for a mode */
export const ModeToolPolicyEntrySchema = z.object({
  regex: z.string(),
  action: z.enum(["enable", "disable"]),
});
export type ModeToolPolicyEntry = z.infer<typeof ModeToolPolicyEntrySchema>;

/** File restrictions for a mode */
export const ModeFileRestrictionsSchema = z.object({
  onlyPlanFile: z.boolean().optional(),
});
export type ModeFileRestrictions = z.infer<typeof ModeFileRestrictionsSchema>;

/** Sub-agent restrictions for a mode */
export const ModeSubagentRestrictionsSchema = z.object({
  allowedTypes: z.array(z.enum(["exec", "explore"])).optional(),
});
export type ModeSubagentRestrictions = z.infer<typeof ModeSubagentRestrictionsSchema>;

/** Frontmatter schema for mode definition files */
export const ModeFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  label: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  icon: z.string().max(8).optional(),
  color: z.string().max(64).optional(),
  disabled: z.boolean().optional(),
  toolPolicy: z.array(ModeToolPolicyEntrySchema).optional(),
  exclusiveTools: z.array(z.string()).optional(),
  fileRestrictions: ModeFileRestrictionsSchema.optional(),
  subagentRestrictions: ModeSubagentRestrictionsSchema.optional(),
});
export type ModeFrontmatter = z.infer<typeof ModeFrontmatterSchema>;

/** Full mode definition including parsed markdown body and metadata */
export const ModeDefinitionSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  disabled: z.boolean().optional(),
  toolPolicy: z.array(ModeToolPolicyEntrySchema).optional(),
  exclusiveTools: z.array(z.string()).optional(),
  fileRestrictions: ModeFileRestrictionsSchema.optional(),
  subagentRestrictions: ModeSubagentRestrictionsSchema.optional(),
  instructions: z.string(),
  source: ModeSourceSchema,
  filePath: z.string(),
});
export type ModeDefinition = z.infer<typeof ModeDefinitionSchema>;
