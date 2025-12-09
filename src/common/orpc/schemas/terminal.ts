import { z } from "zod";

export const TerminalSessionSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  cols: z.number(),
  rows: z.number(),
});

export const TerminalCreateParamsSchema = z.object({
  workspaceId: z.string(),
  cols: z.number(),
  rows: z.number(),
  /** Optional command to run immediately after terminal creation */
  initialCommand: z.string().optional(),
});

export const TerminalResizeParamsSchema = z.object({
  sessionId: z.string(),
  cols: z.number(),
  rows: z.number(),
});
