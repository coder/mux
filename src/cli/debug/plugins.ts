import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { WorkspaceCompositionEntry } from "@/common/orpc/schemas/agentPlugins";
import { defaultConfig } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { buildWorkspaceComposition } from "@/node/services/agentPlugins/composition";
import { createAgentPluginsMcpProvider } from "@/node/services/agentPlugins/mcpConfig";
import { readPersistedExperimentEnabled } from "@/node/services/experimentsService";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { isProjectTrusted } from "@/node/utils/projectTrust";

function printEntries(label: string, entries: WorkspaceCompositionEntry[]): void {
  console.log(`${label} (${entries.length}):`);
  for (const entry of entries) {
    const description = entry.description ? ` — ${entry.description}` : "";
    const shadowed = entry.shadowedBy ? `  [shadowed by ${entry.shadowedBy}]` : "";
    console.log(`  - ${entry.name}  (${entry.source})${description}${shadowed}`);
  }
  console.log();
}

/**
 * Composition inspector (the dsh --dump-config analog): print the effective
 * per-workspace composition by layer — every skill/agent/workflow/MCP server/
 * slash command/hook, its source (built-in | global | project | plugin:<name>),
 * and what shadowed what.
 *
 * Runs host-locally against the workspace checkout; plugin discovery and
 * manifest validation work regardless of the agent-plugins experiment, which
 * only gates whether plugin artifacts join the effective layers.
 *
 * Usage: bun run debug plugins <workspace-id>
 */
export async function pluginsCommand(workspaceId: string): Promise<void> {
  const workspace = defaultConfig.findWorkspace(workspaceId);
  if (!workspace) {
    console.error(`Workspace not found: ${workspaceId}`);
    process.exitCode = 1;
    return;
  }

  const workspacePath = workspace.workspacePath;
  const projectTrusted = isProjectTrusted(defaultConfig, workspace.projectPath);
  const agentPluginsEnabled = await readPersistedExperimentEnabled(EXPERIMENT_IDS.AGENT_PLUGINS, {
    muxHome: defaultConfig.rootDir,
  });

  const mcpConfigService = new MCPConfigService(defaultConfig, {
    agentPluginsMcpProvider: createAgentPluginsMcpProvider({
      muxHome: defaultConfig.rootDir,
      isEnabled: () => agentPluginsEnabled,
    }),
  });

  const composition = await buildWorkspaceComposition({
    runtime: new LocalRuntime(workspacePath),
    workspacePath,
    muxHome: defaultConfig.rootDir,
    projectTrusted,
    agentPluginsEnabled,
    listMcpServerLayers: () =>
      mcpConfigService.listServerLayers(workspace.projectPath, projectTrusted, {
        // Same anchors the engine uses for host workspaces: containers scan the
        // checkout root, instance identity keys off the project path.
        agentPlugins: { projectRoot: workspacePath, projectKey: workspace.projectPath },
      }),
  });

  console.log(`\n=== Plugin composition for workspace: ${workspaceId} ===\n`);
  console.log(`workspace path: ${workspacePath}`);
  console.log(`project trusted: ${projectTrusted ? "yes" : "no"}`);
  console.log(
    `agent-plugins experiment: ${composition.agentPluginsEnabled ? "enabled" : "disabled (plugin artifacts are discovered but not loaded)"}`
  );
  console.log();

  console.log(`Plugins (${composition.plugins.length}):`);
  for (const plugin of composition.plugins) {
    const version = plugin.version ? `  v${plugin.version}` : "";
    const components = plugin.components.length > 0 ? plugin.components.join(", ") : "no components";
    console.log(`  - ${plugin.name} (${plugin.scope})${version}  [${components}]`);
    console.log(`      ${plugin.rootPath}`);
  }
  console.log();

  if (composition.diagnostics.length > 0) {
    console.log(`Diagnostics (${composition.diagnostics.length}):`);
    for (const diagnostic of composition.diagnostics) {
      console.log(`  - [${diagnostic.severity}] ${diagnostic.path}: ${diagnostic.message}`);
    }
    console.log();
  }

  printEntries("Skills", composition.skills);
  printEntries("Agents", composition.agents);
  printEntries("Workflows", composition.workflows);
  printEntries("MCP servers", composition.mcpServers);
  printEntries("Slash commands", composition.slashCommands);
  printEntries("Hooks", composition.hooks);
}
