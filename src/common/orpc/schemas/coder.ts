import { z } from "zod";

// Coder workspace config - attached to SSH runtime when using Coder
export const CoderWorkspaceConfigSchema = z.object({
  /**
   * Coder workspace name.
   * - For new workspaces: omit or undefined (backend derives from mux branch name)
   * - For existing workspaces: required (the selected Coder workspace name)
   * - After creation: populated with the actual Coder workspace name for reference
   */
  workspaceName: z.string().optional().meta({ description: "Coder workspace name" }),
  template: z.string().optional().meta({ description: "Template used to create workspace" }),
  preset: z.string().optional().meta({ description: "Preset used during creation" }),
  existingWorkspace: z
    .boolean()
    .optional()
    .meta({ description: "True if connected to pre-existing Coder workspace" }),
});

export type CoderWorkspaceConfig = z.infer<typeof CoderWorkspaceConfigSchema>;

// Coder CLI availability info
export const CoderInfoSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
});

export type CoderInfo = z.infer<typeof CoderInfoSchema>;

// Coder template
export const CoderTemplateSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  organizationName: z.string(),
});

export type CoderTemplate = z.infer<typeof CoderTemplateSchema>;

// Coder preset for a template
export const CoderPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean(),
});

export type CoderPreset = z.infer<typeof CoderPresetSchema>;

// Coder workspace status
export const CoderWorkspaceStatusSchema = z.enum([
  "running",
  "stopped",
  "starting",
  "stopping",
  "failed",
  "pending",
  "canceling",
  "canceled",
  "deleting",
  "deleted",
]);

export type CoderWorkspaceStatus = z.infer<typeof CoderWorkspaceStatusSchema>;

// Coder workspace
export const CoderWorkspaceSchema = z.object({
  name: z.string(),
  templateName: z.string(),
  status: CoderWorkspaceStatusSchema,
});

export type CoderWorkspace = z.infer<typeof CoderWorkspaceSchema>;

// API schemas for coder namespace
export const coder = {
  getInfo: {
    input: z.void(),
    output: CoderInfoSchema,
  },
  listTemplates: {
    input: z.void(),
    output: z.array(CoderTemplateSchema),
  },
  listPresets: {
    input: z.object({ template: z.string() }),
    output: z.array(CoderPresetSchema),
  },
  listWorkspaces: {
    input: z.void(),
    output: z.array(CoderWorkspaceSchema),
  },
};
