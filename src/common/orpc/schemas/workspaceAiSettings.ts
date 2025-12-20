import { z } from "zod";

/**
 * AI settings that should persist across devices.
 *
 * Notes:
 * - `model` must be canonical "provider:model" (NOT mux-gateway:provider/model).
 * - `thinkingLevel` is per-model on the frontend (global). Backend stores the
 *   last-used level per workspace to seed new devices.
 */
export const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh"]).meta({
  description: "Thinking/reasoning effort level",
});

export const WorkspaceAISettingsSchema = z.object({
  model: z.string().meta({ description: 'Canonical model id in the form "provider:model"' }),
  thinkingLevel: ThinkingLevelSchema,
});
