import { z } from "zod";

export const TaskSettingsSchema = z.object({
  maxParallelAgentTasks: z
    .number()
    .int()
    .min(1)
    .max(10)
    .meta({ description: "Maximum number of parallel agent tasks across the app." }),
  maxTaskNestingDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .meta({ description: "Maximum allowed nesting depth for agent tasks." }),
});

export type TaskSettings = z.infer<typeof TaskSettingsSchema>;
