import { z } from "zod";
import { AgentModeSchema } from "@/common/types/mode";

export const AgentDefinitionScopeSchema = z.enum(["built-in", "project", "global"]);

// Agent IDs come from filenames (<agentId>.md).
// Keep constraints conservative so IDs are safe to use in storage keys, URLs, etc.
export const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/);

const AgentPolicyBaseSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  AgentModeSchema
);

const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh"]);

const PermissionModeSchema = z.enum(["default", "readOnly"]);

const AgentDefinitionUiSchema = z
  .object({
    // New: hidden is opt-out. Default: visible.
    hidden: z.boolean().optional(),

    // Legacy: selectable was opt-in. Keep for backwards compatibility.
    selectable: z.boolean().optional(),

    // When true, completely hides this agent (useful for disabling built-ins)
    disabled: z.boolean().optional(),
  })
  .strip();

const AgentDefinitionSubagentSchema = z
  .object({
    runnable: z.boolean().optional(),
  })
  .strip();

const AgentDefinitionAiDefaultsSchema = z
  .object({
    modelString: z.string().min(1).optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
  })
  .strip();

const AgentDefinitionToolFilterSchema = z
  .object({
    deny: z.array(z.string().min(1)).optional(),
    only: z.array(z.string().min(1)).optional(),
  })
  .strip()
  .superRefine((value, ctx) => {
    const hasDeny = Array.isArray(value.deny) && value.deny.length > 0;
    const hasOnly = Array.isArray(value.only) && value.only.length > 0;

    if (hasDeny && hasOnly) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "policy.tools must specify exactly one of deny or only",
        path: ["deny"],
      });
      return;
    }
  });

const AgentDefinitionPolicySchema = z
  .object({
    base: AgentPolicyBaseSchema.optional(),
    tools: AgentDefinitionToolFilterSchema.optional(),
  })
  .strip();

export const AgentDefinitionFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(1024).optional(),

    // UI metadata
    color: z.string().min(1).optional(),
    ui: AgentDefinitionUiSchema.optional(),

    subagent: AgentDefinitionSubagentSchema.optional(),
    ai: AgentDefinitionAiDefaultsSchema.optional(),
    policy: AgentDefinitionPolicySchema.optional(),

    // Tool policy presets + tweaks
    permissionMode: PermissionModeSchema.optional(),
    tools: z.array(z.string().min(1)).optional(),
    disallowedTools: z.array(z.string().min(1)).optional(),
  })
  .strip();

export const AgentDefinitionDescriptorSchema = z
  .object({
    id: AgentIdSchema,
    scope: AgentDefinitionScopeSchema,
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(1024).optional(),
    uiSelectable: z.boolean(),
    uiColor: z.string().min(1).optional(),
    subagentRunnable: z.boolean(),
    policyBase: AgentModeSchema,
    aiDefaults: AgentDefinitionAiDefaultsSchema.optional(),
    // Raw tool filter metadata (for UI display). Runtime validates tool names.
    toolFilter: AgentDefinitionToolFilterSchema.optional(),
  })
  .strict();

export const AgentDefinitionPackageSchema = z
  .object({
    id: AgentIdSchema,
    scope: AgentDefinitionScopeSchema,
    frontmatter: AgentDefinitionFrontmatterSchema,
    body: z.string(),
  })
  .strict();
