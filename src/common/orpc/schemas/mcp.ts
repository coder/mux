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

export const MCPTestParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string(),
});

export const MCPTestResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), tools: z.array(z.string()) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);
