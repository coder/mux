import { z } from "zod";

/**
 * UI Mode types
 */

export const UIModeSchema = z.enum(["plan", "exec"]);
export type UIMode = z.infer<typeof UIModeSchema>;
