/**
 * Terminal session types
 */

import type { z } from "zod";
import type {
  TerminalCreateParamsSchema,
  TerminalResizeParamsSchema,
  TerminalSessionSchema,
} from "../orpc/schemas";

export type TerminalSession = z.infer<typeof TerminalSessionSchema>;
export type TerminalCreateParams = z.infer<typeof TerminalCreateParamsSchema>;
export type TerminalResizeParams = z.infer<typeof TerminalResizeParamsSchema>;
