import { z } from "zod";

export const MCPServerMapSchema = z.record(z.string(), z.string());

export const MCPAddParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string(),
  command: z.string(),
});

export const MCPRemoveParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string(),
});

/**
 * Unified test params - provide either name (to test configured server) or command (to test arbitrary command).
 * At least one of name or command must be provided.
 */
export const MCPTestParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string().optional(),
  command: z.string().optional(),
});

export const MCPTestResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), tools: z.array(z.string()) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);
