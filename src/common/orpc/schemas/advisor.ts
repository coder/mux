import { z } from "zod";

import { AgentIdSchema } from "@/common/schemas/ids";
import { ThinkingLevelSchema } from "@/common/types/thinking";

/**
 * Advisor name format.
 *
 * Identical regex to SkillNameSchema (kebab-case, 1-64 chars) because advisors
 * graduate from the same `.mux/<category>/<name>/<UPPERCASE>.md` pattern as
 * skills. Keeping the format identical lets users carry mental models between
 * the two surfaces without surprise.
 */
export const AdvisorNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const AdvisorScopeSchema = z.enum(["project", "global"]);

/**
 * YAML frontmatter shape for `<root>/advisors/<name>/ADVISOR.md`.
 *
 * Required:
 * - `description` — single-line "use for X" string. Joins the tool description
 *   so the model knows when to pick this advisor.
 * - `model` — canonical "provider:model" model string (e.g. "anthropic:claude-opus-4-5").
 *
 * Optional knobs are intentionally bounded to the same per-call budgets the
 * pre-GA global config exposed, so an individual advisor can tune cost without
 * touching `~/.mux/config.json`.
 */
export const AdvisorFrontmatterSchema = z.object({
  description: z.string().min(1).max(1024),
  model: z.string().min(1).max(256),
  thinking: ThinkingLevelSchema.optional(),
  max_uses_per_turn: z.number().int().positive().nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  /**
   * Restrict this advisor to a subset of agents. Empty/omitted = available to
   * every agent that has the advisor tool in its policy allowlist.
   *
   * Validated as `AgentIdSchema` strings; advisors targeting an agent that
   * does not exist locally are loaded but never surfaced (the filter is the
   * effective agent at stream time, not registration).
   */
  agents: z.array(AgentIdSchema).optional(),
});

/**
 * Public descriptor (no body, no secrets) exposed to the renderer for
 * `/advisor` listing and for the tool-description injection on the backend.
 */
export const AdvisorDescriptorSchema = z.object({
  name: AdvisorNameSchema,
  description: z.string().min(1).max(1024),
  scope: AdvisorScopeSchema,
  model: z.string().min(1).max(256),
  thinking: ThinkingLevelSchema.optional(),
  agents: z.array(AgentIdSchema).optional(),
  /** Absolute or runtime-relative path to the ADVISOR.md source file. */
  sourcePath: z.string().min(1),
});

/** Full loaded advisor package (frontmatter + body) — used by the tool executor. */
export const AdvisorPackageSchema = z.object({
  scope: AdvisorScopeSchema,
  directoryName: AdvisorNameSchema,
  frontmatter: AdvisorFrontmatterSchema,
  body: z.string(),
  sourcePath: z.string().min(1),
});

/** Diagnostics shape for malformed ADVISOR.md files (kept loadable, surfaced inline). */
export const AdvisorIssueSchema = z.object({
  directoryName: z.string().min(1),
  scope: AdvisorScopeSchema,
  displayPath: z.string().min(1),
  message: z.string().min(1),
  hint: z.string().min(1).optional(),
});
