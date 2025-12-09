import { z } from "zod";
import { RuntimeConfigSchema } from "./runtime";

export const WorkspaceConfigSchema = z.object({
  path: z.string().meta({
    description: "Absolute path to workspace directory - REQUIRED for backward compatibility",
  }),
  id: z.string().optional().meta({
    description: "Stable workspace ID (10 hex chars for new workspaces) - optional for legacy",
  }),
  name: z.string().optional().meta({
    description: 'Git branch / directory name (e.g., "feature-branch") - optional for legacy',
  }),
  createdAt: z
    .string()
    .optional()
    .meta({ description: "ISO 8601 creation timestamp - optional for legacy" }),
  runtimeConfig: RuntimeConfigSchema.optional().meta({
    description: "Runtime configuration (local vs SSH) - optional, defaults to local",
  }),
});

export const ProjectConfigSchema = z.object({
  workspaces: z.array(WorkspaceConfigSchema),
});
