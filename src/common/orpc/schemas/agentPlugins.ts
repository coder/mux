import { z } from "zod";

/**
 * Agent Plugins (agent-plugins.org) oRPC schemas: manifest-contributed slash
 * commands and the per-workspace composition inspector payload.
 */

/** Slash command contributed by an Agent Plugin manifest (`contributes.slashCommands`). */
export const PluginSlashCommandDescriptorSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().optional(),
  /** Replacement text inserted into the composer when the command is invoked. */
  expansion: z.string().min(1),
  pluginName: z.string().min(1),
  scope: z.enum(["project", "global"]),
});
export type PluginSlashCommandDescriptor = z.infer<typeof PluginSlashCommandDescriptorSchema>;

/** One artifact row in the workspace composition (effective or shadowed). */
export const WorkspaceCompositionEntrySchema = z.object({
  name: z.string().min(1),
  /** Layer providing the artifact: built-in | global | project | plugin:<name>. */
  source: z.string().min(1),
  description: z.string().optional(),
  /** Source label of the higher-precedence entry overriding this one (absent = effective). */
  shadowedBy: z.string().optional(),
});
export type WorkspaceCompositionEntry = z.infer<typeof WorkspaceCompositionEntrySchema>;

export const WorkspaceCompositionPluginSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["project", "global"]),
  rootPath: z.string().min(1),
  version: z.string().optional(),
  /** Component kinds the plugin contributes (skills, mcp, agents, workflows, hooks, slashCommands). */
  components: z.array(z.string()),
});
export type WorkspaceCompositionPlugin = z.infer<typeof WorkspaceCompositionPluginSchema>;

export const WorkspaceCompositionDiagnosticSchema = z.object({
  path: z.string(),
  scope: z.enum(["project", "global"]),
  severity: z.enum(["warning", "error"]),
  message: z.string(),
});

/**
 * Effective per-workspace composition by artifact kind — the `--dump-config`
 * analog. One bulk structure so the inspector needs a single oRPC call.
 */
export const WorkspaceCompositionSchema = z.object({
  agentPluginsEnabled: z.boolean(),
  /** Discovered plugins (manifest parsing/validation is NOT experiment-gated). */
  plugins: z.array(WorkspaceCompositionPluginSchema),
  diagnostics: z.array(WorkspaceCompositionDiagnosticSchema),
  skills: z.array(WorkspaceCompositionEntrySchema),
  agents: z.array(WorkspaceCompositionEntrySchema),
  workflows: z.array(WorkspaceCompositionEntrySchema),
  mcpServers: z.array(WorkspaceCompositionEntrySchema),
  slashCommands: z.array(WorkspaceCompositionEntrySchema),
  hooks: z.array(WorkspaceCompositionEntrySchema),
});
export type WorkspaceComposition = z.infer<typeof WorkspaceCompositionSchema>;
