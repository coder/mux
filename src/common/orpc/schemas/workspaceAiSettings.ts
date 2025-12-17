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
