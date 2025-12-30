import { z } from "zod";

export const AgentDefinitionScopeSchema = z.enum(["built-in", "project", "global"]);

// Agent IDs come from filenames (<agentId>.md).
// Keep constraints conservative so IDs are safe to use in storage keys, URLs, etc.
export const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/);

const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh"]);

const AgentDefinitionUiSchema = z
  .object({
    // New: hidden is opt-out. Default: visible.
    hidden: z.boolean().optional(),

    // Legacy: selectable was opt-in. Keep for backwards compatibility.
    selectable: z.boolean().optional(),

    // When true, completely hides this agent (useful for disabling built-ins)
    disabled: z.boolean().optional(),

    // UI color (CSS color value). Inherited from base agent if not specified.
    color: z.string().min(1).optional(),
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

export const AgentDefinitionFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(1024).optional(),

    // Inheritance: reference a built-in or custom agent ID
    base: AgentIdSchema.optional(),

    // UI metadata (color, visibility, etc.)
    ui: AgentDefinitionUiSchema.optional(),

    subagent: AgentDefinitionSubagentSchema.optional(),
    ai: AgentDefinitionAiDefaultsSchema.optional(),

    // Tool whitelist: regex patterns. If omitted, no tools are available.
    tools: z.array(z.string().min(1)).optional(),
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
    // Base agent ID for inheritance (e.g., "exec", "plan", or custom agent)
    base: AgentIdSchema.optional(),
    aiDefaults: AgentDefinitionAiDefaultsSchema.optional(),
    // Tool whitelist patterns (for UI display)
    tools: z.array(z.string().min(1)).optional(),
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
