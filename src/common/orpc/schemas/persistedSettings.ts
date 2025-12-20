import { z } from "zod";
import { ThinkingLevelSchema } from "./workspaceAiSettings";

export const PersistedSettingsSchema = z
  .object({
    ai: z
      .object({
        thinkingLevelByModel: z.record(z.string(), ThinkingLevelSchema).optional(),
      })
      .optional(),
    projectDefaults: z
      .record(
        z.string(),
        z
          .object({
            model: z.string().optional(),
            mode: z.enum(["plan", "exec"]).optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();
