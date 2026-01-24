import { z } from "zod";

/**
 * Workspace-scoped AI settings that should persist across devices.
 *
 * Notes:
 * - `model` must be canonical "provider:model" (NOT mux-gateway:provider/model).
 * - `thinkingLevel` is workspace-scoped (saved per workspace, not per-model).
 */

export const WorkspaceAISettingsSchema = z.object({
  model: z.string().meta({ description: 'Canonical model id in the form "provider:model"' }),
  thinkingLevel: z.enum(["off", "low", "medium", "high", "xhigh"]).meta({
    description: "Thinking/reasoning effort level",
  }),
});

/**
 * Per-agent workspace AI overrides.
 *
 * Notes:
 * - Keys are agent IDs (plan/exec/custom), values are model + thinking overrides.
 */
export const WorkspaceAISettingsByAgentSchema = z.record(
  z.string().min(1),
  WorkspaceAISettingsSchema
);

/**
 * Legacy per-mode workspace AI overrides (plan/exec).
 *
 * Notes:
 * - Only includes UI modes (plan/exec). Compact is intentionally excluded.
 */
export const WorkspaceAISettingsByModeSchema = z
  .object({
    plan: WorkspaceAISettingsSchema.optional(),
    exec: WorkspaceAISettingsSchema.optional(),
  })
  .strict();
