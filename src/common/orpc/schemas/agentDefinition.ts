import { z } from "zod";

export const AgentDefinitionScopeSchema = z.enum(["built-in", "project", "global"]);

// Agent IDs come from filenames (<agentId>.md).
// Keep constraints conservative so IDs are safe to use in storage keys, URLs, etc.
export const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/);

const AgentDefinitionUiRequirementSchema = z.enum(["plan"]);
const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);

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

    // Requirements for this agent to be selectable in the UI.
    // Enforced in agents.list by toggling uiSelectable.
    requires: z.array(AgentDefinitionUiRequirementSchema).min(1).optional(),
  })
  .strip();

const AgentDefinitionSubagentSchema = z
  .object({
    runnable: z.boolean().optional(),
    // Instructions appended when this agent runs as a subagent (child workspace)
    append_prompt: z.string().min(1).optional(),
    // When true, do not run the project's .mux/init hook for this sub-agent.
    // NOTE: This skips only the hook execution, not runtime provisioning (e.g. SSH sync, Docker setup).
    skip_init_hook: z.boolean().optional(),
  })
  .strip();

const AgentDefinitionAiDefaultsSchema = z
  .object({
    // Model identifier: full string (e.g. "anthropic:claude-sonnet-4-5") or abbreviation (e.g. "sonnet")
    model: z.string().min(1).optional(),
    thinkingLevel: ThinkingLevelSchema.optional(),
  })
  .strip();

const AgentDefinitionPromptSchema = z
  .object({
    // When true, append this agent's body to the base agent's body (default: false = replace)
    append: z.boolean().optional(),
  })
  .strip();

// Tool configuration:
// - add/remove are regex patterns
// - require is a concrete tool name (single-tool require semantics)
// Layers are processed in order during inheritance (base first, then child).
const AgentDefinitionToolsSchema = z
  .object({
    // Patterns to add (enable). Processed before remove and require.
    add: z.array(z.string().min(1)).optional(),
    // Patterns to remove (disable). Processed after add.
    remove: z.array(z.string().min(1)).optional(),
    // Tool names to require (last entry wins). Processed after add/remove so agents
    // can force a single concrete tool for this turn.
    require: z.array(z.string().min(1)).optional(),
  })
  .strip();

export const AgentDefinitionFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(1024).optional(),

    // Inheritance: reference a built-in or custom agent ID
    base: AgentIdSchema.optional(),

    // When true, this agent is disabled by default.
    //
    // Notes:
    // - This is a top-level flag (separate from ui.disabled) so repos can ship agents that are
    //   present on disk but opt-in.
    // - When both are set, `disabled` takes precedence over `ui.disabled`.
    disabled: z.boolean().optional(),

    // UI metadata (color, visibility, etc.)
    ui: AgentDefinitionUiSchema.optional(),

    // Prompt behavior configuration
    prompt: AgentDefinitionPromptSchema.optional(),

    subagent: AgentDefinitionSubagentSchema.optional(),

    ai: AgentDefinitionAiDefaultsSchema.optional(),

    // Tool configuration: add/remove/require patterns (regex).
    // If omitted and no base, no tools are available.
    tools: AgentDefinitionToolsSchema.optional(),
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
    // Tool configuration (for UI display / inheritance computation)
    tools: AgentDefinitionToolsSchema.optional(),
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
