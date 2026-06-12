import { defaultConfig } from "@/node/config";
import { defaultModel } from "@/common/utils/ai/models";
import { getBuiltInAgentDefinitions } from "@/node/services/agentDefinitions/builtInAgentDefinitions";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { MemoryService, type MemoryScopeContext } from "@/node/services/memoryService";
import { runMemoryConsolidation } from "@/node/services/memoryConsolidation";
import { ProviderModelFactory } from "@/node/services/providerModelFactory";
import { ProviderService } from "@/node/services/providerService";

/**
 * Debug command: run a memory-consolidation ("dream") pass for a workspace.
 * Usage: bun debug consolidate-memory <workspace-id> [--dry-run]
 *
 * Phase 1 of issue #3534 — consolidates workspace + global scopes only (both
 * host-local), so no workspace runtime is required. --dry-run prints the
 * proposed op table without touching disk.
 */
export async function consolidateMemoryCommand(
  workspaceId: string,
  options: { dryRun: boolean }
): Promise<void> {
  const workspace = defaultConfig.findWorkspace(workspaceId);
  if (!workspace) {
    console.error(`❌ Workspace not found: ${workspaceId}`);
    process.exitCode = 1;
    return;
  }

  const cfg = defaultConfig.loadConfigOrDefault();
  const workspaceEntry = cfg.projects
    .get(workspace.projectPath)
    ?.workspaces.find((entry) => entry.id === workspaceId);
  // Model cascade (PRD #3534: inherit, uniform with other agents):
  // per-workspace dream override -> global dream default -> workspace session
  // model -> app default. Thinking level is deferred to the phase-2 app path.
  const modelString =
    workspaceEntry?.aiSettingsByAgent?.dream?.model ??
    cfg.agentAiDefaults?.dream?.modelString ??
    workspaceEntry?.aiSettings?.model ??
    defaultModel;

  const dream = getBuiltInAgentDefinitions().find((definition) => definition.id === "dream");
  if (!dream) {
    console.error("❌ Built-in dream agent definition is missing");
    process.exitCode = 1;
    return;
  }

  const providerService = new ProviderService(defaultConfig);
  const modelFactory = new ProviderModelFactory(defaultConfig, providerService);
  const modelResult = await modelFactory.createModel(modelString, undefined, {
    agentInitiated: true,
    workspaceId,
  });
  if (!modelResult.success) {
    console.error(`❌ Could not create model ${modelString}: ${modelResult.error.type}`);
    process.exitCode = 1;
    return;
  }

  const metaService = new MemoryMetaService(defaultConfig.rootDir);
  const memoryService = new MemoryService(defaultConfig, metaService);
  // runtime: null + checkoutCwd: "" structurally disable the project scope —
  // the v1 scope restriction by construction (the runner's guard also rejects
  // project paths explicitly for a clearer model-facing error).
  const ctx: MemoryScopeContext = {
    runtime: null,
    checkoutCwd: "",
    workspaceId,
    projectPath: workspace.projectPath,
  };

  console.log(`\n=== Memory Consolidation (dream) ===\n`);
  console.log(`Workspace: ${workspaceId}`);
  console.log(`Model:     ${modelString}`);
  console.log(`Mode:      ${options.dryRun ? "dry-run (no writes)" : "apply"}\n`);

  const result = await runMemoryConsolidation({
    model: modelResult.data,
    agentBody: dream.body,
    memoryService,
    metaService,
    ctx,
    dryRun: options.dryRun,
  });

  if (result.ops.length === 0) {
    console.log("No mutations proposed.");
  } else {
    for (const op of result.ops) {
      const status = op.applied ? "applied " : "proposed";
      const rename = op.newPath ? ` -> ${op.newPath}` : "";
      console.log(`  [${status}] ${op.command} ${op.path}${rename}`);
      if (op.note && op.note !== "dry-run") console.log(`             ${op.note}`);
    }
  }
  if (result.budgetExhausted) {
    console.log("\n⚠️  Mutation budget exhausted.");
  }
  console.log(`\nSummary: ${result.summary || "(none)"}\n`);
}
