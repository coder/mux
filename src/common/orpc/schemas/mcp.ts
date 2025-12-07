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
